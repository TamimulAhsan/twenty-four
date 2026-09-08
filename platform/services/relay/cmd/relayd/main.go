// Command relayd drains every service's transactional outbox into Kafka.
//
// It is the only process that publishes to the bus. Services write events into
// their own database, in the transaction that made the change, and stop caring;
// the relay moves them. That separation is what makes a broker outage a
// backlog rather than an outage: with Kafka down, sales still commit.
//
// It has no gRPC API. Nothing calls it, and it calls nothing but Postgres and
// Kafka. The HTTP port exists only for probes and for the cluster view.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/outbox"
	"github.com/twentyfour/platform/packages/pg"
	"github.com/twentyfour/platform/services/relay/internal/kafka"
)

// A source is one service's database. The relay holds a pool per source and
// drains them independently: a service whose outbox is jammed must not stop
// another service's events from moving.
type source struct {
	name string
	pool *pg.Pool
	pub  outbox.Publisher

	mu      sync.Mutex
	backlog outbox.Backlog
	lastErr string
	lastRun time.Time
}

type relay struct {
	dir      string
	brokers  []string
	batch    int
	interval time.Duration
	retain   time.Duration

	pub *kafka.Publisher

	mu      sync.RWMutex
	sources map[string]*source
	kafkaOK bool
}

// discover reads the DSN directory. Each file is one service: the file name is
// the service, the contents are its DSN.
//
// A directory rather than a flag so that adding the tenth service is a change
// to one Secret and not a redeploy of the relay. Kubernetes projects a Secret
// as a directory of symlinks behind dot-prefixed bookkeeping entries, which is
// why those are skipped.
func discover(dir string) (map[string]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("relay: read %s: %w", dir, err)
	}
	out := map[string]string{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "..") || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			slog.Warn("unreadable DSN", "source", e.Name(), "err", err)
			continue
		}
		if dsn := strings.TrimSpace(string(b)); dsn != "" {
			out[e.Name()] = dsn
		}
	}
	return out, nil
}

// hasOutbox is how a database earns a drain loop. Auth and RBAC hold no outbox
// and never will, so their DSNs sit in the same Secret and are simply passed
// over. Checking rather than configuring means a service that grows an outbox
// later is picked up on the next scan.
func hasOutbox(ctx context.Context, pool *pg.Pool) (bool, error) {
	var present bool
	err := pool.QueryRow(ctx,
		`SELECT to_regclass('public.outbox') IS NOT NULL`).Scan(&present)
	return present, err
}

// scan brings the set of live sources in line with what is on disk.
func (r *relay) scan(ctx context.Context) {
	found, err := discover(r.dir)
	if err != nil {
		slog.Error("scan", "err", err)
		return
	}
	for name, dsn := range found {
		r.mu.RLock()
		_, running := r.sources[name]
		r.mu.RUnlock()
		if running {
			continue
		}

		// Bounded, so one unreachable database does not hold up discovery of
		// the others. It is picked up on the next scan.
		dial, cancel := context.WithTimeout(ctx, 10*time.Second)
		pool, err := pg.Open(dial, dsn)
		cancel()
		if err != nil {
			slog.Warn("source unreachable", "source", name, "err", err)
			continue
		}
		ok, err := hasOutbox(ctx, pool)
		if err != nil || !ok {
			// Not an error: most databases here legitimately have no outbox.
			pool.Close()
			continue
		}
		s := &source{name: name, pool: pool, pub: r.pub.For(name)}
		r.mu.Lock()
		r.sources[name] = s
		r.mu.Unlock()
		slog.Info("draining", "source", name)
		go r.loop(ctx, s)
	}
}

// loop drains one source until the context ends.
func (r *relay) loop(ctx context.Context, s *source) {
	defer s.pool.Close()

	tick := time.NewTicker(r.interval)
	defer tick.Stop()
	purge := time.NewTicker(time.Hour)
	defer purge.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-purge.C:
			if n, err := outbox.Purge(ctx, s.pool, r.retain); err != nil {
				slog.Warn("purge", "source", s.name, "err", err)
			} else if n > 0 {
				slog.Info("purged published events", "source", s.name, "rows", n)
			}
		case <-tick.C:
			// Keep draining while full batches come back, so a backlog clears
			// at the speed of the bus rather than one batch per tick.
			for {
				n, err := outbox.Drain(ctx, s.pool, r.batch, s.pub)
				r.record(s, err)
				if err != nil || n < r.batch {
					break
				}
			}
		}
	}
}

