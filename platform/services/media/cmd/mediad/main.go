// Command mediad serves the Media service: the only thing in the platform that
// holds object storage credentials.
//
// It does not carry bytes. A caller asks where to put a file and gets a signed
// URL; the browser uploads straight to the store; the caller says it finished.
// The same in reverse for reading. Nothing about a merchant's hundred product
// photographs passes through the API gateway, which is the whole reason the
// service is shaped this way rather than as an upload endpoint.
//
// What follows from that is the interesting constraint: this service never sees
// the file, so everything it enforces it enforces before signing, and the one
// thing it can check afterwards is what the store says it holds.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/twentyfour/platform/gen/go/twentyfour/media/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/media/internal/objects"
	"github.com/twentyfour/platform/services/media/internal/rules"
	"github.com/twentyfour/platform/services/media/internal/store"
)

type server struct {
	pb.UnimplementedMediaServiceServer
	st        *store.Store
	objects   objects.Store
	uploadTTL time.Duration
}

func fail(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return status.Error(codes.NotFound, "no such file")
	}
	slog.Error("media", "err", err)
	return status.Error(codes.Internal, "could not read or write files")
}

// Wire names for the purposes. The database stores the word, so a dump is
// readable without the proto file beside it.
func purposeName(p pb.Purpose) string {
	switch p {
	case pb.Purpose_PURPOSE_CATALOG_IMAGE:
		return "catalog_image"
	case pb.Purpose_PURPOSE_BRAND_LOGO:
		return "brand_logo"
	case pb.Purpose_PURPOSE_SITE_ASSET:
		return "site_asset"
	case pb.Purpose_PURPOSE_ATTACHMENT:
		return "attachment"
	case pb.Purpose_PURPOSE_AD_CREATIVE:
		return "ad_creative"
	}
	return ""
}

func purposePB(s string) pb.Purpose {
	switch s {
	case "catalog_image":
		return pb.Purpose_PURPOSE_CATALOG_IMAGE
	case "brand_logo":
		return pb.Purpose_PURPOSE_BRAND_LOGO
	case "site_asset":
		return pb.Purpose_PURPOSE_SITE_ASSET
	case "attachment":
		return pb.Purpose_PURPOSE_ATTACHMENT
	case "ad_creative":
		return pb.Purpose_PURPOSE_AD_CREATIVE
	}
	return pb.Purpose_PURPOSE_UNSPECIFIED
}

func objectPB(o store.Object) *pb.Object {
	out := &pb.Object{
		Id: o.ID.String(), Purpose: purposePB(o.Purpose), Filename: o.Filename,
		ContentType: o.ContentType, SizeBytes: o.SizeBytes, Ready: o.Ready(),
		SubjectType: o.SubjectType, SubjectId: o.SubjectID,
		CreatedAt: timestamppb.New(o.CreatedAt),
	}
	if o.UploadedBy != nil {
		out.UploadedBy = o.UploadedBy.String()
	}
	if o.ConfirmedAt != nil {
		out.ConfirmedAt = timestamppb.New(*o.ConfirmedAt)
	}
	return out
}

// key is where the bytes go.
//
// Derived, never supplied. It carries the tenant prefix, so a caller that could
// choose its own key could choose another tenant's, and the extension comes
// from the content type rather than the filename, because the filename came
// from a person and can be anything at all.
func key(tenantID uuid.UUID, purpose, contentType string, id uuid.UUID) string {
	return fmt.Sprintf("t/%s/%s/%s%s", tenantID, purpose, id, rules.Extension(contentType))
}

