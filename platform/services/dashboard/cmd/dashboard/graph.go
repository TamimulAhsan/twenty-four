package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

// containerSpec is shared by pods and by the pod template inside a Deployment,
// because a scaled-to-zero workload has no pod and its wiring has to be read
// off the template instead. One shape, so the two cannot disagree about where
// a dependency is declared.
type containerSpec struct {
	Name, Image string
	// Value carries a literal; ValueFrom carries a reference. Both are needed:
	// every service takes its database as a secret reference, so reading only
	// the literal drew a topology in which nothing used a database.
	Env []struct {
		Name, Value string
		ValueFrom   *struct {
			SecretKeyRef *struct{ Name, Key string } `json:"secretKeyRef"`
		} `json:"valueFrom"`
	}
	// Every service here takes its dependencies as flags rather than
	// environment variables, so this is where the wiring actually is. Reading
	// only Env drew a graph with no edges between services at all.
	Args    []string
	Command []string
	Ports   []struct {
		ContainerPort int32
	}
}

type podList struct {
	Items []struct {
		Metadata struct {
			Name, Namespace, CreationTimestamp string
			OwnerReferences                    []struct{ Kind, Name string }
			Labels                             map[string]string
		}
		Spec struct {
			NodeName   string
			Containers []containerSpec
		}
		Status struct {
			Phase, PodIP      string
			ContainerStatuses []struct {
				Name         string
				Ready        bool
				RestartCount int
				Image        string
				State        map[string]struct {
					Reason string
				}
			}
		}
	}
}

// workloadList covers Deployments and StatefulSets alike: the fields this
// needs are the same in both.
//
// Collected because "down" scales to zero rather than deleting, so a stopped
// service is a Deployment with no pods. Reading only pods made it vanish from
// the graph entirely, which left no way to start it again from the place you
// were told it had stopped.
type workloadList struct {
	Items []struct {
		Metadata struct {
			Name, Namespace, CreationTimestamp string
			Labels                             map[string]string
		}
		Spec struct {
			Replicas *int
			Selector struct {
				MatchLabels map[string]string
			}
			Template struct {
				Metadata struct{ Labels map[string]string }
				Spec     struct {
					Containers []containerSpec
				}
			}
		}
	}
}

type svcList struct {
	Items []struct {
		Metadata struct{ Name, Namespace string }
		Spec     struct {
			Selector  map[string]string
			ClusterIP string
			Ports     []struct {
				Port int32
				Name string
			}
		}
	}
}

type epsList struct {
	Items []struct {
		Metadata struct {
			Namespace string
			Labels    map[string]string
		}
		Endpoints []struct {
			TargetRef *struct{ Kind, Name string }
		}
	}
}

type ingList struct {
	Items []struct {
		Metadata struct{ Name, Namespace string }
		Spec     struct {
			Rules []struct {
				Host string
				HTTP struct {
					Paths []struct {
						Path    string
						Backend struct {
							Service struct {
								Name string
								Port struct{ Number int32 }
							}
						}
					}
				} `json:"http"`
			}
		}
	}
}

// IngressRoute is Traefik's own CRD, and it is what every route in this
// platform is written as. The built-in Ingress object is collected too, but by
// itself it showed one stale leftover and none of the eight real routes: the
// entire edge of the graph was missing while looking like there was nothing to
// show.
type routeList struct {
	Items []struct {
		Metadata struct{ Name, Namespace string }
		Spec     struct {
			Routes []struct {
				Match    string
				Priority int
				Services []struct {
					Name string
					Port int32
				}
			}
		}
	}
}

// Traefik writes its matchers as an expression, so the host and the path have
// to be read back out of it:
//
//	Host(`app.twentyfour.localhost`) && PathPrefix(`/api`)
var (
	matchHost = regexp.MustCompile("Host\\(`([^`]+)`\\)")
	matchPath = regexp.MustCompile("Path(?:Prefix)?\\(`([^`]+)`\\)")
)

