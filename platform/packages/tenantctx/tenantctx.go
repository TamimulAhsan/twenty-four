// Package tenantctx carries the caller's identity from the gateway into a
// service, and refuses any request that does not have one.
//
// Domain services do not authenticate. The gateway verified the token, resolved
// the tenant and checked the permission before anything downstream saw the
// request; a service's job is only to trust that work and scope its queries to
// the tenant it was told about. Network policy is what makes that safe: nothing
// outside the cluster can reach these ports.
//
// The reason this is a package rather than four lines in each service is that
// those four lines are the whole of the tenant boundary. Nine services writing
// their own version is nine chances to read the tenant out of a request body,
// and a tenant ID a client can set is a tenant ID a client can change.
package tenantctx

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// Metadata keys. gRPC lowercases header names on the wire, so these are the
// exact strings that appear in the metadata map.
const (
	HeaderTenant = "x-tenant-id"
	HeaderUser   = "x-user-id"
	HeaderPlane  = "x-plane"
)

// The two planes, spelled once. A service comparing against a string literal is
// a service one typo away from a check that silently never matches.
const (
	PlaneTenant = "tenant"
	PlaneAdmin  = "admin"
)

// Identity is who the gateway says is calling. It is never derived from the
// request body.
type Identity struct {
	TenantID uuid.UUID
	// Zero for a machine caller: the outbox relay and the scheduler act on a
	// tenant's data with no person behind the request.
	UserID uuid.UUID
	// PlaneTenant or PlaneAdmin. Two planes that never share an auth path, so a
	// service that cares which one it is serving asks here.
	Plane string
}

type ctxKey struct{}

// ErrNoTenant is returned by Tenant when the context carries no identity.
var errNoTenant = status.Error(codes.Unauthenticated, "no tenant in request context")

// errNotAdmin is returned by RequireAdmin. PermissionDenied rather than
// Unauthenticated: the caller is authenticated, and is simply not the plane
// this call belongs to.
var errNotAdmin = status.Error(codes.PermissionDenied, "this call is admin-plane only")

// With attaches an identity. Used by the interceptor, and by tests that call a
// handler directly.
func With(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// From returns the identity, and whether there was one.
func From(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(ctxKey{}).(Identity)
	return id, ok
}

// Tenant is the call every query makes. It returns an error rather than a zero
// UUID on purpose: a zero tenant that reaches a WHERE clause matches nothing,
// which looks like an empty account rather than the bug it is.
func Tenant(ctx context.Context) (uuid.UUID, error) {
	id, ok := From(ctx)
	if !ok || id.TenantID == uuid.Nil {
		return uuid.Nil, errNoTenant
	}
	return id.TenantID, nil
}

// RequireAdmin is Tenant's counterpart for a call that has no tenant.
//
// The directory, the provisioning queue, the tier registry: these are the
// handful of RPCs that genuinely operate across every tenant in the
// environment, and they cannot go through Tenant because there is nothing to
// put in the header.
//
// The temptation is to let those calls pass a wildcard or a sentinel tenant.
// Both are the same mistake: a tenant that matches everything is a cross-tenant
// read with a plausible explanation attached, and it would be indistinguishable
// from a bug in a caller. So they get their own gate instead, and it checks the
// one thing that is actually true of them, which is that only the admin plane
// may make them.
//
// Written once here for the same reason Tenant is: nine services writing their
// own version is nine chances to check the wrong thing.
func RequireAdmin(ctx context.Context) error {
	id, ok := From(ctx)
	if !ok || id.Plane != PlaneAdmin {
		return errNotAdmin
	}
	return nil
}

// User returns the acting user, which may legitimately be zero.
func User(ctx context.Context) uuid.UUID {
	id, _ := From(ctx)
	return id.UserID
}

// parse reads an identity out of inbound metadata. A malformed tenant is
// treated as no tenant: guessing would be worse than refusing.
func parse(md metadata.MD) (Identity, bool) {
	first := func(k string) string {
		if v := md.Get(k); len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}
	plane := first(HeaderPlane)
	if plane == "" {
		plane = PlaneTenant
	}

	// Absent and malformed are different answers, and only one of them is
	// allowed anywhere. A header nobody set is a call that has no tenant; a
	// header somebody set to nonsense is a bug or an attempt, and reading it as
	// "no tenant" would turn either into a request for every tenant.
	raw := first(HeaderTenant)
	var tid uuid.UUID
	if raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			return Identity{}, false
		}
		tid = parsed
	}

	if tid == uuid.Nil && plane != PlaneAdmin {
		return Identity{}, false
	}
	// Past here a nil tenant means an admin call that genuinely has no tenant:
	// the directory, the provisioning queue, the tier registry. The identity is
	// still attached, because the alternative is attaching nothing and leaving
	// RequireAdmin with no plane to check.
	//
	// This is not a way past the tenant boundary. Tenant() refuses a nil tenant,
	// so every tenant-scoped query still fails exactly as it did; what changes
	// is that the handful of RPCs which have no tenant can say so, and be
	// checked on the plane instead.

	id := Identity{TenantID: tid, Plane: plane}
	if uid, err := uuid.Parse(first(HeaderUser)); err == nil {
		id.UserID = uid
	}
	return id, true
}

// alwaysExempt are the methods that exist before a caller has a tenant at all.
// Kubernetes probes the health service, and grpcurl reflects, and neither is
// carrying a session.
func alwaysExempt(method string) bool {
	return strings.HasPrefix(method, "/grpc.health.v1.Health/") ||
		strings.HasPrefix(method, "/grpc.reflection.")
}

// UnaryServerInterceptor rejects any call that arrives without a tenant, and
// puts the identity on the context for everything that does.
//
// exempt lists full method names ("/twentyfour.auth.v1.AuthService/Login") that
// genuinely have no tenant yet. Keep that list short and keep it here, where it
// can be read in one place, rather than letting each handler decide for itself.
func UnaryServerInterceptor(exempt ...string) grpc.UnaryServerInterceptor {
	skip := make(map[string]bool, len(exempt))
	for _, m := range exempt {
		skip[m] = true
	}
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
		if alwaysExempt(info.FullMethod) || skip[info.FullMethod] {
			return h(ctx, req)
		}
		md, _ := metadata.FromIncomingContext(ctx)
		id, ok := parse(md)
		if !ok {
			return nil, errNoTenant
		}
		return h(With(ctx, id), req)
	}
}

// UnaryClientInterceptor forwards the identity on outbound calls, so a service
// calling another service does not silently drop the tenant. Without it the
// second hop looks like an unauthenticated request and is refused, which is the
// right failure but an obscure one to debug.
func UnaryClientInterceptor() grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any,
		cc *grpc.ClientConn, invoke grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		if id, ok := From(ctx); ok {
			ctx = Outbound(ctx, id)
		}
		return invoke(ctx, method, req, reply, cc, opts...)
	}
}

// Outbound writes an identity into outgoing metadata. The gateway uses this
// directly, because it holds the identity in its own form rather than in a
// context this package populated.
func Outbound(ctx context.Context, id Identity) context.Context {
	pairs := []string{HeaderTenant, id.TenantID.String()}
	if id.UserID != uuid.Nil {
		pairs = append(pairs, HeaderUser, id.UserID.String())
	}
	if id.Plane != "" {
		pairs = append(pairs, HeaderPlane, id.Plane)
	}
	return metadata.AppendToOutgoingContext(ctx, pairs...)
}
