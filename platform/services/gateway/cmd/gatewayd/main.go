// Command gatewayd is the Tenant API Gateway.
//
// It is the only thing a merchant's browser talks to. Every request is
// authenticated, tenant-resolved and permission-checked here, once, before
// anything downstream sees it. Domain services never decide who is calling:
// they receive an already-authorised request and trust the headers on it,
// because network policy means nothing else can reach them.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
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

	analyticspb "github.com/twentyfour/platform/gen/go/twentyfour/analytics/v1"
	auditpb "github.com/twentyfour/platform/gen/go/twentyfour/audit/v1"
	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	bookingspb "github.com/twentyfour/platform/gen/go/twentyfour/bookings/v1"
	catalogpb "github.com/twentyfour/platform/gen/go/twentyfour/catalog/v1"
	inventorypb "github.com/twentyfour/platform/gen/go/twentyfour/inventory/v1"
	invoicingpb "github.com/twentyfour/platform/gen/go/twentyfour/invoicing/v1"
	kitchenpb "github.com/twentyfour/platform/gen/go/twentyfour/kitchen/v1"
	ledgerpb "github.com/twentyfour/platform/gen/go/twentyfour/ledger/v1"
	mediapb "github.com/twentyfour/platform/gen/go/twentyfour/media/v1"
	notificationpb "github.com/twentyfour/platform/gen/go/twentyfour/notification/v1"
	paymentspb "github.com/twentyfour/platform/gen/go/twentyfour/payments/v1"
	pospb "github.com/twentyfour/platform/gen/go/twentyfour/pos/v1"
	provpb "github.com/twentyfour/platform/gen/go/twentyfour/provisioning/v1"
	rbacpb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
	staffpb "github.com/twentyfour/platform/gen/go/twentyfour/staff/v1"
	supportpb "github.com/twentyfour/platform/gen/go/twentyfour/support/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/httpx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/packages/websession"
)

type gateway struct {
	auth         authpb.AuthServiceClient
	rbac         rbacpb.RBACServiceClient
	catalog      catalogpb.CatalogServiceClient
	staff        staffpb.StaffServiceClient
	inventory    inventorypb.InventoryServiceClient
	payments     paymentspb.PaymentsServiceClient
	pos          pospb.PosServiceClient
	tenant       tenantpb.TenantServiceClient
	provisioning provpb.ProvisioningServiceClient
	analytics    analyticspb.AnalyticsServiceClient
	notification notificationpb.NotificationServiceClient
	audit        auditpb.AuditServiceClient
	media        mediapb.MediaServiceClient
	ledger       ledgerpb.LedgerServiceClient
	support      supportpb.SupportServiceClient
	invoicing    invoicingpb.InvoicingServiceClient
	bookings     bookingspb.BookingsServiceClient
	kitchen      kitchenpb.KitchenServiceClient
	cookies      websession.Manager
	// Where a specialist is sent when they sign in here. Its own host, because
	// the admin plane is not inside the merchant cookie's namespace.
	adminURL string
	// This deployment's currency. One market, one currency: it is on every
	// service's command line already, and the gateway needs it to wrap the
	// bare integers the dashboard sends into the Money every service expects.
	currency string
	// The merchant origin, used to build links that go into messages. Held as
	// configuration rather than read off the request, because the request that
	// creates an invitation is not the one that follows the link, and a Host
	// header is something a caller can set.
	appURL string
	// permissive turns every RBAC denial into an allow, so the whole dashboard
	// can be walked through before the services behind it exist. It is a
	// development switch: it must never be set anywhere a real merchant's data
	// lives, because it removes the only check that keeps one role out of
	// another's screens.
	permissive bool
}

// caller is who the request turned out to be, once the token was verified.
type caller struct {
	UserID   string
	TenantID string
	Plane    string
}