// addrRef finds cluster service references in env values such as
// "postgres.twentyfour.svc.cluster.local:5432" or plain "redis:6379".
//
// The optional scheme is not decoration. A service given a gRPC neighbour
// writes host:port, and one given an HTTP neighbour writes a URL: Analytics
// reaches ClickHouse over its HTTP interface and is told so as
// "http://clickhouse...:8123". Matching only the bare form left the one edge
// between the reporting API and the store it reads from invisible.
var addrRef = regexp.MustCompile(`^(?:[a-z][a-z0-9+.-]*://)?([a-z0-9-]+)(?:\.([a-z0-9-]+))?(?:\.svc(?:\.cluster\.local)?)?:\d+/?$`)

func (s *server) Collect(namespaces []string) (*Graph, error) {
	g := &Graph{Nodes: []GNode{}, Edges: []GEdge{}, Problem: []string{},
		workloads: map[string]Workload{}}

	var pods podList
	if err := kubectlJSON(&pods, "get", "pods", "-A"); err != nil {
		return nil, err
	}
	var svcs svcList
	if err := kubectlJSON(&svcs, "get", "services", "-A"); err != nil {
		return nil, err
	}
	var eps epsList
	_ = kubectlJSON(&eps, "get", "endpointslices", "-A") // best effort
	var ings ingList
	_ = kubectlJSON(&ings, "get", "ingresses", "-A")
	var routes routeList
	// Best effort, and named in full: "ingressroutes" alone is ambiguous if
	// another CRD ever claims the short name.
	_ = kubectlJSON(&routes, "get", "ingressroutes.traefik.io", "-A")
	var deploys, sets workloadList
	_ = kubectlJSON(&deploys, "get", "deployments", "-A")
	_ = kubectlJSON(&sets, "get", "statefulsets", "-A")

	// Kafka Connect's connectors, which are the only wiring in this cluster
	// that a Deployment does not declare. See replicationEdges.
	var maps configMapList
	_ = kubectlJSON(&maps, "get", "configmaps", "-A")

	keep := func(ns string) bool {
		if len(namespaces) == 0 {
			return true
		}
		for _, n := range namespaces {
			if n == ns {
				return true
			}
		}
		return false
	}

	metrics := topPods()
	nsSet := map[string]bool{}
	// Which workloads have at least one pod, so the pass below can tell a
	// stopped one from a running one without asking the cluster twice.
	running := map[string]bool{}
	podID := func(ns, n string) string { return "pod/" + ns + "/" + n }
	svcID := func(ns, n string) string { return "svc/" + ns + "/" + n }

	// ---- pods -------------------------------------------------------------
	svcByName := map[string]string{} // "ns/name" -> id
	for _, s := range svcs.Items {
		if keep(s.Metadata.Namespace) {
			svcByName[s.Metadata.Namespace+"/"+s.Metadata.Name] = svcID(s.Metadata.Namespace, s.Metadata.Name)
		}
	}

	// depsOf draws the edges a workload's containers declare.
	//
	// From the flags they are started with, and from their environment. Both,
	// because how a service is told where its neighbours are is a choice each
	// one makes: every Go service here takes -auth=host:port, and reading only
	// the environment produced a topology with no edges between services at
	// all, which read as "nothing depends on anything" rather than "this
	// collector is looking in the wrong place".
	//
	// Taken as an argument rather than read off a pod, so a scaled-to-zero
	// workload still shows what it will talk to when it comes back.
	depsOf := func(ns, from, self string, containers []containerSpec) {
		seen := map[string]bool{}
		link := func(label, value string) {
			mm := addrRef.FindStringSubmatch(value)
			if mm == nil {
				return
			}
			target, tns := mm[1], ns
			if mm[2] != "" {
				tns = mm[2]
			}
			to, ok := svcByName[tns+"/"+target]
			// A workload does not depend on the service in front of itself.
			// The address is in its own flags because that is how it listens,
			// and an arrow back to its own service is a loop that says nothing.
			if !ok || (self != "" && to == svcByName[ns+"/"+self]) {
				return
			}
			if seen[to] {
				return
			}
			seen[to] = true
			g.Edges = append(g.Edges, GEdge{From: from, To: to, Kind: "depends", Label: label})
		}
		// A secret a workload mounts says where its state lives, which is a
		// dependency the flags never mention: the DSN is a reference, so its
		// value is not in the manifest at all.
		//
		// Which secret means which datastore is the one mapping here that is
		// not derived, and it is small on purpose: two secrets, named in the
		// manifests that create them.
		storeFor := map[string]string{"service-dsn": "postgres", "minio": "minio"}
		storeLink := func(secret, key string) {
			target, ok := storeFor[secret]
			if !ok {
				return
			}
			// A workload usually mounts several keys from one secret, and the
			// first one it happens to list is often a credential. "media uses
			// minio for MINIO_ROOT_USER" says nothing; "media uses minio for
			// the media bucket" says what the relationship is.
			if isCredential(key) {
				return
			}
			to, ok := svcByName[ns+"/"+target]
			if !ok || seen[to] {
				return
			}
			seen[to] = true
			// The key is the database name, which is what a reader wants to
			// know: "ledger" against postgres says which of the fifteen
			// databases in there is this service's.
			g.Edges = append(g.Edges, GEdge{From: from, To: to, Kind: "stores", Label: key})
		}

		for _, c := range containers {
			for _, e := range c.Env {
				link(strings.ToLower(strings.TrimSuffix(e.Name, "_ADDR")), e.Value)
				if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
					storeLink(e.ValueFrom.SecretKeyRef.Name, e.ValueFrom.SecretKeyRef.Key)
				}
			}
			for _, a := range append(append([]string{}, c.Command...), c.Args...) {
				// -auth=auth.twentyfour.svc.cluster.local:9102
				flag, value, ok := strings.Cut(strings.TrimLeft(a, "-"), "=")
				if !ok {
					continue
				}
				link(flag, value)
			}
		}
	}

	for _, p := range pods.Items {
		if !keep(p.Metadata.Namespace) {
			continue
		}
		nsSet[p.Metadata.Namespace] = true
		ownerKind := ""
		if len(p.Metadata.OwnerReferences) > 0 {
			ownerKind = p.Metadata.OwnerReferences[0].Kind
		}

		readyN, restarts := 0, 0
		var cs []Container
		for _, c := range p.Status.ContainerStatuses {
			state := "running"
			for k, v := range c.State {
				state = k
				if v.Reason != "" {
					state = v.Reason
				}
			}
			if c.Ready {
				readyN++
			}
			restarts += c.RestartCount
			cs = append(cs, Container{c.Name, c.Ready, c.RestartCount, shortImage(c.Image), state})
		}
		total := len(p.Status.ContainerStatuses)
		if total == 0 {
			total = len(p.Spec.Containers)
		}

		img, ports := "", []int32{}
		if len(p.Spec.Containers) > 0 {
			img = shortImage(p.Spec.Containers[0].Image)
			for _, pt := range p.Spec.Containers[0].Ports {
				ports = append(ports, pt.ContainerPort)
			}
		}

		id := podID(p.Metadata.Namespace, p.Metadata.Name)
		m := metrics[p.Metadata.Namespace+"/"+p.Metadata.Name]
		podRole := role(p.Metadata.Namespace, p.Metadata.Name, ownerKind, p.Metadata.Labels)
		deployment := workloadName(p.Metadata.Name, p.Metadata.Labels)
		w := s.describe(p.Metadata.Namespace, deployment, podRole)
		g.workloads[w.Name] = w
		running[p.Metadata.Namespace+"/"+deployment] = true
		g.Nodes = append(g.Nodes, GNode{
			ID: id, Name: p.Metadata.Name, Kind: "pod", Namespace: p.Metadata.Namespace,
			Phase: p.Status.Phase, Ready: readyN == total && total > 0,
			ReadyStr: itoa(readyN) + "/" + itoa(total), Restarts: restarts,
			Image: img, NodeName: p.Spec.NodeName, PodIP: p.Status.PodIP,
			Age: age(p.Metadata.CreationTimestamp), CPU: m.CPU, Mem: m.Mem,
			Role:       podRole,
			Containers: cs, Ports: ports,
			Deployment: deployment, Workload: w.Name, Moves: w.Moves(),
			Purpose: w.Purpose, Domain: w.Domain, Actions: w.Actions,
		})

		if p.Status.Phase == "Succeeded" {
			// Completed Jobs are 0/N ready by definition, not a fault.
		} else if p.Status.Phase != "Running" {
			g.Problem = append(g.Problem, p.Metadata.Namespace+"/"+p.Metadata.Name+" is "+p.Status.Phase)
		} else if readyN != total {
			g.Problem = append(g.Problem, p.Metadata.Namespace+"/"+p.Metadata.Name+" not ready ("+itoa(readyN)+"/"+itoa(total)+")")
		}

		depsOf(p.Metadata.Namespace, id, p.Metadata.Labels["app"], p.Spec.Containers)
	}

	// ---- services ---------------------------------------------------------
	for _, s := range svcs.Items {
		if !keep(s.Metadata.Namespace) {
			continue
		}
		nsSet[s.Metadata.Namespace] = true
		var ports []int32
		for _, p := range s.Spec.Ports {
			ports = append(ports, p.Port)
		}
		g.Nodes = append(g.Nodes, GNode{
			ID: svcID(s.Metadata.Namespace, s.Metadata.Name), Name: s.Metadata.Name,
			Kind: "service", Namespace: s.Metadata.Namespace, Ready: true,
			PodIP: s.Spec.ClusterIP, Role: "service", Ports: ports,
		})
	}

	// ---- service -> pod, from endpointslices ------------------------------
	for _, e := range eps.Items {
		if !keep(e.Metadata.Namespace) {
			continue
		}
		sname := e.Metadata.Labels["kubernetes.io/service-name"]
		if sname == "" {
			continue
		}
		from := svcID(e.Metadata.Namespace, sname)
		for _, ep := range e.Endpoints {
			if ep.TargetRef == nil || ep.TargetRef.Kind != "Pod" {
				continue
			}
			g.Edges = append(g.Edges, GEdge{From: from, To: podID(e.Metadata.Namespace, ep.TargetRef.Name), Kind: "selects"})
		}
	}

	// ---- ingress -> service ----------------------------------------------
	for _, in := range ings.Items {
		if !keep(in.Metadata.Namespace) {
			continue
		}
		id := "ing/" + in.Metadata.Namespace + "/" + in.Metadata.Name
		host := ""
		if len(in.Spec.Rules) > 0 {
			host = in.Spec.Rules[0].Host
		}
		g.Nodes = append(g.Nodes, GNode{
			ID: id, Name: in.Metadata.Name, Kind: "ingress", Namespace: in.Metadata.Namespace,
			Ready: true, Role: "edge", Image: host,
		})
		for _, r := range in.Spec.Rules {
			for _, p := range r.HTTP.Paths {
				if to, ok := svcByName[in.Metadata.Namespace+"/"+p.Backend.Service.Name]; ok {
					g.Edges = append(g.Edges, GEdge{From: id, To: to, Kind: "routes", Label: p.Path})
				}
			}
		}
	}

	// ---- Traefik IngressRoute -> service ----------------------------------
	for _, r := range routes.Items {
		if !keep(r.Metadata.Namespace) {
			continue
		}
		id := "ing/" + r.Metadata.Namespace + "/" + r.Metadata.Name
		host := ""
		for _, rt := range r.Spec.Routes {
			if m := matchHost.FindStringSubmatch(rt.Match); m != nil && host == "" {
				host = m[1]
			}
		}
		g.Nodes = append(g.Nodes, GNode{
			ID: id, Name: r.Metadata.Name, Kind: "ingress", Namespace: r.Metadata.Namespace,
			Ready: true, Role: "edge", Image: host,
		})
		for _, rt := range r.Spec.Routes {
			path := "/"
			if m := matchPath.FindStringSubmatch(rt.Match); m != nil {
				path = m[1]
			}
			for _, svc := range rt.Services {
				if to, ok := svcByName[r.Metadata.Namespace+"/"+svc.Name]; ok {
					g.Edges = append(g.Edges, GEdge{From: id, To: to, Kind: "routes", Label: path})
				}
			}
		}
	}

	// ---- stopped workloads ------------------------------------------------
	//
	// "down" scales to zero rather than deleting, so a stopped service is a
	// Deployment with no pods at all. Drawing only pods made it disappear from
	// the graph the moment it was stopped, which left the start button on a
	// screen that no longer had anything to press it on. It is drawn here in
	// its own right: no pod detail, because there is no pod, but the same
	// identity, the same dependencies read off its template, and the same
	// actions, so it can be started from where it was stopped.
	for _, set := range []struct {
		items workloadList
		kind  string
	}{{deploys, "Deployment"}, {sets, "StatefulSet"}} {
		for _, d := range set.items.Items {
			ns, name := d.Metadata.Namespace, d.Metadata.Name
			if !keep(ns) || running[ns+"/"+name] {
				continue
			}
			nsSet[ns] = true
			labels := d.Spec.Template.Metadata.Labels
			r := role(ns, name, set.kind, labels)
			w := s.describe(ns, name, r)
			g.workloads[w.Name] = w

			want := 0
			if d.Spec.Replicas != nil {
				want = *d.Spec.Replicas
			}
			// Only the actions that mean something on a thing that is already
			// down. Stop is not offered because it is already stopped, and a
			// button that does nothing teaches people the buttons lie.
			actions := w.Actions
			if len(actions) > 0 {
				actions = []string{}
				for _, a := range w.Actions {
					if a != "stop" && a != "restart" {
						actions = append(actions, a)
					}
				}
			}

			id := "wl/" + ns + "/" + name
			img := ""
			var ports []int32
			if cs := d.Spec.Template.Spec.Containers; len(cs) > 0 {
				img = shortImage(cs[0].Image)
				for _, pt := range cs[0].Ports {
					ports = append(ports, pt.ContainerPort)
				}
			}
			g.Nodes = append(g.Nodes, GNode{
				ID: id, Name: name, Kind: "pod", Namespace: ns,
				Phase: "Stopped", Stopped: true, Desired: want,
				ReadyStr: "0/" + itoa(max(want, 1)), Image: img, Ports: ports,
				Age: age(d.Metadata.CreationTimestamp), Role: r,
				Deployment: name, Workload: w.Name, Moves: w.Moves(),
				Purpose: w.Purpose, Domain: w.Domain, Actions: actions,
			})

			// The Service in front of it has no endpoints while it is down, so
			// there is no endpointslice to draw the edge from. Matched on the
			// selector instead: that Service does select this workload, it just
			// has nothing to select right now. Without this the node has no
			// parent and the layout files it in the top row beside the ingress
			// controllers, which is the one place it does not belong.
			for _, svc := range svcs.Items {
				if svc.Metadata.Namespace != ns || len(svc.Spec.Selector) == 0 {
					continue
				}
				if selects(svc.Spec.Selector, labels) {
					g.Edges = append(g.Edges, GEdge{
						From: svcID(ns, svc.Metadata.Name), To: id, Kind: "selects"})
				}
			}

			depsOf(ns, id, labels["app"], d.Spec.Template.Spec.Containers)
			g.Problem = append(g.Problem, ns+"/"+name+" is stopped")
		}
	}

	s.eventEdges(g, svcByName)
	replicationEdges(g, maps, svcByName)
	annotateStores(g)

	for _, n := range g.Nodes {
		switch n.Kind {
		case "pod":
			// A completed Job is not a pod waiting to become ready. Counting it
			// in the fraction made the headline read "27/29, some not ready"
			// beside a problem list saying everything was healthy, and the
			// problem list was the one telling the truth.
			if n.Phase == "Succeeded" {
				g.Stats.Completed++
				continue
			}
			// A stopped workload is not a pod failing to become ready. Counting
			// it in the ready fraction would make a deliberate "make pos-down"
			// read as a fault.
			if n.Stopped {
				g.Stats.Stopped++
				continue
			}
			g.Stats.Pods++
			if n.Ready {
				g.Stats.PodsReady++
			}
			g.Stats.Restarts += n.Restarts
		case "service":
			g.Stats.Services++
		case "ingress":
			g.Stats.Ingresses++
		}
	}
	g.Stats.Namespaces = len(nsSet)
	g.At = time.Now()
	sort.Slice(g.Nodes, func(i, j int) bool { return g.Nodes[i].ID < g.Nodes[j].ID })
	sort.Strings(g.Problem)
	return g, nil
}

