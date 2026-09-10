// Command auditd serves the Audit service: the plain-language record of what
// the platform did.
//
// It is a consumer first and an API second. Most of the trail is not written by
// anybody calling it: it is written by watching the bus, which is what makes
// the record complete without every service having to remember to file one.
// Record exists for the decisions that have no event, and those are the ones a
// person took by hand.
//
// It subscribes by pattern rather than by list. A trail that only covers the
// topics somebody remembered to add is a trail with holes in exactly the places
// nobody was watching, and this is the one consumer where that trade is worth
// the cost of waking up for everything.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
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

	pb "github.com/twentyfour/platform/gen/go/twentyfour/audit/v1"
	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/audit/internal/store"
)

type server struct {
	pb.UnimplementedAuditServiceServer
	st *store.Store
}

func fail(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return status.Error(codes.NotFound, "no such entry")
	}
	slog.Error("audit", "err", err)
	return status.Error(codes.Internal, "could not read or write the trail")
}

func actorName(k pb.ActorKind) string {
	switch k {
	case pb.ActorKind_ACTOR_KIND_USER:
		return "user"
	case pb.ActorKind_ACTOR_KIND_STAFF:
		return "staff"
	case pb.ActorKind_ACTOR_KIND_SYSTEM:
		return "system"
	case pb.ActorKind_ACTOR_KIND_ANONYMOUS:
		return "anonymous"
	}
	return ""
}

func actorPB(s string) pb.ActorKind {
	switch s {
	case "user":
		return pb.ActorKind_ACTOR_KIND_USER
	case "staff":
		return pb.ActorKind_ACTOR_KIND_STAFF
	case "system":
		return pb.ActorKind_ACTOR_KIND_SYSTEM
	case "anonymous":
		return pb.ActorKind_ACTOR_KIND_ANONYMOUS
	}
	return pb.ActorKind_ACTOR_KIND_UNSPECIFIED
}

func entryPB(e store.Entry) *pb.Entry {
	out := &pb.Entry{
		Id: e.ID.String(), Action: e.Action,
		ActorKind: actorPB(e.ActorKind), ActorId: e.ActorID, ActorLabel: e.ActorLabel,
		SubjectType: e.SubjectType, SubjectId: e.SubjectID,
		Summary: e.Summary, Detail: string(e.Detail), Source: e.Source,
		OccurredAt: timestamppb.New(e.OccurredAt),
	}
	if e.EventID != nil {
		out.EventId = e.EventID.String()
	}
	return out
}

func (s *server) Record(ctx context.Context, req *pb.RecordRequest) (*pb.RecordResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	action := strings.TrimSpace(req.GetAction())
	summary := strings.TrimSpace(req.GetSummary())
	if action == "" || summary == "" {
		// Both, and the summary especially. An entry with no sentence is a log
		// line, and the service already has one of those in its own logs.
		return nil, status.Error(codes.InvalidArgument,
			"an entry needs an action and a sentence describing it")
	}
	kind := actorName(req.GetActorKind())
	if kind == "" {
		return nil, status.Error(codes.InvalidArgument, "an entry needs to say who acted")
	}
	e := store.Entry{
		TenantID: tenant, Action: action, ActorKind: kind,
		ActorID: req.GetActorId(), ActorLabel: req.GetActorLabel(),
		SubjectType: req.GetSubjectType(), SubjectID: req.GetSubjectId(),
		Summary: summary, Source: "api", IdempotencyKey: req.GetIdempotencyKey(),
	}
	if d := req.GetDetail(); d != "" {
		if !json.Valid([]byte(d)) {
			return nil, status.Error(codes.InvalidArgument, "detail must be JSON")
		}
		e.Detail = json.RawMessage(d)
	}
	out, err := s.st.Append(ctx, e)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.RecordResponse{Entry: entryPB(out)}, nil
}

func (s *server) ListEntries(ctx context.Context, req *pb.ListEntriesRequest) (*pb.ListEntriesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 200 {
		size = 50
	}
	f := store.Filter{
		Action: req.GetAction(), ActorKind: actorName(req.GetActorKind()),
		ActorID: req.GetActorId(), Limit: size + 1,
	}
	if t := req.GetFrom(); t.IsValid() {
		at := t.AsTime()
		f.From = &at
	}
	if t := req.GetTo(); t.IsValid() {
		at := t.AsTime()
		f.To = &at
	}
	if tok := req.GetPageToken(); tok != "" {
		at, id, err := decodeToken(tok)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "that page token is not one of ours")
		}
		f.BeforeAt, f.BeforeID = &at, &id
	}
	list, err := s.st.List(ctx, tenant, f)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListEntriesResponse{}
	if len(list) > size {
		last := list[size-1]
		resp.NextPageToken = encodeToken(last.OccurredAt, last.ID)
		list = list[:size]
	}
	for _, e := range list {
		resp.Entries = append(resp.Entries, entryPB(e))
	}
	return resp, nil
}

func (s *server) GetEntry(ctx context.Context, req *pb.GetEntryRequest) (*pb.GetEntryResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	e, err := s.st.Entry(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetEntryResponse{Entry: entryPB(e)}, nil
}

func (s *server) Trail(ctx context.Context, req *pb.TrailRequest) (*pb.TrailResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if req.GetSubjectType() == "" || req.GetSubjectId() == "" {
		return nil, status.Error(codes.InvalidArgument, "a trail is about something in particular")
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 500 {
		size = 200
	}
	list, err := s.st.Trail(ctx, tenant, req.GetSubjectType(), req.GetSubjectId(), size)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.TrailResponse{}
	for _, e := range list {
		resp.Entries = append(resp.Entries, entryPB(e))
	}
	return resp, nil
}

func main() {
	addr := flag.String("addr", ":9114", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	brokers := flag.String("brokers", "kafka:9092", "comma separated Kafka brokers")
	// Every announcement, and nothing else.
	//
	// An announcement is named subject.verb, one dot: "order.placed". Debezium
	// names its topics cdc.pos.public.orders, three dots, because they are a
	// copy of tables rather than a statement that something was decided.
	// Matching on the shape excludes them without a list of exclusions, which
	// matters because the alternative, a negative lookahead, is not in RE2 and
	// the alternative to that is a list of topics that goes stale.
	pattern := flag.String("topics", "^[a-z]+\\.[a-z_]+$",
		"topic pattern this trail records")
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

	recorder := &recorder{st: st}
	consumer, err := bus.NewRegexConsumer(strings.Split(*brokers, ","),
		"audit", []string{*pattern}, recorder.handle)
	if err != nil {
		slog.Error("join the bus", "err", err)
		os.Exit(1)
	}
	defer consumer.Close()
	go func() {
		if err := consumer.Run(ctx); err != nil {
			slog.Error("consume", "err", err)
		}
	}()

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterAuditServiceServer(srv, &server{st: st})

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		cancel()
		time.Sleep(200 * time.Millisecond)
		srv.GracefulStop()
	}()

	if err := grpcx.Run(srv, *addr, "audit"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
