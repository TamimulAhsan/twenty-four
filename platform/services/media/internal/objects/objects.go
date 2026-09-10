// Package objects is the object store, behind an interface small enough that
// swapping MinIO for anything else is one file.
//
// It does exactly three things: sign a URL to write, sign a URL to read, and
// delete. It never reads or writes bytes itself, which is what keeps a merchant
// uploading a hundred photographs from putting a hundred photographs through
// the API gateway.
package objects

import (
	"context"
	"fmt"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Store is what Media needs from object storage.
type Store interface {
	// SignPut returns a URL the browser can PUT to, and when it stops working.
	SignPut(ctx context.Context, key, contentType string, ttl time.Duration) (string, time.Time, error)
	// SignGet returns a URL to read, with the filename the browser should save
	// it as.
	SignGet(ctx context.Context, key, filename string, ttl time.Duration) (string, time.Time, error)
	Delete(ctx context.Context, key string) error
	// Stat reports the size the store actually holds, which is the only honest
	// answer to "did the upload finish and how big is it": the size a caller
	// declared before uploading is a claim.
	Stat(ctx context.Context, key string) (int64, error)
}

// MinIO is the S3-compatible implementation.
type MinIO struct {
	// client addresses the store from inside the cluster, for Stat and Delete.
	client *minio.Client
	// signer addresses it by the hostname a browser will use.
	//
	// Two clients rather than one because a signed URL is signed for a host:
	// the host is inside the signature, so a URL signed against the in-cluster
	// service name verifies only from inside the cluster, which is precisely
	// where nobody needs it.
	signer *minio.Client
	bucket string
}

// Config is how to reach the store.
type Config struct {
	// Endpoint is the in-cluster address, host and port, no scheme.
	Endpoint string
	// PublicEndpoint is the address a browser will use. Signatures are made
	// against this one.
	PublicEndpoint string
	AccessKey      string
	SecretKey      string
	Bucket         string
	UseTLS         bool
	PublicUseTLS   bool
	// Region the store reports. MinIO answers us-east-1 unless it has been told
	// otherwise, and it has to match what the store will verify against.
	Region string
}

func New(ctx context.Context, cfg Config) (*MinIO, error) {
	creds := credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, "")
	client, err := minio.New(cfg.Endpoint,
		&minio.Options{Creds: creds, Secure: cfg.UseTLS, Region: cfg.Region})
	if err != nil {
		return nil, fmt.Errorf("objects: client: %w", err)
	}
	signer := client
	if cfg.PublicEndpoint != "" && cfg.PublicEndpoint != cfg.Endpoint {
		signer, err = minio.New(cfg.PublicEndpoint, &minio.Options{
			Creds: creds, Secure: cfg.PublicUseTLS,
			// The region has to be stated rather than discovered. A signature
			// covers the region, so the client looks it up on first use by
			// asking the endpoint, and this endpoint is the name a browser
			// resolves and this pod cannot: media.twentyfour.localhost is
			// 127.0.0.1 in a browser and nothing at all in the cluster.
			//
			// Stating it makes presigning a pure computation, with no network
			// call at all, which is what it should have been anyway: signing a
			// URL is arithmetic over a key and a secret.
			Region: cfg.Region,
		})
		if err != nil {
			return nil, fmt.Errorf("objects: signing client: %w", err)
		}
	}

	m := &MinIO{client: client, signer: signer, bucket: cfg.Bucket}
	// Created here rather than by a provisioning step, because the bucket is
	// the market's and not a tenant's: one bucket for the whole deployment, and
	// a service that cannot start without it should be the thing that makes it.
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	if err != nil {
		return nil, fmt.Errorf("objects: reach the store: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("objects: create bucket: %w", err)
		}
	}
	return m, nil
}

func (m *MinIO) SignPut(ctx context.Context, key, contentType string, ttl time.Duration) (string, time.Time, error) {
	// PresignedPutObject signs the method, the key and the expiry. It does not
	// bind the content type or the length, so what the browser declares on the
	// PUT is what the store records. That is a real limitation of a presigned
	// PUT rather than something to paper over: the size and type checks that
	// matter happen again at Confirm, against what the store actually holds.
	u, err := m.signer.PresignedPutObject(ctx, m.bucket, key, ttl)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("objects: sign put: %w", err)
	}
	return u.String(), time.Now().Add(ttl), nil
}

func (m *MinIO) SignGet(ctx context.Context, key, filename string, ttl time.Duration) (string, time.Time, error) {
	params := url.Values{}
	if filename != "" {
		// The name the browser saves it as. The key is opaque, so without this
		// every download is called by a UUID.
		params.Set("response-content-disposition",
			fmt.Sprintf("attachment; filename=%q", filename))
	}
	u, err := m.signer.PresignedGetObject(ctx, m.bucket, key, ttl, params)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("objects: sign get: %w", err)
	}
	return u.String(), time.Now().Add(ttl), nil
}

func (m *MinIO) Delete(ctx context.Context, key string) error {
	if err := m.client.RemoveObject(ctx, m.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("objects: delete: %w", err)
	}
	return nil
}

func (m *MinIO) Stat(ctx context.Context, key string) (int64, error) {
	info, err := m.client.StatObject(ctx, m.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return 0, err
	}
	return info.Size, nil
}

// NotFound reports whether an error from the store means the object is not
// there, as distinct from the store being unreachable. Confirming an upload
// that never happened and failing to reach the store are different answers.
func NotFound(err error) bool {
	return minio.ToErrorResponse(err).Code == "NoSuchKey"
}