func main() {
	addr := flag.String("addr", ":8081", "HTTP listen address")
	authAddr := flag.String("auth", "auth:9102", "Auth service address")
	rbacAddr := flag.String("rbac", "rbac:9101", "RBAC service address")
	catalogAddr := flag.String("catalog", "catalog:9103", "Catalog service address")
	inventoryAddr := flag.String("inventory", "inventory:9104", "Inventory service address")
	staffAddr := flag.String("staff", "staff:9105", "Staff service address")
	paymentsAddr := flag.String("payments", "payments:9106", "Payments service address")
	posAddr := flag.String("pos", "pos:9108", "POS service address")
	tenantAddr := flag.String("tenant", "tenant:9109", "Tenant service address")
	provAddr := flag.String("provisioning", "provisioning:9110", "Provisioning service address")
	analyticsAddr := flag.String("analytics", "analytics:9111", "Analytics service address")
	notificationAddr := flag.String("notification", "notification:9112", "Notification service address")
	auditAddr := flag.String("audit", "audit:9114", "Audit service address")
	mediaAddr := flag.String("media", "media:9115", "Media service address")
	ledgerAddr := flag.String("ledger", "ledger:9118", "Ledger service address")
	supportAddr := flag.String("support", "support:9117", "Support service address")
	invoicingAddr := flag.String("invoicing", "invoicing:9119", "Invoicing service address")
	bookingsAddr := flag.String("bookings", "bookings:9120", "Bookings service address")
	kitchenAddr := flag.String("kitchen", "kitchen:9121", "Kitchen service address")
	currency := flag.String("currency", "HUF", "this market's currency")
	adminURL := flag.String("admin-url", "http://admin.twentyfour.localhost",
		"origin of the admin console, where a specialist signing in here is sent")
	appURL := flag.String("app-url", "http://app.twentyfour.localhost",
		"merchant origin, used to build the links that go into messages")
	cookieDomain := flag.String("cookie-domain", "", "parent domain for the session cookie; empty means host-only")
	secure := flag.Bool("secure-cookie", false, "set Secure on the session cookie; must be on outside local development")
	ttl := flag.Duration("session-ttl", 12*time.Hour, "session lifetime")
	permissive := flag.Bool("permissive", false,
		"development only: allow every permission check regardless of role")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

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
	catalogConn := dial(*catalogAddr)
	defer catalogConn.Close()
	inventoryConn := dial(*inventoryAddr)
	defer inventoryConn.Close()
	staffConn := dial(*staffAddr)
	defer staffConn.Close()
	paymentsConn := dial(*paymentsAddr)
	defer paymentsConn.Close()
	posConn := dial(*posAddr)
	defer posConn.Close()
	tenantConn := dial(*tenantAddr)
	defer tenantConn.Close()
	provConn := dial(*provAddr)
	defer provConn.Close()
	analyticsConn := dial(*analyticsAddr)
	defer analyticsConn.Close()
	notificationConn := dial(*notificationAddr)
	defer notificationConn.Close()
	auditConn := dial(*auditAddr)
	defer auditConn.Close()
	mediaConn := dial(*mediaAddr)
	defer mediaConn.Close()
	ledgerConn := dial(*ledgerAddr)
	defer ledgerConn.Close()
	supportConn := dial(*supportAddr)
	defer supportConn.Close()
	invoicingConn := dial(*invoicingAddr)
	defer invoicingConn.Close()
	bookingsConn := dial(*bookingsAddr)
	defer bookingsConn.Close()
	kitchenConn := dial(*kitchenAddr)
	defer kitchenConn.Close()

	g := &gateway{
		auth:         authpb.NewAuthServiceClient(authConn),
		rbac:         rbacpb.NewRBACServiceClient(rbacConn),
		catalog:      catalogpb.NewCatalogServiceClient(catalogConn),
		inventory:    inventorypb.NewInventoryServiceClient(inventoryConn),
		staff:        staffpb.NewStaffServiceClient(staffConn),
		payments:     paymentspb.NewPaymentsServiceClient(paymentsConn),
		pos:          pospb.NewPosServiceClient(posConn),
		tenant:       tenantpb.NewTenantServiceClient(tenantConn),
		provisioning: provpb.NewProvisioningServiceClient(provConn),
		analytics:    analyticspb.NewAnalyticsServiceClient(analyticsConn),
		notification: notificationpb.NewNotificationServiceClient(notificationConn),
		audit:        auditpb.NewAuditServiceClient(auditConn),
		media:        mediapb.NewMediaServiceClient(mediaConn),
		ledger:       ledgerpb.NewLedgerServiceClient(ledgerConn),
		support:      supportpb.NewSupportServiceClient(supportConn),
		invoicing:    invoicingpb.NewInvoicingServiceClient(invoicingConn),
		bookings:     bookingspb.NewBookingsServiceClient(bookingsConn),
		kitchen:      kitchenpb.NewKitchenServiceClient(kitchenConn),
		currency:     *currency,
		cookies: websession.Manager{
			// The merchant cookie, on the parent domain, so the dashboard, the
			// till, the calendar and the CRM subdomain share one sign-in.
			Name:   websession.CookieName,
			Domain: *cookieDomain,
			Secure: *secure,
			TTL:    *ttl,
		},
		adminURL:   strings.TrimRight(*adminURL, "/"),
		appURL:     strings.TrimRight(*appURL, "/"),
		permissive: *permissive,
	}
	if *permissive {
		slog.Warn("permissive mode: every permission check will pass. " +
			"This must never run outside local development.")
	}

	mux := http.NewServeMux()

	// Unauthenticated: these are how a session begins or is inspected.
	mux.HandleFunc("POST /api/auth/login", g.login)
	mux.HandleFunc("POST /api/auth/logout", g.logout)
	mux.HandleFunc("GET /api/auth/session", g.currentSession)
	// Signing up, and resetting a forgotten password. Both are how a session
	// begins, so neither can require one.
	g.registerSignup(mux)

	// Authenticated.
	mux.Handle("GET /api/bootstrap", g.authenticated(g.bootstrap))
	// Real services first. registerReadStubs must not claim a route a real
	// service already serves, and ServeMux would panic on the duplicate rather
	// than silently picking one, which is the failure mode you want here.
	g.registerCatalog(mux)
	g.registerTeamAndStock(mux)
	g.registerPayments(mux)
	g.registerOrders(mux)
	g.registerAnalytics(mux)
	g.registerNotifications(mux)
	g.registerAudit(mux)
	g.registerMedia(mux)
	g.registerLedger(mux)
	g.registerSupport(mux)
	g.registerDocuments(mux)
	g.registerBookings(mux)
	g.registerKitchen(mux)
	g.registerReadStubs(mux)

	// Anything else under /api that is not implemented yet says so plainly,
	// rather than returning a 404 that reads like a routing fault.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		httpx.Fail(w, r, http.StatusNotImplemented, httpx.CodeUnavailable,
			"This part of the API is not built yet.")
	})

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})

	srv := &http.Server{
		Addr:    *addr,
		Handler: httpx.WithRequestID(logging(mux)),
		// No write timeout on purpose. A card tender holds the request open
		// while somebody approves the payment on a terminal, which is exactly
		// what a till does: press Charge, the machine beeps, everybody waits.
		// POS bounds that wait itself; a timeout here would cut the cashier off
		// mid-sale with the money already taken.
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("gateway listening", "addr", *addr, "auth", *authAddr, "rbac", *rbacAddr,
			"catalog", *catalogAddr, "inventory", *inventoryAddr, "staff", *staffAddr,
			"payments", *paymentsAddr, "pos", *posAddr,
			"tenant", *tenantAddr, "provisioning", *provAddr,
			"cookie_domain", *cookieDomain, "secure_cookie", *secure)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("serve", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.URL.Path == "/healthz" {
			return
		}
		slog.Info("request",
			"method", r.Method, "path", r.URL.Path, "status", rec.status,
			"dur", time.Since(start).String(), "request_id", httpx.RequestID(r))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// authenticated verifies the session before the handler runs. It is the single
// place that decides whether a caller exists, so no handler can forget to ask.
func (g *gateway) authenticated(h func(http.ResponseWriter, *http.Request, caller)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, ok := g.verify(w, r)
		if !ok {
			return
		}
		h(w, r, c)
	})
}