// topPods reads metrics-server output; absent metrics are simply blank.
func topPods() map[string]Metric {
	out := map[string]Metric{}
	b, err := exec.Command("kubectl", "top", "pods", "-A", "--no-headers").Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 4 {
			out[f[0]+"/"+f[1]] = Metric{CPU: f[2], Mem: f[3]}
		}
	}
	return out
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

// selects reports whether a Service's selector matches a pod template's labels.
func selects(selector, labels map[string]string) bool {
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}

// eventEdges draws what the bus carries.
//
// Without these the topology showed every service that touches Kafka as
// depending on it in the same undifferentiated way, which made the single most
// interesting thing about this system invisible: that a sale rung up at the
// till reaches the ledger, the kitchen and the audit trail without any of them
// calling the till or the till knowing they exist.
//
// Three edges, and they are three different relationships rather than one.
//
// A publisher points at the relay, not at Kafka, because that is the path an
// event actually takes: the service writes a row to its own outbox inside the
// transaction that changed something, and the relay drains it later. Drawing
// the service straight to Kafka would contradict the rule the whole design
// rests on, which is that nothing writes to Kafka except the relay.
//
// The relay points at Kafka, because it is the one thing that does.
//
// Kafka points at each consumer, labelled with what that consumer asked for.
// The arrow runs that way round because the consumer pulls: it is the only
// edge in this graph where the thing being pointed at initiated nothing.
func (s *server) eventEdges(g *Graph, svcByName map[string]string) {
	if len(s.eventing) == 0 {
		return
	}
	// The workload node for a service, so the edge lands on the pod rather than
	// on the Service in front of it. An event does not go through a cluster IP.
	nodeFor := map[string]string{}
	for _, n := range g.Nodes {
		if n.Kind == "pod" && n.Workload != "" {
			// First one wins: a scaled-up workload has one pod here, and a
			// replicated one would otherwise draw the same edge twice.
			if _, seen := nodeFor[n.Workload]; !seen {
				nodeFor[n.Workload] = n.ID
			}
		}
	}
	relay, hasRelay := nodeFor["relay"]

	for name, e := range s.eventing {
		from, ok := nodeFor[name]
		if !ok {
			continue
		}
		if hasRelay && len(e.Publishes) > 0 && from != relay {
			g.Edges = append(g.Edges, GEdge{
				From: from, To: relay, Kind: "publishes",
				Label: summarise(e.Publishes),
			})
		}
		switch {
		case e.ConsumesEverything:
			if kafka, ok := nodeFor["kafka"]; ok {
				g.Edges = append(g.Edges, GEdge{
					From: kafka, To: from, Kind: "consumes", Label: "every announcement",
				})
			}
		case len(e.Consumes) > 0:
			if kafka, ok := nodeFor["kafka"]; ok {
				g.Edges = append(g.Edges, GEdge{
					From: kafka, To: from, Kind: "consumes", Label: summarise(e.Consumes),
				})
			}
		}
	}

	// The relay to the bus. Drawn from what the relay is rather than from a
	// scan of its source, because it publishes everybody's events and names
	// none of them itself.
	if kafka, ok := nodeFor["kafka"]; ok && hasRelay {
		g.Edges = append(g.Edges, GEdge{
			From: relay, To: kafka, Kind: "publishes", Label: "every outbox",
		})
	}
}

