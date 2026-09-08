// Command admind is the Admin API Gateway.
//
// It is the only thing the admin console talks to, and it is a different door
// from the Tenant Gateway in every way that matters: a different host, a
// different cookie, a different auth realm, and tokens it will not accept from
// the other plane.
//
// It shares the transport conventions with the tenant gateway and nothing else.
// The two never share an auth path, so a merchant token presented here is
// refused by Auth itself rather than by a check this service could forget.
//
// This is the first slice. It does sessions, and nothing beyond them: the
// console's data still comes from its mock until the per-tenant reads land.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	rbacpb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
	staffpb "github.com/twentyfour/platform/gen/go/twentyfour/staff/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/httpx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/packages/websession"
)

// environment is what this deployment is.
//
// One market per deployment, so every field here is a constant of the install
// rather than a parameter of a request. The console displays them and never
// branches on them: a screen that asked whether market is Hungary would mean
// the market-per-deployment rule had already been broken.
// How long a support token lives. Policy, and the console displays it, so it
// is stated here once rather than in both places.
const (
	readTokenTTL  = 30 * time.Minute
	writeTokenTTL = 15 * time.Minute
)

type environment struct {
	Market              string `json:"market"`
	Environment         string `json:"environment"`
	Currency            string `json:"currency"`
	Locale              string `json:"locale"`
	Timezone            string `json:"timezone"`
	Release             string `json:"release"`
	FiscalAuthority     string `json:"fiscalAuthority"`
	GoLiveHours         int    `json:"goLiveHours"`
	AuditRetentionYears int    `json:"auditRetentionYears"`
	ReadTokenMinutes    int    `json:"readTokenMinutes"`
	WriteTokenMinutes   int    `json:"writeTokenMinutes"`
}

// caller is who the request turned out to be, once the token was verified.
//
// There is no tenant on it, and there cannot be: an admin account's tenant is
// the nil UUID. Which tenant a call is about is decided per route, from the
// path, which is what makes "this specialist read that tenant" a thing the
// gateway states rather than a thing it inherits.
type caller struct {
	UserID string
}

type adminGateway struct {
	auth    authpb.AuthServiceClient
	rbac    rbacpb.RBACServiceClient
	tenant  tenantpb.TenantServiceClient
	staff   staffpb.StaffServiceClient
	cookies websession.Manager
	// What this deployment is. Read once and served; never branched on.
	env environment
	// Addresses allowed to reach the console at all. Empty disables the check,
	// which is correct for local development and correct nowhere else.
	allowlist []*net.IPNet
}