func (g *gateway) verify(w http.ResponseWriter, r *http.Request) (caller, bool) {
	token := g.cookies.Token(r)
	if token == "" {
		httpx.Fail(w, r, http.StatusUnauthorized, httpx.CodeUnauthenticated, "Sign in to continue.")
		return caller{}, false
	}
	resp, err := g.auth.VerifyToken(r.Context(), &authpb.VerifyTokenRequest{Token: token})
	if err != nil {
		slog.Error("verify token", "err", err, "request_id", httpx.RequestID(r))
		httpx.Fail(w, r, http.StatusServiceUnavailable, httpx.CodeUnavailable,
			"We could not check your session. Try again in a moment.")
		return caller{}, false
	}
	if !resp.GetValid() {
		// The cookie is stale or forged either way; clearing it stops the
		// browser from retrying with it on every subsequent request.
		g.cookies.Clear(w)
		httpx.Fail(w, r, http.StatusUnauthorized, httpx.CodeUnauthenticated, "Your session has ended.")
		return caller{}, false
	}
	return caller{
		UserID:   resp.GetUserId(),
		TenantID: resp.GetTenantId(),
		Plane:    strings.ToLower(strings.TrimPrefix(resp.GetPlane().String(), "PLANE_")),
	}, true
}

// requirePermission is the entitlement and RBAC check from the architecture.
// It fails closed: any error denies rather than allowing.
func (g *gateway) requirePermission(w http.ResponseWriter, r *http.Request, c caller, permission string) bool {
	if g.permissive {
		return true
	}
	resp, err := g.rbac.Check(r.Context(), &rbacpb.CheckRequest{
		TenantId: c.TenantID, SubjectId: c.UserID,
		Permission: permission, Plane: planePB(c.Plane),
	})
	if err != nil {
		slog.Error("permission check", "err", err, "permission", permission,
			"request_id", httpx.RequestID(r))
		httpx.Fail(w, r, http.StatusServiceUnavailable, httpx.CodeUnavailable,
			"We could not check your permissions. Try again in a moment.")
		return false
	}
	if !resp.GetAllowed() {
		httpx.Fail(w, r, http.StatusForbidden, httpx.CodeForbidden,
			"You do not have permission to do that.")
		return false
	}
	return true
}

