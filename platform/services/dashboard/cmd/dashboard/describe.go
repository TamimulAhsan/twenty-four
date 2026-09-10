package main

import (
	"bufio"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
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
	// Deployment or StatefulSet, which is what `kubectl rollout` has to be
	// told. Carried rather than assumed: the data tier is not all one kind.
	// Redis and Kafka Connect are Deployments, and restarting either as a
	// StatefulSet fails with "not found" on the one button they offer.
	Kind string
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

// The data tier: everything in the namespace that is not a service we wrote.
//
// None of these images are built from this repository, so none of them offers a
// rebuild. That is the whole reason they are listed apart rather than falling
// through to the surface rules, and it is why the map has to stay complete: a
// workload missing from here is one the monitor describes as "this checkout has
// nothing that builds it", which is true of the image and misleading about the
// workload.
//
// They are not uniformly stateful and the display should not imply that they
// are. Postgres, Kafka, ClickHouse and MinIO carry volumes that outlive the
// pod; Redis is a cache that rebuilds itself, and Connect keeps its offsets in
// Kafka rather than on disk.
var infra = map[string]struct{ purpose, domain string }{
	"postgres":   {"One database per service, all in one server. Volumes survive a restart", "data"},
	"redis":      {"The gateway's entitlement policy cache, invalidated by events rather than by TTL. Holds no volume: losing it costs one cold lookup per tenant", "data"},
	"kafka":      {"The event bus, in KRaft mode. Only the outbox relay produces to it", "data"},
	"clickhouse": {"Analytics store, fed by CDC off Kafka and never written to directly", "data"},
	"minio":      {"Object storage. Only the Media service writes here", "data"},
	"connect":    {"The CDC pipeline: Debezium reading Postgres, the sink writing ClickHouse. What it moves is not in its Deployment at all, but in the connector definitions beside it", "data"},
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
func (s *server) describe(ns, deployment, role, kind string) Workload {
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
			Parts:   []Part{{Deployment: deployment, Runner: "kubectl", Target: deployment, Half: "store", Kind: kind}},
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
		w.Parts = append(w.Parts, Part{Deployment: "web-" + name, Runner: "web-app.sh", Target: name, Half: "web", Kind: "Deployment"})
	}
	if s.surfaces.api[name] {
		w.Parts = append(w.Parts, Part{Deployment: name, Runner: "service.sh", Target: name, Half: "api", Kind: "Deployment"})
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

// --- the event flow ---------------------------------------------------------
//
// Nothing in the cluster declares which service publishes what, or which
// consumes it. A Deployment's flags say "-brokers=kafka:9092" and stop there,
// so the topology drew every service that touches the bus as depending on
// Kafka in the same undifferentiated way. That made the most interesting thing
// about this system invisible: you could not see from the picture that a sale
// rung up at the till reaches the ledger.
//
// So it is read from the source, at startup, the same way the surfaces and the
// inventory are. A service publishes the topics it names in an outbox event,
// and consumes the topics it names when it joins the bus. Both are literals in
// Go, which makes this a scan rather than a list somebody has to maintain, and
// a service whose topics are computed rather than written simply shows none:
// wrong in the direction of saying less, not of inventing an arrow.

// eventing is what one service does with the bus.
type eventing struct {
	Publishes []string
	Consumes  []string
	// True when the consumer subscribes by pattern rather than by name, which
	// only the audit trail does. Listing its topics would be listing every
	// topic in the platform, which is both wrong and useless as a label.
	ConsumesEverything bool
}

var (
	// Both idioms a service uses to name a topic: inline in the event, and
	// assigned to a variable first, which is what a handler does when the
	// topic depends on which state a thing moved to.
	//
	//   outbox.Event{ ... Topic: "order.placed" ... }
	//   topic = "booking.cancelled"
	topicLiteral = regexp.MustCompile(`(?:Topic:|topic\s*=)\s*"([a-z][a-z_]*\.[a-z][a-z_]*)"`)
	// bus.NewConsumer(brokers, "ledger", []string{"order.placed", ...}, h)
	consumerCall = regexp.MustCompile(`bus\.New(Regex)?Consumer\(`)
	quoted       = regexp.MustCompile(`"([^"]*)"`)
)

// loadEventing scans each service's Go source for what it puts on the bus and
// what it takes off.
func loadEventing(root string) map[string]eventing {
	out := map[string]eventing{}
	dirs, _ := filepath.Glob(filepath.Join(root, "services", "*"))
	for _, dir := range dirs {
		name := filepath.Base(dir)
		// web holds the frontends, and dashboard is this monitor. Skipping the
		// monitor is not tidiness: it is the one directory whose source writes
		// *about* the bus rather than to it, so scanning it finds the topic
		// names in these very comments and reports the monitor as publishing
		// sales.
		if name == "web" || name == "dashboard" {
			continue
		}
		// A service publishes only if it owns a schema, because publishing here
		// means writing to an outbox and an outbox is a table. The gateway and
		// the relay name topics in their source and own no database: the
		// gateway because it passes them through, the relay because it carries
		// everybody's.
		owns := dirExists(filepath.Join(dir, "migrations"))
		var e eventing
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
				return nil
			}
			body, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			text := string(body)
			if owns {
				for _, m := range topicLiteral.FindAllStringSubmatch(text, -1) {
					e.Publishes = appendOnce(e.Publishes, m[1])
				}
			}
			for _, loc := range consumerCall.FindAllStringIndex(text, -1) {
				regex := strings.Contains(text[loc[0]:loc[1]], "Regex")
				// The call's arguments, bounded rather than parsed. A
				// consumer's topic list is a literal slice a few characters
				// after the call, and a Go parser here would be a lot of
				// machinery for one regex worth of answer.
				tail := text[loc[1]:min(loc[1]+400, len(text))]
				for _, q := range quoted.FindAllStringSubmatch(tail, -1) {
					value := q[1]
					if regex {
						e.ConsumesEverything = true
						continue
					}
					if topicName.MatchString(value) {
						e.Consumes = appendOnce(e.Consumes, value)
					}
				}
			}
			return nil
		})
		// The relay is the only producer, and it produces everybody's events
		// rather than its own. Its own source names no topics, which is
		// correct, and its edge to Kafka is drawn from the fact that it is the
		// relay rather than from a scan.
		if len(e.Publishes) > 0 || len(e.Consumes) > 0 || e.ConsumesEverything {
			sort.Strings(e.Publishes)
			sort.Strings(e.Consumes)
			out[name] = e
		}
	}
	return out
}

// topicName is the shape of an announcement: subject.verb, one dot. It is the
// same rule the audit trail matches on, so a string that is not a topic, a
// format verb or a log key, does not become an arrow.
var topicName = regexp.MustCompile(`^[a-z][a-z_]*\.[a-z][a-z_]*$`)

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func appendOnce(list []string, v string) []string {
	for _, existing := range list {
		if existing == v {
			return list
		}
	}
	return append(list, v)
}