func main() {
	addr := flag.String("addr", ":8082", "HTTP listen address")
	authAddr := flag.String("auth", "auth:9102", "Auth service address")
	rbacAddr := flag.String("rbac", "rbac:9101", "RBAC service address")
	tenantAddr := flag.String("tenant", "tenant:9109", "Tenant service address")
	staffAddr := flag.String("staff", "staff:9105", "Staff service address")
	market := flag.String("market", "Hungary", "the market this deployment serves")
	envName := flag.String("environment", "production", "which environment this is")
	currency := flag.String("currency", "HUF", "ISO 4217 code this environment bills in")
	locale := flag.String("locale", "hu-HU", "BCP 47 locale for this market")
	timezone := flag.String("timezone", "Europe/Budapest", "IANA timezone for this market")
	release := flag.String("release", "dev", "the build this deployment is running")
	fiscalAuthority := flag.String("fiscal-authority", "National tax authority",
		"what the market's Invoicing service submits documents to, in that market's own words")
	secure := flag.Bool("secure-cookie", false,
		"set Secure on the admin cookie; must be on outside local development")
	ttl := flag.Duration("session-ttl", 8*time.Hour, "admin session lifetime")
	allowlist := flag.String("ip-allowlist", "",
		"comma-separated CIDRs allowed to reach the console; empty disables the check")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	nets, err := parseAllowlist(*allowlist)
	if err != nil {
		slog.Error("ip-allowlist", "err", err)
		os.Exit(1)
	}
	if len(nets) == 0 {
		slog.Warn("no IP allowlist: every address can reach the admin console. " +
			"This must never run outside local development.")
	}

	dial := func(target string) *grpc.ClientConn {
		conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			slog.Error("dial", "target", target, "err", err)
			os.Exit(1)
		}
		return conn
	}
	authConn := dial(*authAddr)
	defer authConn.Close()
	rbacConn := dial(*rbacAddr)
	defer rbacConn.Close()
	tenantConn := dial(*tenantAddr)
	defer tenantConn.Close()
	staffConn := dial(*staffAddr)
	defer staffConn.Close()

	g := &adminGateway{
		auth:   authpb.NewAuthServiceClient(authConn),
		rbac:   rbacpb.NewRBACServiceClient(rbacConn),
		tenant: tenantpb.NewTenantServiceClient(tenantConn),
		staff:  staffpb.NewStaffServiceClient(staffConn),
		env: environment{
			Market: *market, Environment: *envName, Currency: *currency,
			Locale: *locale, Timezone: *timezone, Release: *release,
			FiscalAuthority: *fiscalAuthority,
			GoLiveHours:     24,
			// Both of these are policy the console displays, so they are read
			// from here rather than restated there. A settings page that says
			// thirty minutes while the gateway issues fifteen is worse than one
			// that says nothing.
			AuditRetentionYears: 7,
			ReadTokenMinutes:    int(readTokenTTL / time.Minute),
			WriteTokenMinutes:   int(writeTokenTTL / time.Minute),
		},
		cookies: websession.Manager{
			Name: websession.AdminCookieName,
			// Host-only, always. Domain is deliberately not configurable here:
			// a parent-domain cookie would put the plane that can see every
			// merchant inside the namespace every merchant application reads.
			Domain: "",
			Secure: *secure,
			TTL:    *ttl,
		},
		allowlist: nets,
	}

	mux := http.NewServeMux()

	// The handoff. The console lands on /session with a one-time code, calls
	// this, and is signed in. The only place an admin cookie is ever set.
	//
	// A POST from the console rather than a redirect this service answers
	// itself. A redirect would keep the code out of JavaScript, which is
	// marginally better, but it would also be a path that only exists in
	// production: the dev server cannot perform it, so development would run a
	// different flow from the one that ships. One path both environments take
	// is worth more than the margin.
	mux.HandleFunc("POST /admin/api/session/exchange", g.exchange)

	mux.HandleFunc("GET /admin/api/auth/session", g.currentSession)
	mux.HandleFunc("DELETE /admin/api/auth/session", g.signOut)

	// What this deployment is. Behind the session, because the market a
	// specialist is looking at is not something to tell an anonymous caller.
	mux.Handle("GET /admin/api/environment", g.authenticated("tenant:profile:read",
		func(w http.ResponseWriter, r *http.Request, _ caller) {
			httpx.JSON(w, r, http.StatusOK, g.env)
		}))

	// The directory is its own permission. Reading one tenant and reading the
	// list of every tenant are different powers, and a role could reasonably
	// hold the first without the second.
	mux.Handle("GET /admin/api/tenants", g.authenticated("tenant:directory:read", g.listTenants))
	mux.Handle("GET /admin/api/tenants/{id}", g.authenticated("tenant:profile:read", g.getTenant))

	// Everything else under /admin/api belongs to a later slice. Answering 501
	// rather than 404 says "not built" rather than "wrong address", which is
	// the difference between a console waiting for work and a console with a
	// typo in it.
	mux.HandleFunc("/admin/api/", func(w http.ResponseWriter, r *http.Request) {
		httpx.Fail(w, r, http.StatusNotImplemented, "not_implemented",
			"The admin gateway does not serve this yet.")
	})

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           httpx.WithRequestID(g.allowed(mux)),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		slog.Info("admin gateway listening", "addr", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	slog.Info("admin gateway stopped")
}