// downstream is how the caller's identity reaches a domain service.
//
// Services do not authenticate; they trust these headers because network policy
// means nothing else can reach them. Every call to a domain service goes
// through here, so no handler can forget to carry the tenant and none of them
// can invent one either.
func (g *gateway) downstream(r *http.Request, c caller) context.Context {
	id := tenantctx.Identity{Plane: c.Plane}
	// Parse rather than trust: these came from a verified token, but a
	// malformed one must fail here rather than reach a WHERE clause.
	if tid, err := uuid.Parse(c.TenantID); err == nil {
		id.TenantID = tid
	}
	if uid, err := uuid.Parse(c.UserID); err == nil {
		id.UserID = uid
	}
	return tenantctx.Outbound(r.Context(), id)
}

// failGRPC writes the HTTP answer for a failed downstream call, and logs the
// original. The merchant sees a sentence; the internals stay in the log.
func (g *gateway) failGRPC(w http.ResponseWriter, r *http.Request, err error) {
	code, kind, message := grpcStatus(err)
	if code >= 500 {
		slog.Error("downstream call failed", "err", err, "path", r.URL.Path,
			"request_id", httpx.RequestID(r))
	}
	httpx.Fail(w, r, code, kind, message)
}

func planePB(plane string) rbacpb.Plane {
	if plane == "admin" {
		return rbacpb.Plane_PLANE_ADMIN
	}
	return rbacpb.Plane_PLANE_TENANT
}

// grpcStatus maps a gRPC failure onto the HTTP shape the frontend expects,
// without leaking the internal message.
func grpcStatus(err error) (int, string, string) {
	switch status.Code(err) {
	case codes.Unauthenticated:
		return http.StatusUnauthorized, httpx.CodeUnauthenticated, "Invalid email or password."
	case codes.PermissionDenied:
		return http.StatusForbidden, httpx.CodeForbidden, status.Convert(err).Message()
	case codes.InvalidArgument:
		return http.StatusBadRequest, httpx.CodeInvalid, status.Convert(err).Message()
	case codes.AlreadyExists:
		return http.StatusConflict, httpx.CodeConflict, status.Convert(err).Message()
	case codes.NotFound:
		return http.StatusNotFound, httpx.CodeNotFound, "Not found."
	case codes.ResourceExhausted:
		// A plan limit, not a fault. The frontend branches on the code rather
		// than the status, and "not_entitled" is what tells it to offer an
		// upgrade instead of a retry.
		return http.StatusPaymentRequired, httpx.CodeNotEntitled, status.Convert(err).Message()
	case codes.FailedPrecondition:
		// The state is wrong, not the request: the last owner, an invitation
		// already accepted, an account that has traded. The message is written
		// for a merchant, so it is passed through.
		return http.StatusConflict, httpx.CodeConflict, status.Convert(err).Message()
	case codes.Unavailable:
		return http.StatusServiceUnavailable, httpx.CodeUnavailable,
			"That service is unavailable right now. Try again in a moment."
	case codes.DeadlineExceeded:
		// Not an outage. Something was waiting on a person and they did not
		// come: a card payment nobody approved, most often. The message says
		// where it is still waiting, so it is passed through.
		return http.StatusRequestTimeout, httpx.CodeConflict, status.Convert(err).Message()
	case codes.Canceled:
		return http.StatusRequestTimeout, httpx.CodeConflict, status.Convert(err).Message()
	default:
		return http.StatusInternalServerError, httpx.CodeInternal, "Something went wrong."
	}
}
