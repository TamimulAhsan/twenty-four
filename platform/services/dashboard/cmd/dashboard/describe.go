package main

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// What each thing is for, and what an action on it actually moves.
//
// The unit here is a surface, not a Deployment, because that is the unit the
// Makefile already commands and the unit a person means. `make pos-up` moves
// the till: its frontend and the POS service behind it. Stopping "pos" and
// finding the web half still serving is exactly the confusion this is meant to
// remove, so the buttons mean what the targets mean.
//
// The pairing is derived, never listed. A name is a paired surface when it has
// both a backend Containerfile and a frontend application; it is web-only or
// api-only when it has just one of the two. Writing the bookings service is
// therefore enough to make `bookings` start moving both halves, with no list
// here or in the Makefile to remember to edit.
//
// The backend purposes are read from deploy/inventory.tsv, which is already the
// one place that answers "what is this service". The frontend and data tiers
// have no such file, so they are written out below.

// Part is one Deployment a surface moves, and how to move it.
type Part struct {
	// The Deployment name, which is what the cluster calls it: pos, web-pos.
	Deployment string
	// The script that owns it, and the name to pass that script. They differ:
	// web-pos is brought up as `web-app.sh up pos`.
	Runner string
	Target string
	// api | web | store. Only used to order the steps, so that a surface goes
	// down frontend-first and comes back up the same way the Makefile does it.
	Half string
}

// Workload is what an action acts on: a surface and every Deployment in it.
//
// Never a pod. Scaling a pod does nothing you would want: the ReplicaSet makes
// another one straight away, which looks like the button did not work.
type Workload struct {
	// The surface name: pos, catalog, dashboard, postgres.
	Name    string
	Parts   []Part
	Actions []string
	Purpose string
	Domain  string
}

// Moves lists the Deployments an action on this workload will touch, so the
// confirmation can say so rather than leaving it to be discovered afterwards.
func (w Workload) Moves() []string {
	out := make([]string, 0, len(w.Parts))
	for _, p := range w.Parts {
		out = append(out, p.Deployment)
	}
	return out
}

// The frontends. One nginx pod per application, each its own image.
var frontends = map[string]struct{ purpose, domain string }{
	"dashboard": {"The merchant dashboard: analysis, money, configuration and the team", "merchant"},
	"pos":       {"The till. A tablet at a counter: cart, tender, refunds, the day's takings", "merchant"},
	"bookings":  {"The calendar. Slots, deposits, no-shows and never double-booking a person", "merchant"},
	"auth":      {"Sign in and sign up. One form for both planes: the account decides where you land", "merchant"},
	"admin":     {"The admin console. Every tenant in this environment, on its own host", "admin"},
	"unavailable": {
		"The page every application falls back to when it is scaled down or failing. It carries no dependencies so it can stay up when nothing else is",
		"edge"},
}

// The data tier. Not ours to rebuild, and their volumes outlive the pod.
var infra = map[string]struct{ purpose, domain string }{
	"postgres":   {"One database per service, all in one server. Volumes survive a restart", "data"},
	"redis":      {"The gateway's entitlement policy cache, invalidated by events rather than by TTL", "data"},
	"kafka":      {"The event bus, in KRaft mode. Only the outbox relay produces to it", "data"},
	"clickhouse": {"Analytics store, fed by CDC off Kafka and never written to directly", "data"},
	"minio":      {"Object storage. Only the Media service writes here", "data"},
}

// surfaces is what the repository can build, split by half.
type surfaces struct {
	api map[string]bool
	web map[string]bool
}

// loadSurfaces reads the two halves off disk, with the same rule the Makefile
// uses: a Containerfile is what makes something buildable, so a directory that
// has one is a half and a directory that does not is not yet.
func loadSurfaces(root string) surfaces {
	s := surfaces{api: map[string]bool{}, web: map[string]bool{}}
	for _, f := range globDirs(filepath.Join(root, "services", "*", "Containerfile")) {
		s.api[f] = true
	}
	for _, f := range globDirs(filepath.Join(root, "services", "web", "apps", "*", "Containerfile")) {
		s.web[f] = true
	}
	return s
}

