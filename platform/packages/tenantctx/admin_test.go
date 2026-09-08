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

// The cross-tenant gate. These are the calls that genuinely have no tenant, so
// the thing that must hold is that they are reachable from the admin plane and
// from nowhere else.
func TestRequireAdmin(t *testing.T) {
	cases := []struct {
		name string
		ctx  context.Context
		want codes.Code
	}{
		{
			name: "an admin caller passes",
			ctx:  With(context.Background(), Identity{Plane: PlaneAdmin}),
			want: codes.OK,
		},
		{
			// The important one. A merchant's token is perfectly valid; it is
			// simply not the plane this call belongs to.
			name: "a merchant is refused even with a tenant",
			ctx:  With(context.Background(), Identity{TenantID: uuid.New(), Plane: PlaneTenant}),
			want: codes.PermissionDenied,
		},
		{
			name: "no identity at all is refused",
			ctx:  context.Background(),
			want: codes.PermissionDenied,
		},
		{
			// An empty plane is what a header the gateway forgot to set looks
			// like. Refusing it is what stops a missing header reading as
			// permission.
			name: "an unset plane is refused",
			ctx:  With(context.Background(), Identity{TenantID: uuid.New()}),
			want: codes.PermissionDenied,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := status.Code(RequireAdmin(c.ctx)); got != c.want {
				t.Fatalf("RequireAdmin: got %v, want %v", got, c.want)
			}
		})
	}
}

// An admin identity carries no tenant, so a tenant-scoped query made with one
// must fail rather than run unscoped. This is what makes an admin token safe to
// hand to a service: it cannot reach a tenant query by accident, only through a
// gateway that names a tenant explicitly.
func TestAdminIdentityHasNoTenant(t *testing.T) {
	ctx := With(context.Background(), Identity{Plane: PlaneAdmin})
	if _, err := Tenant(ctx); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("Tenant with an admin identity: got %v, want Unauthenticated", err)
	}
}

// Through the interceptor, not around it.
//
// The tests above build a context with With(), which is how a handler test
// reaches a handler and is not how a request arrives. That gap hid a real one:
// RequireAdmin was unreachable in a running cluster, because the interceptor
// refused a call with no tenant before any handler ran, so every cross-tenant
// RPC answered "no tenant in request context" whichever plane asked.
//
// So these drive the interceptor with the metadata a gateway actually sends.
func TestInterceptorIdentity(t *testing.T) {
	tenantID := uuid.New()
	userID := uuid.New()

	cases := []struct {
		name  string
		md    metadata.MD
		want  codes.Code
		check func(t *testing.T, ctx context.Context)
	}{
		{
			name: "a merchant call carries its tenant",
			md: metadata.Pairs(
				HeaderTenant, tenantID.String(),
				HeaderUser, userID.String(),
				HeaderPlane, PlaneTenant,
			),
			want: codes.OK,
			check: func(t *testing.T, ctx context.Context) {
				if got, err := Tenant(ctx); err != nil || got != tenantID {
					t.Fatalf("Tenant: got %v %v, want %v", got, err, tenantID)
				}
				if RequireAdmin(ctx) == nil {
					t.Fatal("RequireAdmin allowed a merchant")
				}
			},
		},
		{
			// The case that was broken. A specialist asking for the directory
			// has no tenant to name, and the call has to reach the handler so
			// RequireAdmin can be the thing that decides.
			name: "an admin call with no tenant reaches the handler",
			md:   metadata.Pairs(HeaderUser, userID.String(), HeaderPlane, PlaneAdmin),
			want: codes.OK,
			check: func(t *testing.T, ctx context.Context) {
				if err := RequireAdmin(ctx); err != nil {
					t.Fatalf("RequireAdmin refused a specialist: %v", err)
				}
				// And it still cannot reach a tenant query. This is the half
				// that makes letting it through safe.
				if _, err := Tenant(ctx); status.Code(err) != codes.Unauthenticated {
					t.Fatalf("Tenant with an admin identity: got %v, want Unauthenticated", err)
				}
			},
		},
		{
			name: "an admin call about one tenant carries it",
			md: metadata.Pairs(
				HeaderTenant, tenantID.String(),
				HeaderUser, userID.String(),
				HeaderPlane, PlaneAdmin,
			),
			want: codes.OK,
			check: func(t *testing.T, ctx context.Context) {
				if got, err := Tenant(ctx); err != nil || got != tenantID {
					t.Fatalf("Tenant: got %v %v, want %v", got, err, tenantID)
				}
			},
		},
		{
			// Unchanged, and the reason the whole package exists: a merchant
			// call with no tenant is refused before it can query anything.
			name: "a merchant call with no tenant is refused",
			md:   metadata.Pairs(HeaderUser, userID.String(), HeaderPlane, PlaneTenant),
			want: codes.Unauthenticated,
		},
		{
			name: "a call with no headers at all is refused",
			md:   metadata.MD{},
			want: codes.Unauthenticated,
		},
		{
			// Guessing would be worse than refusing, on either plane.
			name: "a malformed tenant is refused even from the admin plane",
			md:   metadata.Pairs(HeaderTenant, "not-a-uuid", HeaderPlane, PlaneAdmin),
			want: codes.Unauthenticated,
		},
	}

	interceptor := UnaryServerInterceptor()
	info := &grpc.UnaryServerInfo{FullMethod: "/twentyfour.tenant.v1.TenantService/ListTenants"}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reached := false
			var inner context.Context
			handler := func(ctx context.Context, _ any) (any, error) {
				reached = true
				inner = ctx
				return nil, nil
			}

			ctx := metadata.NewIncomingContext(context.Background(), c.md)
			_, err := interceptor(ctx, nil, info, handler)

			if got := status.Code(err); got != c.want {
				t.Fatalf("interceptor: got %v, want %v", got, c.want)
			}
			if c.want != codes.OK {
				if reached {
					t.Fatal("a refused call reached the handler")
				}
				return
			}
			if !reached {
				t.Fatal("an allowed call did not reach the handler")
			}
			if c.check != nil {
				c.check(t, inner)
			}
		})
	}
}

// A nil tenant never reaches a handler on the merchant plane, so it can never
// reach a WHERE clause. Kept separate because it is the property the package's
// own docblock promises.
func TestNilTenantNeverReachesAMerchantHandler(t *testing.T) {
	interceptor := UnaryServerInterceptor()
	info := &grpc.UnaryServerInfo{FullMethod: "/twentyfour.catalog.v1.CatalogService/ListItems"}
	ctx := metadata.NewIncomingContext(context.Background(),
		metadata.Pairs(HeaderTenant, uuid.Nil.String()))

	_, err := interceptor(ctx, nil, info, func(context.Context, any) (any, error) {
		t.Fatal("a nil tenant reached the handler")
		return nil, nil
	})
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("got %v, want Unauthenticated", err)
	}
}
