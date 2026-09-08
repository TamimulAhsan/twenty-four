// Package grpcx is the twenty lines every service's main() would otherwise
// write for itself: a server with health checks Kubernetes can probe,
// reflection so grpcurl works, request logging, and a shutdown that lets
// in-flight calls finish.
//
// Consistency here is worth more than flexibility. A probe that is configured
// differently in one Deployment is a service that looks healthy while it is
// not, and that is not a thing to discover during an incident.
package grpcx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"

	"github.com/twentyfour/platform/packages/tenantctx"
)

// Options configures a server. The zero value is a working server that requires
// a tenant on every call.
type Options struct {
	// Full method names that may be called without a tenant. Keep this short:
	// most services should have none, and the ones that do (Auth's Login,
	// Signup and VerifyToken) should say so in one visible place.
	Exempt []string
	// Set to skip the tenant interceptor entirely. Only correct for a service
	// with no tenant-scoped data at all.
	NoTenantCheck bool
	// Extra interceptors, run after the tenant check.
	Interceptors []grpc.UnaryServerInterceptor
}

// New builds the server. Register your service on it, then call Run.
func New(opts Options) *grpc.Server {
	chain := []grpc.UnaryServerInterceptor{recoverInterceptor(), logInterceptor()}
	if !opts.NoTenantCheck {
		chain = append(chain, tenantctx.UnaryServerInterceptor(opts.Exempt...))
	}
	chain = append(chain, opts.Interceptors...)

	srv := grpc.NewServer(
		grpc.ChainUnaryInterceptor(chain...),
		// Idle clients are cheap; half-open connections are not. Kubernetes
		// moves pods often enough that a service holding a connection to one
		// that has gone is a real failure mode.
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionIdle: 5 * time.Minute,
			Time:              30 * time.Second,
			Timeout:           10 * time.Second,
		}),
	)
	hs := health.NewServer()
	hs.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	grpc_health_v1.RegisterHealthServer(srv, hs)
	reflection.Register(srv)
	return srv
}

// Run serves until SIGINT or SIGTERM, then stops gracefully so in-flight calls
// finish rather than being cut off mid-transaction.
func Run(srv *grpc.Server, addr, name string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("grpcx: listen %s: %w", addr, err)
	}

	errc := make(chan error, 1)
	go func() {
		slog.Info("listening", "service", name, "addr", addr)
		if err := srv.Serve(lis); err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			errc <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errc:
		return fmt.Errorf("grpcx: serve: %w", err)
	case <-stop:
	}

	slog.Info("shutting down", "service", name)
	done := make(chan struct{})
	go func() { srv.GracefulStop(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		// Past the grace period something is wedged. Kubernetes will send
		// SIGKILL shortly anyway; losing a call is better than hanging.
		slog.Warn("graceful stop timed out; forcing", "service", name)
		srv.Stop()
	}
	return nil
}

// Dial connects to another service. Service-to-service traffic stays inside the
// cluster, so there is no TLS here; what keeps it private is network policy.
//
// The identity of the original caller is forwarded, so the second hop knows
// which tenant it is acting for.
func Dial(addr string) (*grpc.ClientConn, error) {
	return grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithChainUnaryInterceptor(tenantctx.UnaryClientInterceptor()),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
	)
}

// logInterceptor logs one line per call. Errors carry the code, because a
// NotFound and an Internal are the same word in a message and very different
// things to be woken up for.
func logInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
		start := time.Now()
		resp, err := h(ctx, req)
		attrs := []any{"method", info.FullMethod, "ms", time.Since(start).Milliseconds()}
		if id, ok := tenantctx.From(ctx); ok {
			attrs = append(attrs, "tenant", id.TenantID)
		}
		if err != nil {
			slog.Warn("rpc failed", append(attrs, "code", status.Code(err), "err", err)...)
		} else {
			slog.Debug("rpc", attrs...)
		}
		return resp, err
	}
}

// recoverInterceptor turns a panic into an error for one caller instead of a
// restart for everyone. It logs loudly: a recovered panic is still a bug.
func recoverInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (resp any, err error) {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic in handler", "method", info.FullMethod, "panic", r)
				err = status.Error(codes.Internal, "internal error")
			}
		}()
		return h(ctx, req)
	}
}

// SetupLogging gives every service the same structured output, at a level the
// Deployment can turn up without a rebuild.
func SetupLogging(level string) {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l})))
}