func (r *relay) record(s *source, err error) {
	b, serr := outbox.Stats(context.Background(), s.pool)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastRun = time.Now()
	if serr == nil {
		s.backlog = b
	}
	if err != nil {
		s.lastErr = err.Error()
		slog.Warn("drain failed", "source", s.name, "err", err,
			"pending", b.Pending, "note", "events are safe in Postgres and will retry")
		return
	}
	s.lastErr = ""
}

// watchKafka keeps the readiness answer current without making every probe pay
// for a round trip to the broker.
func (r *relay) watchKafka(ctx context.Context) {
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	for {
		ok := r.pub.Reachable(ctx) == nil
		r.mu.Lock()
		r.kafkaOK = ok
		r.mu.Unlock()

		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

type sourceStatus struct {
	Source    string    `json:"source"`
	Pending   int64     `json:"pending"`
	Failing   int64     `json:"failing"`
	OldestAge string    `json:"oldest_age,omitempty"`
	LastError string    `json:"last_error,omitempty"`
	LastRun   time.Time `json:"last_run"`
}

func (r *relay) status() []sourceStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]sourceStatus, 0, len(r.sources))
	for _, s := range r.sources {
		s.mu.Lock()
		st := sourceStatus{
			Source: s.name, Pending: s.backlog.Pending, Failing: s.backlog.Failing,
			LastError: s.lastErr, LastRun: s.lastRun,
		}
		if !s.backlog.Oldest.IsZero() {
			st.OldestAge = time.Since(s.backlog.Oldest).Round(time.Second).String()
		}
		s.mu.Unlock()
		out = append(out, st)
	}
	return out
}

func (r *relay) routes() *http.ServeMux {
	mux := http.NewServeMux()
	// Liveness: the process is running. Deliberately not tied to Kafka: a
	// broker outage must not restart the relay, which would achieve nothing
	// and lose the pools.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		r.mu.RLock()
		ok, n := r.kafkaOK, len(r.sources)
		r.mu.RUnlock()
		if !ok {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("kafka unreachable"))
			return
		}
		_, _ = fmt.Fprintf(w, "ready; %d sources", n)
	})
	// The backlog, for the cluster view. How far behind the bus is, is the one
	// number that says whether the event pipeline is healthy.
	mux.HandleFunc("/stats", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(r.status())
	})
	return mux
}

func main() {
	dir := flag.String("dsn-dir", "/etc/twentyfour/dsn",
		"directory of DSN files, one per service database")
	brokers := flag.String("brokers", "kafka.twentyfour.svc.cluster.local:9092",
		"comma-separated Kafka seed brokers")
	addr := flag.String("addr", ":9110", "HTTP address for probes and stats")
	batch := flag.Int("batch", 200, "events published per transaction")
	interval := flag.Duration("interval", time.Second, "how often each outbox is polled")
	rescan := flag.Duration("rescan", time.Minute, "how often the DSN directory is re-read")
	retain := flag.Duration("retain", 0,
		"delete published events older than this; 0 keeps them forever")
	level := flag.String("log-level", "info", "debug, info, warn or error")
	flag.Parse()

	grpcx.SetupLogging(*level)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pub, err := kafka.New(strings.Split(*brokers, ","))
	if err != nil {
		slog.Error("kafka client", "err", err)
		os.Exit(1)
	}
	defer pub.Close()

	r := &relay{
		dir: *dir, brokers: strings.Split(*brokers, ","), pub: pub,
		batch: *batch, interval: *interval, retain: *retain,
		sources: map[string]*source{},
	}
	if *retain == 0 {
		slog.Info("outbox retention is off; published events are kept forever")
	}

	r.scan(ctx)
	go r.watchKafka(ctx)
	go func() {
		tick := time.NewTicker(*rescan)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				r.scan(ctx)
			}
		}
	}()

	srv := &http.Server{Addr: *addr, Handler: r.routes(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		slog.Info("relay listening", "addr", *addr, "brokers", *brokers, "dsn_dir", *dir)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("http", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	// Cancelling first lets each drain loop finish the transaction it is in.
	// Nothing is lost either way, since an interrupted drain rolls back and
	// the events are still there, but a clean stop avoids a redelivery.
	slog.Info("shutting down")
	cancel()
	shutdownCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	_ = srv.Shutdown(shutdownCtx)
}