/* ------------------------------------------------------------ the allowlist */

func parseAllowlist(spec string) ([]*net.IPNet, error) {
	var nets []*net.IPNet
	for _, entry := range strings.Split(spec, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		_, block, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, err
		}
		nets = append(nets, block)
	}
	return nets, nil
}

// allowed refuses an address outside the allowlist before anything else runs.
//
// Ahead of authentication on purpose: a valid token from the wrong network is
// exactly the case this exists to stop, and checking it afterwards would mean
// the token had already been verified and logged as a sign-in.
func (g *adminGateway) allowed(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(g.allowlist) == 0 || r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		ip := net.ParseIP(clientIP(r))
		for _, block := range g.allowlist {
			if ip != nil && block.Contains(ip) {
				next.ServeHTTP(w, r)
				return
			}
		}
		slog.Warn("admin console refused", "ip", clientIP(r), "path", r.URL.Path)
		httpx.Fail(w, r, http.StatusForbidden, httpx.CodeForbidden,
			"The admin console is not reachable from this network.")
	})
}

func clientIP(r *http.Request) string {
	// Behind Traefik and the host proxy, so the first hop in the chain is the
	// browser. Trusted because nothing outside the cluster can reach this port.
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if first, _, ok := strings.Cut(fwd, ","); ok {
			return strings.TrimSpace(first)
		}
		return strings.TrimSpace(fwd)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

/* --------------------------------------------------------- authentication */

// handler is a route that has already been authenticated and authorised.
type handler func(w http.ResponseWriter, r *http.Request, c caller)

// authenticated verifies the session, checks one permission, and hands on.
//
// The permission is named at the route rather than inside the handler, so what
// a route requires is readable from the routing table. A handler that forgot to
// check would be a handler with no wrapper, which is visible; a handler that
// checks the wrong thing is not.
func (g *adminGateway) authenticated(permission string, next handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := g.cookies.Token(r)
		if token == "" {
			httpx.Fail(w, r, http.StatusUnauthorized, httpx.CodeUnauthenticated,
				"Sign in to continue.")
			return
		}

		verified, err := g.auth.VerifyToken(r.Context(), &authpb.VerifyTokenRequest{
			Token: token,
			// The audience check, and the reason one sign-in does not become
			// one plane. A merchant's token is cryptographically valid and
			// refused here.
			ExpectedPlane: authpb.Plane_PLANE_ADMIN,
		})
		if err != nil || !verified.GetValid() {
			g.cookies.Clear(w)
			httpx.Fail(w, r, http.StatusUnauthorized, httpx.CodeUnauthenticated,
				"Your session has ended. Sign in again.")
			return
		}

		c := caller{UserID: verified.GetUserId()}
		if !g.may(w, r, c, permission) {
			return
		}
		next(w, r, c)
	})
}

// may asks RBAC, and fails closed.
//
// An admin binding is held against the nil tenant, because a specialist belongs
// to the platform rather than to a business. That is the same nil tenant
// tenantctx refuses for a data query, which is the property worth keeping: the
// identity that authorises a specialist cannot itself reach a tenant's rows.
func (g *adminGateway) may(w http.ResponseWriter, r *http.Request, c caller, permission string) bool {
	subject, err := uuid.Parse(c.UserID)
	if err != nil {
		httpx.Fail(w, r, http.StatusUnauthorized, httpx.CodeUnauthenticated, "Sign in to continue.")
		return false
	}
	resp, err := g.rbac.Check(r.Context(), &rbacpb.CheckRequest{
		TenantId:   uuid.Nil.String(),
		SubjectId:  subject.String(),
		Permission: permission,
		Plane:      rbacpb.Plane_PLANE_ADMIN,
	})
	if err != nil {
		slog.Error("permission check", "err", err, "request_id", httpx.RequestID(r))
		httpx.Fail(w, r, http.StatusServiceUnavailable, httpx.CodeUnavailable,
			"We could not check your permissions. Try again in a moment.")
		return false
	}
	if !resp.GetAllowed() {
		slog.Warn("refused", "user", c.UserID, "permission", permission,
			"request_id", httpx.RequestID(r))
		httpx.Fail(w, r, http.StatusForbidden, httpx.CodeForbidden,
			"Your role does not allow that.")
		return false
	}
	return true
}