// isCredential reports whether a secret key is a username or a password rather
// than the name of the thing being reached.
func isCredential(key string) bool {
	k := strings.ToLower(key)
	for _, word := range []string{"user", "password", "secret", "token", "key", "access"} {
		if strings.Contains(k, word) {
			return true
		}
	}
	return false
}

// configMapList is read for one thing: the connector definitions.
type configMapList struct {
	Items []struct {
		Metadata struct{ Name, Namespace string }
		Data     map[string]string
	}
}

// connectorConfig pulls the settings out of a connector definition.
//
// Connect's REST API accepts two shapes: the settings flat at the top level,
// or wrapped in a "config" object beside a name. This repository writes the
// flat form and the wrapped form is what most documentation shows, so both are
// read rather than one being assumed. Assuming the wrapped one is what made
// this find nothing at all on the first attempt: every definition parsed
// cleanly and every one came back empty.
func connectorConfig(body string) map[string]any {
	var raw map[string]any
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		return nil
	}
	if wrapped, ok := raw["config"].(map[string]any); ok {
		return wrapped
	}
	return raw
}

// replicationEdges draws the change data capture pipeline.
//
// Without it ClickHouse has exactly one edge, and it is the reader: Analytics
// querying a store that, on the picture, nothing fills. The pipeline that
// actually fills it is invisible, because it is the one piece of wiring in
// this cluster that is not declared in a Deployment. A Connect worker is
// started with nothing but its broker address; what it captures and where it
// writes are connector definitions posted to its REST API, and they live in a
// ConfigMap.
//
// So this reads that ConfigMap. Still `kubectl get`, still read-only, and it
// finds the connectors by shape rather than by name: any ConfigMap value that
// parses as JSON carrying a connector.class is one, which means a fourth
// connector appears here the day it is added.
//
// The edges run in the direction the data moves rather than the direction the
// connection is opened. Debezium dials Postgres and the sink dials ClickHouse,
// so drawing calls would point both arrows out of Connect and leave ClickHouse
// looking like a dependency of the pipeline rather than the thing at the end
// of it.
func replicationEdges(g *Graph, maps configMapList, svcByName map[string]string) {
	// The Connect workload, found by the connector definitions living beside
	// it rather than by its name.
	connectNode := ""
	for _, n := range g.Nodes {
		if n.Kind == "pod" && n.Workload == "connect" {
			connectNode = n.ID
			break
		}
	}
	if connectNode == "" {
		return
	}

	captured := map[string][]string{} // service id -> databases read
	written := map[string][]string{}  // service id -> databases written

	for _, cm := range maps.Items {
		for _, body := range cm.Data {
			config := connectorConfig(body)
			if config == nil {
				continue
			}
			// Found by shape rather than by name: a value carrying a
			// connector.class is a connector, so a fourth one appears here the
			// day it is added.
			if class, _ := config["connector.class"].(string); class == "" {
				continue
			}
			text := func(key string) string {
				v, _ := config[key].(string)
				return v
			}
			// A source reads a database; a sink writes one. The field names
			// differ per connector, so both spellings are tried and whichever
			// answers is the endpoint.
			if host := text("database.hostname"); host != "" {
				if to, ok := svcByName[cm.Metadata.Namespace+"/"+host]; ok {
					captured[to] = appendOnce(captured[to], text("database.dbname"))
				}
				continue
			}
			if host := text("hostname"); host != "" {
				if to, ok := svcByName[cm.Metadata.Namespace+"/"+host]; ok {
					written[to] = appendOnce(written[to], text("database"))
				}
			}
		}
	}

	for from, dbs := range captured {
		sort.Strings(dbs)
		g.Edges = append(g.Edges, GEdge{
			From: from, To: connectNode, Kind: "replicates", Label: summarise(dbs),
		})
	}
	for to, dbs := range written {
		sort.Strings(dbs)
		g.Edges = append(g.Edges, GEdge{
			From: connectNode, To: to, Kind: "replicates", Label: summarise(dbs),
		})
	}
}

