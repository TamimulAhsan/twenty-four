// Command provisioningd runs the provisioning saga and owns the checklist the
// merchant watches it happen on.
//
// It is its own service because a saga is its own kind of thing: steps that run
// in order, fail halfway, retry, and sometimes need a person. That state has to
// survive a crash, be resumable, be inspectable by a specialist and be readable
// by a merchant, and none of those are true of a tenant record, which is simply
// a set of facts.
//
// Provisioning is data, not deployment. Nothing here starts a pod: it writes an
// entitlement record, seeds tenant data from an industry template, and connects
// external accounts. Every service runs once and is shared.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	catalogpb "github.com/twentyfour/platform/gen/go/twentyfour/catalog/v1"
	pospb "github.com/twentyfour/platform/gen/go/twentyfour/pos/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/provisioning/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/provisioning/internal/saga"
	"github.com/twentyfour/platform/services/provisioning/internal/store"
)

type server struct {
	pb.UnimplementedProvisioningServiceServer
	st      *store.Store
	tenant  tenantpb.TenantServiceClient
	catalog catalogpb.CatalogServiceClient
	pos     pospb.PosServiceClient
	// The promise: live within this, or the first month is free.
	sla time.Duration
}

func statusPB(s string) pb.StepStatus {
	switch s {
	case "pending":
		return pb.StepStatus_STEP_STATUS_PENDING
	case "in_progress":
		return pb.StepStatus_STEP_STATUS_IN_PROGRESS
	case "done":
		return pb.StepStatus_STEP_STATUS_DONE
	case "failed":
		return pb.StepStatus_STEP_STATUS_FAILED
	case "awaiting_specialist":
		return pb.StepStatus_STEP_STATUS_AWAITING_SPECIALIST
	}
	return pb.StepStatus_STEP_STATUS_UNSPECIFIED
}

func ownerPB(s string) pb.StepOwner {
	switch s {
	case "platform":
		return pb.StepOwner_STEP_OWNER_PLATFORM
	case "specialist":
		return pb.StepOwner_STEP_OWNER_SPECIALIST
	case "merchant":
		return pb.StepOwner_STEP_OWNER_MERCHANT
	}
	return pb.StepOwner_STEP_OWNER_UNSPECIFIED
}

func runPB(r store.Run) *pb.Run {
	out := &pb.Run{
		TenantId:  r.TenantID.String(),
		StartedAt: timestamppb.New(r.StartedAt),
		DueAt:     timestamppb.New(r.DueAt),
	}
	if r.CompletedAt != nil {
		out.CompletedAt = timestamppb.New(*r.CompletedAt)
	}
	for _, s := range r.Steps {
		step := &pb.Step{
			Id: s.ID, Title: s.Title, Description: s.Description, Hour: s.Hour,
			Status: statusPB(s.Status), Owner: ownerPB(s.Owner), LastError: s.LastError,
		}
		if s.CompletedAt != nil {
			step.CompletedAt = timestamppb.New(*s.CompletedAt)
		}
		out.Steps = append(out.Steps, step)
	}
	return out
}

func fail(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "that business has not been provisioned")
	case errors.Is(err, store.ErrNotYours):
		return status.Error(codes.FailedPrecondition, "that step is not yours to complete")
	}
	slog.Error("provisioning", "err", err)
	return status.Error(codes.Internal, "could not read or run provisioning")
}

// Start begins the saga, or resumes one already begun.
//
// The tenant comes from the request rather than the context, because at this
// point the merchant has an account and nothing else: there is no session yet,
// and the tenant is known to Auth alone. It is the only RPC here that works
// that way.
func (s *server) Start(ctx context.Context, req *pb.StartRequest) (*pb.StartResponse, error) {
	tenantID, err := uuid.Parse(req.GetTenantId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id must be a UUID")
	}
	if strings.TrimSpace(req.GetBusinessName()) == "" {
		return nil, status.Error(codes.InvalidArgument, "a business needs a name")
	}

	// Ask what this tier and trade come to before planning, so the checklist
	// names what the merchant is actually getting rather than a guess. It also
	// validates the tier and the industry: an unknown one fails here, before
	// anything has been written.
	resolved, err := s.tenant.ResolveTier(ctx, &tenantpb.ResolveTierRequest{
		Tier: req.GetTier(), Industry: req.GetIndustry(),
	})
	if err != nil {
		if status.Code(err) == codes.InvalidArgument {
			return nil, err
		}
		slog.Error("resolve tier", "err", err)
		return nil, status.Error(codes.Unavailable, "could not work out what that plan includes")
	}

	steps := saga.Plan(saga.Input{
		Industry: req.GetIndustry(), Tier: req.GetTier(),
		Modules:         resolved.GetModules(),
		Capabilities:    resolved.GetCapabilities(),
		NeedsSpecialist: resolved.GetNeedsSpecialist(),
	})
	planned := make([]store.Step, 0, len(steps))
	for _, st := range steps {
		planned = append(planned, store.Step{
			ID: st.ID, Title: st.Title, Description: st.Description,
			Hour: st.Hour, Owner: string(st.Owner),
		})
	}

	var owner *uuid.UUID
	if id, err := uuid.Parse(req.GetOwnerUserId()); err == nil {
		owner = &id
	}

	run, existed, err := s.st.Begin(ctx, store.Run{
		TenantID: tenantID, OwnerUserID: owner,
		BusinessName: strings.TrimSpace(req.GetBusinessName()),
		Industry:     req.GetIndustry(), Tier: req.GetTier(),
		Steps: planned,
	}, s.sla)
	if err != nil {
		return nil, fail(err)
	}
	if existed {
		slog.Info("resuming provisioning", "tenant", tenantID)
	} else {
		slog.Info("provisioning started", "tenant", tenantID,
			"tier", req.GetTier(), "industry", req.GetIndustry(), "steps", len(planned))
	}

	// Run inline rather than in the background, so the merchant's signup does
	// not return before their account works. Everything HOUR 0 and HOUR 4 is
	// local: a few writes and two seeding calls, not minutes of work.
	return &pb.StartResponse{Run: runPB(s.execute(ctx, run, resolved))}, nil
}