// downstream names the tenant a call is about.
//
// This is the whole of what makes the admin plane able to read across tenants,
// and it is deliberately one function: a specialist reads a tenant because this
// gateway put that tenant's id in the headers, not because any service relaxed
// its scoping. Pass uuid.Nil for a call that genuinely has no tenant, and the
// service's own RequireAdmin decides whether that is allowed.
func (g *adminGateway) downstream(r *http.Request, c caller, tenantID uuid.UUID) context.Context {
	return g.outbound(r.Context(), c, tenantID)
}

func (g *adminGateway) outbound(ctx context.Context, c caller, tenantID uuid.UUID) context.Context {
	id := tenantctx.Identity{TenantID: tenantID, Plane: tenantctx.PlaneAdmin}
	if uid, err := uuid.Parse(c.UserID); err == nil {
		id.UserID = uid
	}
	return tenantctx.Outbound(ctx, id)
}

// failGRPC writes the HTTP answer for a failed downstream call, and logs the
// original. The specialist sees a sentence; the internals stay in the log.
func (g *adminGateway) failGRPC(w http.ResponseWriter, r *http.Request, err error) {
	code := statusOf(err)
	if code >= 500 {
		slog.Error("downstream", "err", err, "request_id", httpx.RequestID(r))
	}
	kind, message := httpx.CodeInternal, "Something went wrong on our side."
	switch code {
	case http.StatusNotFound:
		kind, message = httpx.CodeNotFound, "That does not exist."
	case http.StatusForbidden:
		kind, message = httpx.CodeForbidden, "That is not allowed."
	case http.StatusUnauthorized:
		kind, message = httpx.CodeUnauthenticated, "Sign in to continue."
	case http.StatusBadRequest:
		kind, message = httpx.CodeInvalid, status.Convert(err).Message()
	case http.StatusConflict:
		kind, message = httpx.CodeConflict, status.Convert(err).Message()
	}
	httpx.Fail(w, r, code, kind, message)
}

/* --------------------------------------------------------------- the door */

// exchange turns a one-time handoff code into a session on this host.
//
// The code reached the browser in a URL, which is why it is single use and
// lives thirty seconds: a URL is in history, in Referer and in the access log
// of every proxy on the path. The token it stands for never travels that way.
func (g *adminGateway) exchange(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code string `json:"code"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	code := strings.TrimSpace(in.Code)
	if code == "" {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "No sign-in code was given.")
		return
	}

	resp, err := g.auth.RedeemHandoff(r.Context(), &authpb.RedeemHandoffRequest{
		Code:      code,
		Ip:        clientIP(r),
		UserAgent: r.UserAgent(),
	})
	if err != nil {
		// One answer for expired, replayed and never-existed. Telling them
		// apart would say something about a code the caller does not hold.
		slog.Warn("handoff refused", "err", err, "ip", clientIP(r))
		httpx.Fail(w, r, http.StatusUnauthorized, httpx.CodeUnauthenticated,
			"That sign-in link has expired. Sign in again.")
		return
	}

	// Belt and braces. Auth already refuses to hand this gateway a tenant
	// token, so reaching here with one would mean Auth was wrong; refusing
	// anyway costs nothing and means this service never sets a cookie for an
	// account it has not checked itself.
	if resp.GetUser().GetPlane() != authpb.Plane_PLANE_ADMIN {
		slog.Error("handoff returned a non-admin account", "user", resp.GetUser().GetId())
		httpx.Fail(w, r, http.StatusForbidden, httpx.CodeForbidden,
			"That account does not belong on the admin plane.")
		return
	}

	g.cookies.Set(w, resp.GetToken())
	slog.Info("admin session opened", "user", resp.GetUser().GetId(), "ip", clientIP(r))
	httpx.NoContent(w)
}

// sessionBody is the admin console's view of who is signed in.
type sessionBody struct {
	StaffID    string `json:"staffId"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	Role       string `json:"role"`
	MFA        string `json:"mfa"`
	SourceIP   string `json:"sourceIp"`
	SignedInAt string `json:"signedInAt"`
}