// annotateStores says how many separate databases a datastore actually holds.
//
// Nineteen arrows converging on one box called "postgres" reads as nineteen
// services sharing a database, which is the exact anti-pattern this
// architecture forbids and the opposite of what is true: each of those arrows
// is a different database, and no service holds a credential for any but its
// own. The isolation is logical, and a picture cannot show a logical boundary
// unless something says so.
//
// Counted from the edges rather than by asking Postgres, so it stays a
// read-only collector and so the number is the one the graph is drawing.
func annotateStores(g *Graph) {
	holds := map[string]map[string]bool{}
	for _, e := range g.Edges {
		if e.Kind != "stores" || e.Label == "" {
			continue
		}
		if holds[e.To] == nil {
			holds[e.To] = map[string]bool{}
		}
		holds[e.To][e.Label] = true
	}
	for i, n := range g.Nodes {
		names, ok := holds[n.ID]
		if !ok || len(names) < 2 {
			continue
		}
		g.Nodes[i].Purpose = fmt.Sprintf(
			"%d separate databases, one per service, in one server. No service holds "+
				"a credential for any but its own, so the arrows into here do not cross.",
			len(names))
	}
}

// summarise keeps an edge label readable. Four topic names is already more than
// fits beside a line, and the exact list is on the node.
func summarise(topics []string) string {
	if len(topics) <= 2 {
		return strings.Join(topics, ", ")
	}
	return fmt.Sprintf("%s and %d more", topics[0], len(topics)-1)
}
