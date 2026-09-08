// Command tenantd serves the Tenant service: what a business is and what it
// holds.
//
// Business identity, trade, hours, tax, currency and locale; the module set and
// the seat quota; and the registry those are resolved from. State, not
// orchestration: Provisioning runs the saga and calls in here to write what it
// has decided.
//
// The entitlement record is the thing the gateway enforces. It is the union of
// three sources and the gateway reads it without caring which is which:
//
//	entitlement = tier module set  ∪  industry profile capabilities  ∪  overrides
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/tenant/internal/registry"
	"github.com/twentyfour/platform/services/tenant/internal/store"
)

type server struct {
	pb.UnimplementedTenantServiceServer
	st   *store.Store
	auth authpb.AuthServiceClient
	// One environment is one market, so one currency, one locale and one
	// timezone. These are flags rather than per-tenant fields resolved at
	// runtime, because a per-tenant country setting is country logic and the
	// architecture does not have any.
	currency, locale, timezone string
}

func fail(err error, what string) error {
	if errors.Is(err, store.ErrNotFound) {
		return status.Errorf(codes.NotFound, "no such %s", what)
	}
	slog.Error("tenant", "what", what, "err", err)
	return status.Errorf(codes.Internal, "could not read or write %s", what)
}

// merchantCode asks Auth, which still holds it.
//
// An RPC rather than a join, deliberately. Auth mints the tenant ID at signup
// and is the only service that knows a tenant exists at that moment, so the
// code lives there for now. When it moves here this call becomes a local read
// and nothing else changes.
func (s *server) merchantCode(ctx context.Context, tenantID uuid.UUID) string {
	resp, err := s.auth.GetMerchantCode(ctx, &authpb.GetMerchantCodeRequest{
		TenantId: tenantID.String(),
	})
	if err != nil {
		slog.Warn("merchant code", "tenant", tenantID, "err", err)
		return ""
	}
	return resp.GetMerchantCode()
}

func profilePB(p store.Profile, code string) *pb.Profile {
	out := &pb.Profile{
		TenantId: p.TenantID.String(), Name: p.Name, Industry: p.Industry,
		Locale: p.Locale, Currency: p.Currency, Timezone: p.Timezone,
		PricesIncludeTax: p.PricesIncludeTax, MerchantCode: code,
		Address: p.Address, City: p.City, TaxId: p.TaxID,
		Status: statusPB(p.Status), CreatedAt: timestamppb.New(p.CreatedAt),
		StatusReason: p.StatusReason,
	}
	for _, r := range p.TaxRates {
		out.TaxRates = append(out.TaxRates, &pb.TaxRate{
			Id: r.ID, Label: r.Label, BasisPoints: r.BasisPoints, IsDefault: r.IsDefault,
		})
	}
	for _, h := range p.Hours {
		hours := &pb.OpeningHours{Day: h.Day, Closed: h.Closed}
		if h.Opens != nil {
			hours.Open = *h.Opens
		}
		if h.Closes != nil {
			hours.Close = *h.Closes
		}
		out.OpeningHours = append(out.OpeningHours, hours)
	}
	return out
}

// The status vocabulary, in one place each way.
//
// Two small maps rather than a string that travels as-is, because the wire type
// is an enum and an unknown string reaching it would arrive as UNSPECIFIED,
// which reads as "no status" rather than "a status nobody recognised".
func statusPB(s string) pb.TenantStatus {
	switch s {
	case "provisioning":
		return pb.TenantStatus_TENANT_STATUS_PROVISIONING
	case "suspended":
		return pb.TenantStatus_TENANT_STATUS_SUSPENDED
	case "trial":
		return pb.TenantStatus_TENANT_STATUS_TRIAL
	default:
		return pb.TenantStatus_TENANT_STATUS_LIVE
	}
}

func statusStr(s pb.TenantStatus) (string, bool) {
	switch s {
	case pb.TenantStatus_TENANT_STATUS_PROVISIONING:
		return "provisioning", true
	case pb.TenantStatus_TENANT_STATUS_LIVE:
		return "live", true
	case pb.TenantStatus_TENANT_STATUS_SUSPENDED:
		return "suspended", true
	case pb.TenantStatus_TENANT_STATUS_TRIAL:
		return "trial", true
	default:
		return "", false
	}
}

func entitlementPB(tier string, grants []store.Grant, seats int32) *pb.Entitlement {
	out := &pb.Entitlement{Tier: tier, SeatLimit: seats}
	for _, g := range grants {
		// Capabilities and modules are both entitlement rows, distinguished by
		// where they came from. The gateway checks one set; the dashboard wants
		// them apart, because a capability never appears in a picker.
		if g.Source == "profile" {
			out.Capabilities = append(out.Capabilities, g.ModuleID)
		} else {
			out.Modules = append(out.Modules, g.ModuleID)
		}
		if g.Pending {
			out.Pending = append(out.Pending, g.ModuleID)
		}
		// The same rows again, carrying why each is held. Only the console
		// reads these; the gateway and the dashboard take the plain lists
		// above, so the hot path does not walk a message to get a string.
		out.Grants = append(out.Grants, &pb.ModuleGrant{
			ModuleId: g.ModuleID, Source: g.Source, Pending: g.Pending,
		})
	}
	return out
}

