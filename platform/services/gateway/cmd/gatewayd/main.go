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

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	rbacpb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
	"github.com/twentyfour/platform/services/gateway/internal/httpx"
	"github.com/twentyfour/platform/services/gateway/internal/session"
)

type gateway struct {
	auth    authpb.AuthServiceClient
	rbac    rbacpb.RBACServiceClient
	cookies session.Manager
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

	g := &gateway{
		auth: authpb.NewAuthServiceClient(authConn),
		rbac: rbacpb.NewRBACServiceClient(rbacConn),
		cookies: session.Manager{
			Domain: *cookieDomain,
			Secure: *secure,
			TTL:    *ttl,
		},
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

	// Authenticated.
	mux.Handle("GET /api/bootstrap", g.authenticated(g.bootstrap))
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
		Addr:              *addr,
		Handler:           httpx.WithRequestID(logging(mux)),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("gateway listening", "addr", *addr, "auth", *authAddr, "rbac", *rbacAddr,
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
	token := session.Token(r)
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
	case codes.Unavailable, codes.DeadlineExceeded:
		return http.StatusServiceUnavailable, httpx.CodeUnavailable,
			"That service is unavailable right now. Try again in a moment."
	default:
		return http.StatusInternalServerError, httpx.CodeInternal, "Something went wrong."
	}
}
