// Command core is the Phase 0 service: it exists to prove the deployment path
// end to end — podman build, local registry, k3s pull, Traefik route — before
// any domain logic is written. Stdlib only, on purpose.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type dependency struct {
	Name string
	Addr string
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	addr := env("LISTEN_ADDR", ":8080")
	deps := []dependency{
		{"postgres", env("POSTGRES_ADDR", "postgres:5432")},
		{"redis", env("REDIS_ADDR", "redis:6379")},
		{"kafka", env("KAFKA_ADDR", "kafka:9092")},
	}

	mux := http.NewServeMux()

	// Liveness: the process is up. Never checks dependencies — a dependency
	// outage must not cause Kubernetes to restart a healthy pod.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})

	// Readiness: we can actually serve. Checks dependencies, so a pod with a
	// dead database is pulled from the load balancer instead of erroring.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		results := map[string]string{}
		ready := true
		for _, d := range deps {
			if err := dial(r.Context(), d.Addr); err != nil {
				results[d.Name] = "unreachable"
				ready = false
				continue
			}
			results[d.Name] = "ok"
		}
		code := http.StatusOK
		if !ready {
			code = http.StatusServiceUnavailable
		}
		writeJSON(w, code, map[string]any{"ready": ready, "dependencies": results})
	})

	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service": "core",
			"phase":   "0 — deployment path only",
			"commit":  env("GIT_COMMIT", "dev"),
		})
	})

	srv := &http.Server{
		Addr:              addr,
		Handler:           logging(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		slog.Info("listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	slog.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
	}
}

func dial(ctx context.Context, addr string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	return conn.Close()
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			return // probes are noise
		}
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start).String())
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