// currentSession answers "who am I", and answers null when nobody is.
//
// Null rather than 401, for the same reason the merchant gateway does: arriving
// signed out is the ordinary first load of a console behind SSO, and an error
// would make it look like a fault in the console's own network panel.
func (g *adminGateway) currentSession(w http.ResponseWriter, r *http.Request) {
	token := g.cookies.Token(r)
	if token == "" {
		httpx.JSON(w, r, http.StatusOK, nil)
		return
	}

	verified, err := g.auth.VerifyToken(r.Context(), &authpb.VerifyTokenRequest{
		Token: token,
		// The audience check. A merchant's token is cryptographically valid and
		// still refused here, which is what stops one sign-in from becoming one
		// plane.
		ExpectedPlane: authpb.Plane_PLANE_ADMIN,
	})
	if err != nil || !verified.GetValid() {
		// The cookie is cleared rather than left to rot: a token that will
		// never verify again is a token that makes every subsequent request
		// cost a round trip to be told the same thing.
		g.cookies.Clear(w)
		httpx.JSON(w, r, http.StatusOK, nil)
		return
	}

	user, err := g.auth.GetUser(r.Context(), &authpb.GetUserRequest{
		TenantId: verified.GetTenantId(),
		UserId:   verified.GetUserId(),
	})
	if err != nil {
		httpx.Fail(w, r, statusOf(err), httpx.CodeInternal, "Your account could not be read.")
		return
	}

	role := "specialist"
	if roles, err := g.rbac.GetSubjectRoles(r.Context(), &rbacpb.GetSubjectRolesRequest{
		TenantId: verified.GetTenantId(), SubjectId: verified.GetUserId(),
	}); err == nil && len(roles.GetRoles()) > 0 {
		role = roles.GetRoles()[0].GetKey()
	}

	mfa := "not enrolled"
	if user.GetUser().GetTotpEnrolled() {
		mfa = "authenticator app"
	}

	httpx.JSON(w, r, http.StatusOK, sessionBody{
		StaffID:    user.GetUser().GetId(),
		Email:      user.GetUser().GetEmail(),
		Name:       user.GetUser().GetDisplayName(),
		Role:       role,
		MFA:        mfa,
		SourceIP:   clientIP(r),
		SignedInAt: user.GetUser().GetLastLoginAt().AsTime().Format(time.RFC3339),
	})
}

func (g *adminGateway) signOut(w http.ResponseWriter, r *http.Request) {
	if token := g.cookies.Token(r); token != "" {
		// Revoked server-side as well as cleared. Clearing alone leaves a live
		// token, and on this plane a live token can see every merchant.
		if _, err := g.auth.Logout(r.Context(), &authpb.LogoutRequest{Token: token}); err != nil {
			slog.Warn("admin logout", "err", err, "request_id", httpx.RequestID(r))
		}
	}
	g.cookies.Clear(w)
	httpx.NoContent(w)
}

func statusOf(err error) int {
	switch status.Code(err) {
	case codes.NotFound:
		return http.StatusNotFound
	case codes.PermissionDenied:
		return http.StatusForbidden
	case codes.Unauthenticated:
		return http.StatusUnauthorized
	case codes.InvalidArgument:
		return http.StatusBadRequest
	case codes.FailedPrecondition, codes.AlreadyExists, codes.Aborted:
		return http.StatusConflict
	case codes.Unavailable, codes.DeadlineExceeded:
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}