// ResolveTier answers what a tier and a trade come to, without writing.
//
// Provisioning asks before it starts, so the checklist it builds names the
// modules the tenant is actually getting rather than a guess.
func (s *server) ResolveTier(ctx context.Context, req *pb.ResolveTierRequest) (*pb.ResolveTierResponse, error) {
	tier, ok := registry.TierOf(req.GetTier())
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "there is no %q tier", req.GetTier())
	}
	profile, ok := registry.ProfileOf(req.GetIndustry())
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "there is no %q business type", req.GetIndustry())
	}
	modules := registry.Resolve(tier.Grants)
	return &pb.ResolveTierResponse{
		Modules:         modules,
		Capabilities:    registry.CapabilitiesOf(profile.ID),
		NeedsSpecialist: registry.NeedsSpecialist(modules),
		SeatLimit:       tier.Seats,
		TermFamily:      profile.TermFamily,
		CatalogTemplate: profile.CatalogTemplate,
	}, nil
}

// ApplyTier writes the profile and the resolved entitlement in one transaction.
//
// The tenant ID comes from the request rather than the context, because this is
// called during provisioning when there is no session yet: the tenant exists in
// Auth and nowhere else. Every other RPC here reads the tenant from the context
// like the rest of the platform.
func (s *server) ApplyTier(ctx context.Context, req *pb.ApplyTierRequest) (*pb.ApplyTierResponse, error) {
	tenantID, err := uuid.Parse(req.GetTenantId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id must be a UUID")
	}
	tier, ok := registry.TierOf(req.GetTier())
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "there is no %q tier", req.GetTier())
	}
	profile, ok := registry.ProfileOf(req.GetIndustry())
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "there is no %q business type", req.GetIndustry())
	}
	name := strings.TrimSpace(req.GetBusinessName())
	if name == "" {
		return nil, status.Error(codes.InvalidArgument, "a business needs a name")
	}

	modules := registry.Resolve(tier.Grants)
	queued := map[string]bool{}
	for _, m := range registry.NeedsSpecialist(modules) {
		queued[m] = true
	}

	grants := make([]store.Grant, 0, len(modules))
	for _, m := range modules {
		// Granted, and marked pending when a person has to finish it. Granting
		// nothing until KYC clears would leave a merchant staring at an empty
		// dashboard for days; granting it silently would let them believe they
		// can take money when they cannot.
		grants = append(grants, store.Grant{ModuleID: m, Source: "tier", Pending: queued[m]})
	}
	// The profile's capabilities cost nothing and are chosen by nobody.
	for _, c := range registry.CapabilitiesOf(profile.ID) {
		grants = append(grants, store.Grant{ModuleID: c, Source: "profile"})
	}

	out, held, err := s.st.Apply(ctx, store.Profile{
		TenantID: tenantID, Name: name, Industry: profile.ID,
		TermFamily: profile.TermFamily, Tier: tier.ID,
		Locale: s.locale, Currency: s.currency, Timezone: s.timezone,
		PricesIncludeTax: true,
		TaxRates:         defaultTaxRates(),
		Hours:            store.DefaultHours(),
	}, grants, tier.Seats)
	if err != nil {
		return nil, fail(err, "tenant")
	}

	slog.Info("tier applied", "tenant", tenantID, "tier", tier.ID,
		"industry", profile.ID, "modules", len(modules), "queued", len(queued))
	return &pb.ApplyTierResponse{
		Profile:     profilePB(out, s.merchantCode(ctx, tenantID)),
		Entitlement: entitlementPB(out.Tier, held, tier.Seats),
	}, nil
}

// defaultTaxRates are this market's bands.
//
// They live here rather than in a per-country table because one environment is
// one market: the Hungarian deployment ships Hungarian rates, and a Bangladeshi
// one ships its own. A country column would be the beginning of country logic.
func defaultTaxRates() []store.TaxRate {
	return []store.TaxRate{
		{ID: "standard", Label: "Standard", BasisPoints: 2700, IsDefault: true},
		{ID: "reduced", Label: "Reduced", BasisPoints: 500},
		{ID: "zero", Label: "Zero rated", BasisPoints: 0},
	}
}

