// Command supportd serves the Support service: impersonation, time limited and
// recorded.
//
// The merchant is not asked first, and that is a product decision rather than
// an oversight. Support happens when a merchant has rung up with a broken till,
// and a flow that cannot begin until that same merchant stops talking and
// clicks a button in a dashboard they may not have open is a flow that gets
// worked around.
//
// What is left is what still holds. A session expires on its own, checked on
// every use, so the failure mode is a console tab that stops working rather
// than one that never stops. It is read-only unless somebody asked otherwise.
// It names a person, never a shared account. And it is announced, so the audit
// trail keeps it and the merchant can end a live one whenever they look.
package main

import (
	"context"
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

	pb "github.com/twentyfour/platform/gen/go/twentyfour/support/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/support/internal/store"
)

type server struct {
	pb.UnimplementedSupportServiceServer
	st *store.Store
	// The longest a grant can run for. A request for a month is a request to
	// stop being temporary, and temporary is the whole safeguard.
	maxGrant time.Duration
	// What a request gets when it does not ask for a length.
	defaultGrant time.Duration
}

func fail(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "no such request")
	case errors.Is(err, store.ErrNotUsable):
		return status.Error(codes.PermissionDenied,
			"that access is not available: it was refused, taken back, or has run out")
	}
	slog.Error("support", "err", err)
	return status.Error(codes.Internal, "could not read or write support access")
}

func scopeName(s pb.Scope) string {
	switch s {
	case pb.Scope_SCOPE_READ_ONLY:
		return "read_only"
	case pb.Scope_SCOPE_ACT_ON_BEHALF:
		return "act_on_behalf"
	}
	return ""
}

func scopePB(s string) pb.Scope {
	switch s {
	case "read_only":
		return pb.Scope_SCOPE_READ_ONLY
	case "act_on_behalf":
		return pb.Scope_SCOPE_ACT_ON_BEHALF
	}
	return pb.Scope_SCOPE_UNSPECIFIED
}

func stateName(s pb.RequestState) string {
	switch s {
	case pb.RequestState_REQUEST_STATE_APPROVED:
		return "approved"
	case pb.RequestState_REQUEST_STATE_REVOKED:
		return "revoked"
	case pb.RequestState_REQUEST_STATE_EXPIRED:
		return "expired"
	}
	return ""
}

func statePB(s string) pb.RequestState {
	switch s {
	case "approved":
		return pb.RequestState_REQUEST_STATE_APPROVED
	case "revoked":
		return pb.RequestState_REQUEST_STATE_REVOKED
	case "expired":
		return pb.RequestState_REQUEST_STATE_EXPIRED
	}
	return pb.RequestState_REQUEST_STATE_UNSPECIFIED
}

func requestPB(r store.Request) *pb.AccessRequest {
	out := &pb.AccessRequest{
		Id: r.ID.String(), SpecialistId: r.SpecialistID.String(),
		SpecialistName: r.SpecialistName, Reason: r.Reason,
		Scope: scopePB(r.Scope), State: statePB(r.State),
	}
	// An approved grant whose expiry has passed reads as expired, whether or
	// not the sweeper has been round yet. The screen should never show
	// "approved" for something that no longer works.
	if r.State == "approved" && r.ExpiresAt != nil && !r.ExpiresAt.After(time.Now()) {
		out.State = pb.RequestState_REQUEST_STATE_EXPIRED
	}
	if r.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*r.ExpiresAt)
	}
	return out
}

func sessionPB(s store.Session) *pb.Session {
	out := &pb.Session{
		Id: s.ID.String(), RequestId: s.RequestID.String(),
		SpecialistId: s.SpecialistID.String(), SpecialistName: s.SpecialistName,
		Scope: scopePB(s.Scope), StartedAt: timestamppb.New(s.StartedAt),
		ExpiresAt: timestamppb.New(s.ExpiresAt), Active: s.Active(time.Now()),
	}
	if s.EndedAt != nil {
		out.EndedAt = timestamppb.New(*s.EndedAt)
	}
	return out
}

func (s *server) StartSession(ctx context.Context, req *pb.StartSessionRequest) (*pb.StartSessionResponse, error) {
	// Admin plane only. A merchant impersonating their own business is not a
	// thing, and a merchant impersonating another one is what this check is for.
	if err := tenantctx.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	specialist := tenantctx.User(ctx)
	if specialist == uuid.Nil {
		// A session has to name a person. "Somebody at TwentyFour" is not an
		// answer to who read my books, and it is the answer a shared account
		// gives.
		return nil, status.Error(codes.Unauthenticated, "a session has to belong to a person")
	}
	tenant, err := uuid.Parse(req.GetTenantId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id must be a UUID")
	}
	reason := strings.TrimSpace(req.GetReason())
	if reason == "" {
		// Required, and it is most of what is left. Nobody approves this in
		// advance, so the reason is what makes it reviewable afterwards.
		return nil, status.Error(codes.InvalidArgument,
			"say why: with nobody asked in advance, the reason is the whole record")
	}
	scope := scopeName(req.GetScope())
	if scope == "" {
		// Read-only unless somebody asked otherwise. The safe one is the
		// default, and acting is a separate argument rather than an omission.
		scope = "read_only"
	}

	ttl := s.defaultGrant
	if seconds := req.GetRequestedSeconds(); seconds > 0 {
		asked := time.Duration(seconds) * time.Second
		if asked > s.maxGrant {
			return nil, status.Errorf(codes.InvalidArgument,
				"a session runs for at most %s; longer than that is not temporary", s.maxGrant)
		}
		ttl = asked
	}

	name := strings.TrimSpace(req.GetSpecialistName())
	if name == "" {
		// Falling back to the id is deliberate rather than tidy: an identifier
		// nobody can read is still better than a blank where a name should be.
		name = specialist.String()
	}

	grant, sess, err := s.st.Start(ctx, store.Request{
		TenantID: tenant, SpecialistID: specialist, SpecialistName: name,
		Reason: reason, Scope: scope,
	}, ttl)
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("support session started", "tenant", tenant, "session", sess.ID,
		"specialist", specialist, "scope", scope, "expires", sess.ExpiresAt,
		"reason", reason)
	return &pb.StartSessionResponse{
		Session: sessionPB(sess), Grant: requestPB(grant),
	}, nil
}