func (s *server) Get(ctx context.Context, _ *pb.GetRequest) (*pb.GetResponse, error) {
	tenantID, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	run, err := s.st.Run(ctx, tenantID)
	if errors.Is(err, store.ErrNotFound) {
		// Not an error. A tenant created before this service existed has no
		// run, and the dashboard renders nothing rather than an error panel.
		return &pb.GetResponse{}, nil
	}
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetResponse{Run: runPB(run)}, nil
}

// RetryStep runs one failed step again.
//
// Platform-owned only. Nothing here can finish a specialist's KYC call or a
// merchant's price review for them, and offering a retry button that silently
// does nothing would be worse than not offering one.
func (s *server) RetryStep(ctx context.Context, req *pb.RetryStepRequest) (*pb.RetryStepResponse, error) {
	tenantID, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	run, err := s.st.Run(ctx, tenantID)
	if err != nil {
		return nil, fail(err)
	}
	var target *store.Step
	for i := range run.Steps {
		if run.Steps[i].ID == req.GetStepId() {
			target = &run.Steps[i]
		}
	}
	if target == nil {
		return nil, status.Error(codes.NotFound, "no such step")
	}
	if target.Owner != "platform" {
		return nil, status.Error(codes.FailedPrecondition,
			"that step is waiting on a person, not on us")
	}
	if target.Status == "done" {
		return &pb.RetryStepResponse{Run: runPB(run)}, nil
	}

	resolved, err := s.tenant.ResolveTier(ctx, &tenantpb.ResolveTierRequest{
		Tier: run.Tier, Industry: run.Industry,
	})
	if err != nil {
		return nil, status.Error(codes.Unavailable, "could not work out what that plan includes")
	}
	// Only the named step: execute skips anything already done, and this one
	// has just been set back to a runnable state by the claim.
	return &pb.RetryStepResponse{Run: runPB(s.execute(ctx, run, resolved))}, nil
}

// CompleteStep is a specialist or the merchant ticking off their own step.
func (s *server) CompleteStep(ctx context.Context, req *pb.CompleteStepRequest) (*pb.CompleteStepResponse, error) {
	tenantID, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.st.CompleteByOwner(ctx, tenantID, req.GetStepId(), "specialist", "merchant"); err != nil {
		return nil, fail(err)
	}
	// A specialist finishing KYC is what makes payments usable, so the
	// entitlement stops being pending at the same moment.
	if req.GetStepId() == "payments_kyc" {
		if _, err := s.tenant.SetModulePending(ctx, &tenantpb.SetModulePendingRequest{
			TenantId: tenantID.String(), ModuleId: "payments", Pending: false,
		}); err != nil {
			slog.Error("clear pending", "tenant", tenantID, "module", "payments", "err", err)
		}
	}
	if req.GetStepId() == "ad_accounts" {
		if _, err := s.tenant.SetModulePending(ctx, &tenantpb.SetModulePendingRequest{
			TenantId: tenantID.String(), ModuleId: "marketing_ads", Pending: false,
		}); err != nil {
			slog.Error("clear pending", "tenant", tenantID, "module", "marketing_ads", "err", err)
		}
	}
	run, err := s.st.Run(ctx, tenantID)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.CompleteStepResponse{Run: runPB(run)}, nil
}

func main() {
	addr := flag.String("addr", ":9110", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	tenantAddr := flag.String("tenant", "tenant:9109", "Tenant service address")
	catalogAddr := flag.String("catalog", "catalog:9103", "Catalog service address")
	posAddr := flag.String("pos", "pos:9108", "POS service address")
	sla := flag.Duration("sla", 24*time.Hour, "the promise: live within this or the first month is free")
	level := flag.String("log-level", "info", "debug, info, warn or error")
	flag.Parse()

	grpcx.SetupLogging(*level)
	ctx := context.Background()

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

	dial := func(target string) *grpc.ClientConn {
		conn, err := grpcx.Dial(target)
		if err != nil {
			slog.Error("dial", "target", target, "err", err)
			os.Exit(1)
		}
		return conn
	}
	tenantConn := dial(*tenantAddr)
	defer tenantConn.Close()
	catalogConn := dial(*catalogAddr)
	defer catalogConn.Close()
	posConn := dial(*posAddr)
	defer posConn.Close()

	// Start carries the tenant explicitly, because it runs before the merchant
	// has a session. Everything else is scoped from the context.
	srv := grpcx.New(grpcx.Options{Exempt: []string{
		"/twentyfour.provisioning.v1.ProvisioningService/Start",
	}})
	pb.RegisterProvisioningServiceServer(srv, &server{
		st:      st,
		tenant:  tenantpb.NewTenantServiceClient(tenantConn),
		catalog: catalogpb.NewCatalogServiceClient(catalogConn),
		pos:     pospb.NewPosServiceClient(posConn),
		sla:     *sla,
	})
	slog.Info("provisioning", "sla", sla.String())

	if err := grpcx.Run(srv, *addr, "provisioning"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