func (s *server) GetProfile(ctx context.Context, _ *pb.GetProfileRequest) (*pb.GetProfileResponse, error) {
	tenantID, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	p, err := s.st.Profile(ctx, tenantID)
	if err != nil {
		return nil, fail(err, "business profile")
	}
	return &pb.GetProfileResponse{Profile: profilePB(p, s.merchantCode(ctx, tenantID))}, nil
}

// ListTenants is the admin directory: every tenant in this environment.
//
// The only RPC here that does not scope itself to one tenant, and the only one
// gated on the plane rather than on a tenant header. It cannot go through
// tenantctx.Tenant because there is nothing to put there, which is exactly why
// it is a separate call with its own gate: a tenant argument meaning "all of
// them" would be a cross-tenant read with an explanation attached.
func (s *server) ListTenants(ctx context.Context, req *pb.ListTenantsRequest) (*pb.ListTenantsResponse, error) {
	if err := tenantctx.RequireAdmin(ctx); err != nil {
		return nil, err
	}

	filter := store.Filter{Limit: req.GetLimit(), Tier: req.GetTier()}
	for _, want := range req.GetStatus() {
		name, ok := statusStr(want)
		if !ok {
			return nil, status.Error(codes.InvalidArgument, "unknown tenant status in filter")
		}
		filter.Status = append(filter.Status, name)
	}
	if raw := req.GetCursor(); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "malformed cursor")
		}
		filter.Cursor = parsed
	}

	rows, total, err := s.st.List(ctx, filter)
	if err != nil {
		return nil, fail(err, "tenant directory")
	}

	out := &pb.ListTenantsResponse{Total: total}
	for _, r := range rows {
		out.Tenants = append(out.Tenants, &pb.TenantRow{
			TenantId: r.TenantID.String(), Name: r.Name, Industry: r.Industry,
			Tier: r.Tier, Status: statusPB(r.Status), City: r.City,
			SeatLimit: r.SeatLimit, CreatedAt: timestamppb.New(r.CreatedAt),
		})
	}
	// Only when the page was full. A short page is the last page, and handing
	// back a cursor for it would cost every caller one empty round trip.
	if len(rows) > 0 && int32(len(rows)) == filter.Limit {
		out.NextCursor = rows[len(rows)-1].TenantID.String()
	}
	return out, nil
}

// SetStatus suspends or reinstates a tenant. Admin plane only.
//
// Provisioning is not a status this accepts. It is the saga's to set and the
// saga's to clear, and letting a console write it would mean a tenant could be
// marked as still being set up while nothing was setting it up.
func (s *server) SetStatus(ctx context.Context, req *pb.SetStatusRequest) (*pb.SetStatusResponse, error) {
	if err := tenantctx.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	tenantID, err := uuid.Parse(req.GetTenantId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "malformed tenant id")
	}
	name, ok := statusStr(req.GetStatus())
	if !ok {
		return nil, status.Error(codes.InvalidArgument, "unknown tenant status")
	}
	if name == "provisioning" {
		return nil, status.Error(codes.InvalidArgument,
			"provisioning is set by the saga, not from the console")
	}
	if strings.TrimSpace(req.GetReason()) == "" {
		return nil, status.Error(codes.InvalidArgument, "a reason is required")
	}

	current, err := s.st.Profile(ctx, tenantID)
	if err != nil {
		return nil, fail(err, "business profile")
	}
	// A tenant still being provisioned is mid-saga. Suspending it would leave
	// steps running against an account nobody can reach.
	if current.Status == "provisioning" {
		return nil, status.Error(codes.FailedPrecondition,
			"this tenant is still being set up: finish or cancel the run first")
	}
	if current.Status == name {
		return nil, status.Errorf(codes.FailedPrecondition, "this tenant is already %s", name)
	}

	p, err := s.st.SetStatus(ctx, tenantID, name, strings.TrimSpace(req.GetReason()))
	if err != nil {
		return nil, fail(err, "business profile")
	}
	slog.Info("tenant status changed", "tenant", tenantID, "status", name,
		"actor", req.GetActorId())
	return &pb.SetStatusResponse{Profile: profilePB(p, s.merchantCode(ctx, tenantID))}, nil
}