func (s *server) RequestUpload(ctx context.Context, req *pb.RequestUploadRequest) (*pb.RequestUploadResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	purpose := purposeName(req.GetPurpose())
	if purpose == "" {
		return nil, status.Error(codes.InvalidArgument, "say what the file is for")
	}
	if err := rules.Check(purpose, req.GetContentType(), req.GetSizeBytes()); err != nil {
		// The merchant-facing sentence comes from the rules package, which is
		// where the limit that produced it lives.
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}

	id := uuid.New()
	o := store.Object{
		ID: id, TenantID: tenant,
		StorageKey:  key(tenant, purpose, req.GetContentType(), id),
		Purpose:     purpose,
		Filename:    rules.SafeFilename(req.GetFilename()),
		ContentType: req.GetContentType(), SizeBytes: req.GetSizeBytes(),
		SubjectType: req.GetSubjectType(), SubjectID: req.GetSubjectId(),
	}
	if actor := tenantctx.User(ctx); actor != uuid.Nil {
		o.UploadedBy = &actor
	}

	// The row first, then the signature. The other order can hand out a URL for
	// an object nothing has a record of, and an object nothing has a record of
	// is disk nobody will ever find.
	saved, err := s.st.Reserve(ctx, o)
	if err != nil {
		return nil, fail(err)
	}
	url, expires, err := s.objects.SignPut(ctx, saved.StorageKey, saved.ContentType, s.uploadTTL)
	if err != nil {
		slog.Error("sign upload", "err", err, "media", saved.ID)
		return nil, status.Error(codes.Unavailable, "file storage is not answering right now")
	}
	return &pb.RequestUploadResponse{
		Object: objectPB(saved), UploadUrl: url, ExpiresAt: timestamppb.New(expires),
	}, nil
}

func (s *server) ConfirmUpload(ctx context.Context, req *pb.ConfirmUploadRequest) (*pb.ConfirmUploadResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	o, err := s.st.Object(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}

	// Ask the store rather than believe the caller. This is the one check that
	// can be made against reality rather than against a claim, which makes it
	// the only place a lied-about size is caught.
	size, err := s.objects.Stat(ctx, o.StorageKey)
	if err != nil {
		if objects.NotFound(err) {
			return nil, status.Error(codes.FailedPrecondition,
				"that file has not finished uploading")
		}
		slog.Error("stat object", "err", err, "media", id)
		return nil, status.Error(codes.Unavailable, "file storage is not answering right now")
	}
	if r, ok := rules.For(o.Purpose); ok && size > r.MaxBytes {
		// Uploaded, larger than allowed, and now provably so. Removed rather
		// than kept: a rule enforced only when the caller is honest is not a
		// rule.
		if err := s.objects.Delete(ctx, o.StorageKey); err != nil {
			slog.Error("could not remove an oversized upload", "err", err, "media", id)
		}
		if err := s.st.Forget(ctx, id); err != nil {
			slog.Error("could not forget an oversized upload", "err", err, "media", id)
		}
		return nil, status.Error(codes.InvalidArgument,
			"that file turned out to be larger than is allowed here")
	}

	out, err := s.st.Confirm(ctx, tenant, id, size)
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("file confirmed", "tenant", tenant, "media", id,
		"purpose", out.Purpose, "bytes", size)
	return &pb.ConfirmUploadResponse{Object: objectPB(out)}, nil
}

