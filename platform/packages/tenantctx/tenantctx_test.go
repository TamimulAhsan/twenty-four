package tenantctx

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func inbound(pairs ...string) context.Context {
	return metadata.NewIncomingContext(context.Background(), metadata.Pairs(pairs...))
}

func run(t *testing.T, ctx context.Context, method string, exempt ...string) (Identity, bool, error) {
	t.Helper()
	var seen Identity
	var got bool
	_, err := UnaryServerInterceptor(exempt...)(ctx, nil,
		&grpc.UnaryServerInfo{FullMethod: method},
		func(ctx context.Context, _ any) (any, error) {
			seen, got = From(ctx)
			return nil, nil
		})
	return seen, got, err
}

func TestIdentityReachesTheHandler(t *testing.T) {
	tid, uid := uuid.New(), uuid.New()
	ctx := inbound(HeaderTenant, tid.String(), HeaderUser, uid.String(), HeaderPlane, "admin")

	id, ok, err := run(t, ctx, "/twentyfour.catalog.v1.CatalogService/ListItems")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("handler saw no identity")
	}
	if id.TenantID != tid || id.UserID != uid || id.Plane != "admin" {
		t.Fatalf("identity did not survive: %+v", id)
	}
}

// The single most important test in the package: a call with no tenant must not
// reach a handler, because a handler that runs without one queries across every
// tenant or none, and both are wrong.
func TestNoTenantIsRefused(t *testing.T) {
	for _, tc := range []struct {
		name string
		ctx  context.Context
	}{
		{"no metadata at all", context.Background()},
		{"no tenant header", inbound(HeaderUser, uuid.New().String())},
		{"tenant is not a UUID", inbound(HeaderTenant, "acme-corp")},
		{"tenant is the zero UUID", inbound(HeaderTenant, uuid.Nil.String())},
		{"tenant is empty", inbound(HeaderTenant, "")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, ok, err := run(t, tc.ctx, "/twentyfour.catalog.v1.CatalogService/ListItems")
			if ok {
				t.Fatal("handler ran without a tenant")
			}
			if status.Code(err) != codes.Unauthenticated {
				t.Fatalf("want Unauthenticated, got %v (%v)", status.Code(err), err)
			}
		})
	}
}

func TestHealthAndReflectionNeedNoTenant(t *testing.T) {
	for _, m := range []string{
		"/grpc.health.v1.Health/Check",
		"/grpc.health.v1.Health/Watch",
		"/grpc.reflection.v1.ServerReflection/ServerReflectionInfo",
	} {
		if _, _, err := run(t, context.Background(), m); err != nil {
			t.Fatalf("%s was refused: %v", m, err)
		}
	}
}

func TestExemptMethodsAreExactMatches(t *testing.T) {
	const login = "/twentyfour.auth.v1.AuthService/Login"
	if _, _, err := run(t, context.Background(), login, login); err != nil {
		t.Fatalf("exempt method was refused: %v", err)
	}
	// Exemption is per method, not per service: exempting Login must not
	// exempt everything else Auth exposes.
	_, _, err := run(t, context.Background(), "/twentyfour.auth.v1.AuthService/ListUsers", login)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("exemption leaked to a sibling method: %v", err)
	}
}

// A service calling a service must carry the tenant with it, or the second hop
// looks unauthenticated.
func TestOutboundRoundTrips(t *testing.T) {
	want := Identity{TenantID: uuid.New(), UserID: uuid.New(), Plane: "tenant"}
	out, ok := metadata.FromOutgoingContext(Outbound(context.Background(), want))
	if !ok {
		t.Fatal("no outgoing metadata")
	}
	got, ok := parse(out)
	if !ok || got != want {
		t.Fatalf("round trip lost the identity: %+v", got)
	}
}

// A machine caller has a tenant but no person behind it. That is valid, and the
// UserID stays zero rather than becoming a fake one.
func TestMachineCallerHasNoUser(t *testing.T) {
	tid := uuid.New()
	id, ok, err := run(t, inbound(HeaderTenant, tid.String()), "/x/Y")
	if err != nil || !ok {
		t.Fatalf("machine caller was refused: %v", err)
	}
	if id.UserID != uuid.Nil {
		t.Fatalf("invented a user: %v", id.UserID)
	}
	if id.Plane != "tenant" {
		t.Fatalf("plane should default to tenant, got %q", id.Plane)
	}
}

func TestTenantHelperRefusesEmptyContext(t *testing.T) {
	if _, err := Tenant(context.Background()); err == nil {
		t.Fatal("Tenant returned a usable value from an empty context")
	}
	tid := uuid.New()
	got, err := Tenant(With(context.Background(), Identity{TenantID: tid}))
	if err != nil || got != tid {
		t.Fatalf("Tenant lost the id: %v %v", got, err)
	}
}