func (s *server) UpdateProfile(ctx context.Context, req *pb.UpdateProfileRequest) (*pb.UpdateProfileResponse, error) {
	tenantID, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	in := req.GetProfile()
	if in == nil {
		return nil, status.Error(codes.InvalidArgument, "no profile supplied")
	}
	mask := map[string]bool{}
	for _, f := range req.GetUpdateMask() {
		mask[f] = true
	}
	changing := func(field string) bool { return len(mask) == 0 || mask[field] }

	var p store.ProfilePatch
	if changing("name") && strings.TrimSpace(in.GetName()) != "" {
		v := strings.TrimSpace(in.GetName())
		p.Name = &v
	}
	if changing("locale") && in.GetLocale() != "" {
		v := in.GetLocale()
		p.Locale = &v
	}
	if changing("timezone") && in.GetTimezone() != "" {
		v := in.GetTimezone()
		p.Timezone = &v
	}
	if changing("prices_include_tax") {
		v := in.GetPricesIncludeTax()
		p.PricesIncludeTax = &v
	}
	if changing("tax_rates") && len(in.GetTaxRates()) > 0 {
		defaults := 0
		for _, r := range in.GetTaxRates() {
			if r.GetBasisPoints() < 0 || r.GetBasisPoints() > 100_000 {
				return nil, status.Errorf(codes.InvalidArgument, "tax rate %d is out of range", r.GetBasisPoints())
			}
			if r.GetIsDefault() {
				defaults++
			}
			p.TaxRates = append(p.TaxRates, store.TaxRate{
				ID: r.GetId(), Label: r.GetLabel(),
				BasisPoints: r.GetBasisPoints(), IsDefault: r.GetIsDefault(),
			})
		}
		// Exactly one default, because every item created without a rate takes
		// it and "which one" cannot be ambiguous.
		if defaults != 1 {
			return nil, status.Error(codes.InvalidArgument,
				"exactly one tax rate has to be the default")
		}
	}
	if changing("opening_hours") && len(in.GetOpeningHours()) > 0 {
		for _, h := range in.GetOpeningHours() {
			entry := store.Hours{Day: h.GetDay(), Closed: h.GetClosed()}
			if v := h.GetOpen(); v != "" {
				entry.Opens = &v
			}
			if v := h.GetClose(); v != "" {
				entry.Closes = &v
			}
			p.Hours = append(p.Hours, entry)
		}
	}

	out, err := s.st.UpdateProfile(ctx, tenantID, p)
	if err != nil {
		return nil, fail(err, "business profile")
	}
	return &pb.UpdateProfileResponse{Profile: profilePB(out, s.merchantCode(ctx, tenantID))}, nil
}

func (s *server) GetEntitlement(ctx context.Context, _ *pb.GetEntitlementRequest) (*pb.GetEntitlementResponse, error) {
	tenantID, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	p, err := s.st.Profile(ctx, tenantID)
	if err != nil {
		return nil, fail(err, "entitlement")
	}
	held, seats, err := s.st.Entitlement(ctx, tenantID)
	if err != nil {
		return nil, fail(err, "entitlement")
	}
	return &pb.GetEntitlementResponse{Entitlement: entitlementPB(p.Tier, held, seats)}, nil
}

func (s *server) SetModulePending(ctx context.Context, req *pb.SetModulePendingRequest) (*pb.SetModulePendingResponse, error) {
	tenantID, err := uuid.Parse(req.GetTenantId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id must be a UUID")
	}
	if err := s.st.SetPending(ctx, tenantID, req.GetModuleId(), req.GetPending()); err != nil {
		return nil, fail(err, "entitlement")
	}
	p, err := s.st.Profile(ctx, tenantID)
	if err != nil {
		return nil, fail(err, "entitlement")
	}
	held, seats, err := s.st.Entitlement(ctx, tenantID)
	if err != nil {
		return nil, fail(err, "entitlement")
	}
	return &pb.SetModulePendingResponse{Entitlement: entitlementPB(p.Tier, held, seats)}, nil
}

func main() {
	addr := flag.String("addr", ":9109", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	authAddr := flag.String("auth", "auth:9102", "Auth service address")
	currency := flag.String("currency", "HUF", "this market's currency")
	locale := flag.String("locale", "hu-HU", "this market's locale")
	timezone := flag.String("timezone", "Europe/Budapest", "this market's timezone")
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

	authConn, err := grpcx.Dial(*authAddr)
	if err != nil {
		slog.Error("dial auth", "err", err)
		os.Exit(1)
	}
	defer authConn.Close()

	// ApplyTier, SetModulePending and ResolveTier are called during
	// provisioning, before a session exists: the tenant is known to Auth and to
	// nothing else. They carry the tenant explicitly and are exempt from the
	// interceptor for exactly that reason. Every other RPC here is scoped from
	// the context like the rest of the platform.
	srv := grpcx.New(grpcx.Options{Exempt: []string{
		"/twentyfour.tenant.v1.TenantService/ApplyTier",
		"/twentyfour.tenant.v1.TenantService/SetModulePending",
		"/twentyfour.tenant.v1.TenantService/ResolveTier",
	}})
	pb.RegisterTenantServiceServer(srv, &server{
		st: st, auth: authpb.NewAuthServiceClient(authConn),
		currency: *currency, locale: *locale, timezone: *timezone,
	})
	slog.Info("market", "currency", *currency, "locale", *locale, "timezone", *timezone,
		"industries", len(registry.Profiles), "tiers", len(registry.Tiers))

	if err := grpcx.Run(srv, *addr, "tenant"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