func (s *server) GetDownloadUrl(ctx context.Context, req *pb.GetDownloadUrlRequest) (*pb.GetDownloadUrlResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	o, err := s.st.Object(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	if !o.Ready() {
		// A URL for bytes that are not there would 404 in the browser, which
		// reads as the platform being broken rather than as an upload that was
		// never finished.
		return nil, status.Error(codes.FailedPrecondition, "that file has not finished uploading")
	}
	r, ok := rules.For(o.Purpose)
	if !ok {
		return nil, status.Error(codes.Internal, "that file has a purpose nothing recognises")
	}
	url, expires, err := s.objects.SignGet(ctx, o.StorageKey, o.Filename, r.ReadTTL)
	if err != nil {
		slog.Error("sign download", "err", err, "media", id)
		return nil, status.Error(codes.Unavailable, "file storage is not answering right now")
	}
	return &pb.GetDownloadUrlResponse{Url: url, ExpiresAt: timestamppb.New(expires)}, nil
}

func (s *server) GetObject(ctx context.Context, req *pb.GetObjectRequest) (*pb.GetObjectResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	o, err := s.st.Object(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetObjectResponse{Object: objectPB(o)}, nil
}

func (s *server) ListObjects(ctx context.Context, req *pb.ListObjectsRequest) (*pb.ListObjectsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 500 {
		size = 100
	}
	list, err := s.st.List(ctx, tenant, store.Filter{
		Purpose: purposeName(req.GetPurpose()), SubjectType: req.GetSubjectType(),
		SubjectID: req.GetSubjectId(), IncludePending: req.GetIncludePending(),
		Limit: size,
	})
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListObjectsResponse{}
	for _, o := range list {
		resp.Objects = append(resp.Objects, objectPB(o))
	}
	return resp, nil
}

func (s *server) DeleteObject(ctx context.Context, req *pb.DeleteObjectRequest) (*pb.DeleteObjectResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	// The record first, then the bytes. The other order leaves a record
	// pointing at nothing when the store is unreachable, which is a broken
	// image on a storefront; this order can leave bytes with no record, which
	// is wasted disk the sweeper finds. Wasted disk is the cheaper failure.
	out, err := s.st.Delete(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	if err := s.objects.Delete(ctx, out.StorageKey); err != nil {
		slog.Error("record removed but the file is still in storage",
			"err", err, "media", id, "key", out.StorageKey)
	}
	return &pb.DeleteObjectResponse{Object: objectPB(out)}, nil
}

func main() {
	addr := flag.String("addr", ":9115", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	endpoint := flag.String("endpoint", "minio:9000", "object store, from inside the cluster")
	public := flag.String("public-endpoint", "media.twentyfour.localhost",
		"object store, as a browser reaches it; signatures are made against this")
	publicTLS := flag.Bool("public-tls", false, "whether the public endpoint is HTTPS")
	region := flag.String("region", "us-east-1",
		"region the store verifies signatures against; stated rather than discovered")
	bucket := flag.String("bucket", os.Getenv("MEDIA_BUCKET"), "bucket name")
	uploadTTL := flag.Duration("upload-ttl", 15*time.Minute, "how long an upload URL lives")
	sweepEvery := flag.Duration("sweep-interval", time.Hour, "how often abandoned uploads are swept")
	sweepAfter := flag.Duration("sweep-after", 24*time.Hour,
		"how long a reservation waits before it is treated as abandoned")
	level := flag.String("log-level", "info", "debug, info, warn or error")
	flag.Parse()

	grpcx.SetupLogging(*level)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	st, err := store.Open(ctx, *dsn)
	if err != nil {
		slog.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		slog.Error("migrate", "err", err)
		os.Exit(1)
	}

	if *bucket == "" {
		*bucket = "media"
	}
	obj, err := objects.New(ctx, objects.Config{
		Endpoint:       *endpoint,
		PublicEndpoint: *public,
		PublicUseTLS:   *publicTLS,
		AccessKey:      os.Getenv("MINIO_ACCESS_KEY"),
		SecretKey:      os.Getenv("MINIO_SECRET_KEY"),
		Bucket:         *bucket,
		Region:         *region,
	})
	if err != nil {
		slog.Error("reach object storage", "err", err)
		os.Exit(1)
	}

	sweeper := &sweeper{st: st, objects: obj, every: *sweepEvery, after: *sweepAfter}
	go sweeper.run(ctx)

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterMediaServiceServer(srv, &server{
		st: st, objects: obj, uploadTTL: *uploadTTL,
	})

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		cancel()
		srv.GracefulStop()
	}()

	slog.Info("media ready", "bucket", *bucket, "endpoint", *endpoint,
		"signing_as", strings.TrimSuffix(*public, "/"))
	if err := grpcx.Run(srv, *addr, "media"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