func (s *server) RevokeAccess(ctx context.Context, req *pb.RevokeAccessRequest) (*pb.RevokeAccessResponse, error) {
	// Merchant plane. A specialist ending their own session is EndSession; this
	// is the business stopping one. Nothing prompts them to look, and the
	// button costs nothing to keep: "I can stop this" is worth more than a
	// notification nobody reads.
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if id, ok := tenantctx.From(ctx); ok && id.Plane == tenantctx.PlaneAdmin {
		return nil, status.Error(codes.PermissionDenied, "the business decides this, not us")
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	out, ended, err := s.st.Revoke(ctx, tenant, id)
	if errors.Is(err, store.ErrNotFound) {
		// Either it does not exist or it has already ended. Neither is a
		// revocation, and both leave nothing readable, which is what the
		// merchant wanted.
		return nil, status.Error(codes.FailedPrecondition,
			"there is no live access to stop")
	}
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("support access revoked", "tenant", tenant, "request", id,
		"sessions_ended", ended)
	return &pb.RevokeAccessResponse{
		Request: requestPB(out), SessionsEnded: int32(ended),
	}, nil
}

func (s *server) EndSession(ctx context.Context, req *pb.EndSessionRequest) (*pb.EndSessionResponse, error) {
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	current, err := s.st.Session(ctx, id)
	if err != nil {
		return nil, fail(err)
	}
	// Either side may end it. The specialist finishing, or the merchant
	// deciding they have seen enough, and the second is the one that matters.
	out, err := s.st.End(ctx, current.TenantID, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.EndSessionResponse{Session: sessionPB(out)}, nil
}

// CheckSession is asked on every impersonated request.
//
// It re-reads the row rather than trusting anything cached, and it checks the
// clock rather than trusting that somebody ended the session. This is the only
// thing standing between a console tab left open overnight and somebody else's
// books.
func (s *server) CheckSession(ctx context.Context, req *pb.CheckSessionRequest) (*pb.CheckSessionResponse, error) {
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	sess, err := s.st.Session(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return &pb.CheckSessionResponse{Valid: false, Reason: "that session does not exist"}, nil
	}
	if err != nil {
		return nil, fail(err)
	}
	now := time.Now()
	switch {
	case sess.EndedAt != nil:
		return &pb.CheckSessionResponse{
			Valid: false, Session: sessionPB(sess), Reason: "that session has ended",
		}, nil
	case !sess.ExpiresAt.After(now):
		return &pb.CheckSessionResponse{
			Valid: false, Session: sessionPB(sess), Reason: "that access has run out",
		}, nil
	}
	return &pb.CheckSessionResponse{Valid: true, Session: sessionPB(sess)}, nil
}

func (s *server) ListRequests(ctx context.Context, req *pb.ListRequestsRequest) (*pb.ListRequestsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 200 {
		size = 50
	}
	list, err := s.st.ListRequests(ctx, tenant, stateName(req.GetState()), size)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListRequestsResponse{}
	for _, r := range list {
		resp.Requests = append(resp.Requests, requestPB(r))
	}
	return resp, nil
}

func (s *server) ListSessions(ctx context.Context, req *pb.ListSessionsRequest) (*pb.ListSessionsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 200 {
		size = 50
	}
	list, err := s.st.ListSessions(ctx, tenant, req.GetActiveOnly(), size)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListSessionsResponse{}
	for _, sess := range list {
		resp.Sessions = append(resp.Sessions, sessionPB(sess))
	}
	return resp, nil
}

func main() {
	addr := flag.String("addr", ":9117", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	grant := flag.Duration("grant", 4*time.Hour, "how long an approved grant lasts")
	maxGrant := flag.Duration("max-grant", 24*time.Hour, "the longest a grant may last")
	sweep := flag.Duration("sweep-interval", 5*time.Minute,
		"how often expired grants are marked expired")
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
	if *grant > *maxGrant {
		slog.Error("the default grant is longer than the maximum",
			"grant", *grant, "max", *maxGrant)
		os.Exit(1)
	}

	// The sweeper changes nothing about what is permitted: access already stops
	// at the expiry, because every check reads the clock. It exists so a
	// listing says expired instead of approved.
	go func() {
		t := time.NewTicker(*sweep)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if n, err := st.ExpireStale(ctx); err != nil {
					slog.Error("expire stale grants", "err", err)
				} else if n > 0 {
					slog.Info("grants expired", "count", n)
				}
			}
		}
	}()

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterSupportServiceServer(srv, &server{
		st: st, maxGrant: *maxGrant, defaultGrant: *grant,
	})

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		cancel()
		srv.GracefulStop()
	}()

	if err := grpcx.Run(srv, *addr, "support"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
