// Command dashboard serves a live view of the cluster: what is running, what it
// is for, how the pieces are wired to each other, and whether any of it is
// failing. It can also start, stop, restart and rebuild a workload.
//
// Collection is read-only: it shells out to `kubectl get` and nothing else.
// Actions are not, and that is worth stating plainly rather than leaving in a
// handler. They run the same scripts the Makefile runs, as you, with your
// kubeconfig, so this can reach exactly what a shell on this machine could
// reach and nothing more. -read-only turns them off entirely.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// server holds what outlives a request: the cluster snapshot, the running
// action, and the service list read at startup.
type server struct {
	*cache
	jobs      *jobs
	inventory map[string]struct{ purpose, domain, phase string }
	// Which names have a frontend, a backend, or both. Read off disk at
	// startup with the same rule the Makefile uses, so the two cannot disagree
	// about whether "pos" is one deployment or two.
	surfaces surfaces
	// What each service puts on the bus and takes off it, read from source at
	// startup. Nothing in the cluster declares this.
	eventing map[string]eventing
	readOnly bool
}

// workloadFor finds a surface by name among the ones the collector recognised.
//
// A lookup, not a reconstruction. Building the Workload here from a node's
// fields meant two pieces of code deciding what "pos" means, and they drifted:
// this one knew about one Deployment where describe() knew about two.
func workloadFor(g *Graph, name string) (Workload, bool) {
	w, ok := g.workloads[name]
	if !ok || len(w.Actions) == 0 {
		return Workload{}, false
	}
	return w, true
}

type cache struct {
	mu   sync.RWMutex
	g    *Graph
	err  error
	subs map[chan struct{}]bool
}

func (c *cache) set(g *Graph, err error) {
	c.mu.Lock()
	c.g, c.err = g, err
	for ch := range c.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	c.mu.Unlock()
}

func (c *cache) get() (*Graph, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.g, c.err
}

func (c *cache) sub() chan struct{} {
	ch := make(chan struct{}, 1)
	c.mu.Lock()
	c.subs[ch] = true
	c.mu.Unlock()
	return ch
}

func (c *cache) unsub(ch chan struct{}) {
	c.mu.Lock()
	delete(c.subs, ch)
	c.mu.Unlock()
}

func main() {
	addr := flag.String("addr", ":8090", "listen address")
	static := flag.String("static", "web/dist", "directory of built UI assets")
	nsCSV := flag.String("namespaces", "twentyfour,kube-system", "namespaces to watch (empty = all)")
	every := flag.Duration("interval", 2*time.Second, "poll interval")
	inventory := flag.String("inventory", "deploy/inventory.tsv",
		"the service list, read for what each workload is for")
	readOnly := flag.Bool("read-only", false,
		"collect and display only: refuse every start, stop and rebuild")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	var namespaces []string
	if s := strings.TrimSpace(*nsCSV); s != "" {
		namespaces = strings.Split(s, ",")
	}

	srv := &server{
		cache:     &cache{subs: map[chan struct{}]bool{}},
		jobs:      newJobs(),
		inventory: loadInventory(*inventory),
		surfaces:  loadSurfaces("."),
		eventing:  loadEventing("."),
		readOnly:  *readOnly,
	}
	if len(srv.inventory) == 0 {
		// Not fatal: the graph is still worth drawing. But every backend pod
		// will render without a purpose, and silently is the wrong way to
		// find that out.
		slog.Warn("no service inventory: pods will render without a purpose",
			"path", *inventory, "hint", "run from the platform directory, or pass -inventory")
	}
	c := srv.cache
	poll := func() {
		g, err := srv.Collect(namespaces)
		if err != nil {
			slog.Error("collect failed", "err", err)
		}
		c.set(g, err)
	}
	poll()
	go func() {
		t := time.NewTicker(*every)
		defer t.Stop()
		for range t.C {
			poll()
		}
	}()

	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/graph", func(w http.ResponseWriter, r *http.Request) {
		g, err := c.get()
		if err != nil && g == nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(g)
	})

	// Server-sent events: one message per poll, so the UI is live without polling.
	mux.HandleFunc("GET /api/stream", func(w http.ResponseWriter, r *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		ch := c.sub()
		defer c.unsub(ch)
		send := func() {
			g, _ := c.get()
			if g == nil {
				return
			}
			b, err := json.Marshal(g)
			if err != nil {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", b)
			fl.Flush()
		}
		send()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ch:
				send()
			}
		}
	})

	// ---- actions ----------------------------------------------------------
	//
	// The one place this stops being read-only. Each runs the same script the
	// Makefile runs, as you, with your kubeconfig.

	mux.HandleFunc("POST /api/actions/{workload}/{action}", func(w http.ResponseWriter, r *http.Request) {
		if srv.readOnly {
			http.Error(w, "this monitor is running read-only", http.StatusForbidden)
			return
		}
		g, _ := c.get()
		if g == nil {
			http.Error(w, "no cluster state yet", http.StatusServiceUnavailable)
			return
		}
		// The workload has to be one the collector actually saw, and the action
		// one it said that workload accepts. Taking either from the request
		// alone would make this endpoint a way to run scripts by name.
		target, ok := workloadFor(g, r.PathValue("workload"))
		if !ok {
			http.Error(w, "no such workload", http.StatusNotFound)
			return
		}
		action := r.PathValue("action")
		steps, err := target.command(action)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		job, err := srv.jobs.start(target, action, func(j *Job) error { return runSteps(j, steps) })
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		slog.Info("action started", "surface", target.Name, "action", action,
			"moves", target.Moves(), "job", job.ID)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(job)
	})

	mux.HandleFunc("GET /api/actions/{id}", func(w http.ResponseWriter, r *http.Request) {
		job, ok := srv.jobs.get(r.PathValue("id"))
		if !ok {
			http.Error(w, "no such job", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(job)
	})

	mux.HandleFunc("GET /api/logs/{ns}/{pod}", func(w http.ResponseWriter, r *http.Request) {
		out, err := kubectlText("logs", "-n", r.PathValue("ns"), r.PathValue("pod"), "--tail=200")
		if err != nil {
			out = err.Error()
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(out))
	})

	// SPA fallback so client-side routes resolve.
	fs := http.FileServer(http.Dir(*static))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(*static + r.URL.Path); r.URL.Path != "/" && err == nil {
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, *static+"/index.html")
	})

	slog.Info("dashboard up", "addr", *addr, "namespaces", namespaces, "static", *static,
		"readOnly", *readOnly, "services", len(srv.inventory))
	if err := http.ListenAndServe(*addr, mux); err != nil {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
}