// globDirs returns the directory name of every path the pattern matches.
func globDirs(pattern string) []string {
	matches, _ := filepath.Glob(pattern)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, filepath.Base(filepath.Dir(m)))
	}
	sort.Strings(out)
	return out
}

// inventory reads the backend service list once, at startup.
func loadInventory(path string) map[string]struct{ purpose, domain, phase string } {
	out := map[string]struct{ purpose, domain, phase string }{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "#") || strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 4 {
			continue
		}
		out[parts[0]] = struct{ purpose, domain, phase string }{parts[3], parts[1], parts[2]}
	}
	return out
}

// describe answers, for one Deployment, which surface it belongs to and what
// may be done to that surface.
//
// The action lists are deliberately different per kind. A frontend and a Go
// service are both ours and can be rebuilt from source. A datastore is an
// upstream image with a volume attached: restarting it is a normal thing to do
// and rebuilding it is meaningless, so the button is not offered rather than
// offered and refused. Nothing in kube-system is ours to touch at all.
func (s *server) describe(ns, deployment, role string) Workload {
	switch {
	case role == "system" || ns == "kube-system":
		return Workload{
			Name:    deployment,
			Purpose: "Part of k3s itself: CoreDNS, Traefik, metrics-server, local-path.",
			Domain:  "system",
		}

	case role == "datastore":
		w := Workload{
			Name:    deployment,
			Parts:   []Part{{Deployment: deployment, Runner: "kubectl", Target: deployment, Half: "store"}},
			Actions: []string{"restart"},
		}
		if d, ok := infra[deployment]; ok {
			w.Purpose, w.Domain = d.purpose, d.domain
		}
		return w
	}

	// Everything else is ours, and belongs to a surface. The surface name is
	// the Deployment name with the web- prefix removed, because that prefix is
	// how the cluster distinguishes the two halves of one product surface.
	name := strings.TrimPrefix(deployment, "web-")
	w := Workload{Name: name, Actions: []string{"stop", "start", "restart", "rebuild"}}

	// Frontend first in both directions. Down, it is the half that shows the
	// unavailable page, so it should stop serving before its API disappears
	// underneath it. Up, it is ready to render an empty state while the API
	// is still rolling. This is the order the Makefile uses.
	if s.surfaces.web[name] {
		w.Parts = append(w.Parts, Part{Deployment: "web-" + name, Runner: "web-app.sh", Target: name, Half: "web"})
	}
	if s.surfaces.api[name] {
		w.Parts = append(w.Parts, Part{Deployment: name, Runner: "service.sh", Target: name, Half: "api"})
	}
	if len(w.Parts) == 0 {
		// Deployed, but nothing on disk can build it. Say so rather than
		// offering buttons that would fail.
		return Workload{Name: name, Purpose: "Deployed, but this checkout has nothing that builds it."}
	}

	// The purpose comes from whichever half has one to give. A paired surface
	// gets the service's line, because that is the half that says what the
	// thing does; a web-only surface gets the application's.
	if d, ok := s.inventory[name]; ok && s.surfaces.api[name] {
		w.Purpose, w.Domain = d.purpose, d.domain
	}
	if d, ok := frontends[name]; ok && w.Purpose == "" {
		w.Purpose, w.Domain = d.purpose, d.domain
	}
	if len(w.Parts) == 2 {
		w.Purpose += ". The frontend and its API move together: this is one surface, in two deployments"
	}
	return w
}

// workloadName strips the ReplicaSet and pod suffixes off a pod name.
//
// The app label is the reliable answer and every workload here carries one;
// trimming the name is the fallback for anything that does not.
func workloadName(pod string, labels map[string]string) string {
	if app := labels["app"]; app != "" {
		return app
	}
	parts := strings.Split(pod, "-")
	if len(parts) > 2 {
		return strings.Join(parts[:len(parts)-2], "-")
	}
	return pod
}
