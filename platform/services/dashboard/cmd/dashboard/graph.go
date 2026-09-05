package main

import (
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

type podList struct {
	Items []struct {
		Metadata struct {
			Name, Namespace, CreationTimestamp string
			OwnerReferences                    []struct{ Kind, Name string }
			Labels                             map[string]string
		}
		Spec struct {
			NodeName   string
			Containers []struct {
				Name, Image string
				Env         []struct{ Name, Value string }
				Ports       []struct {
					ContainerPort int32
				}
			}
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

// addrRef finds cluster service references in env values such as
// "postgres.twentyfour.svc.cluster.local:5432" or plain "redis:6379".
var addrRef = regexp.MustCompile(`^([a-z0-9-]+)(?:\.([a-z0-9-]+))?(?:\.svc(?:\.cluster\.local)?)?:\d+$`)

func Collect(namespaces []string) (*Graph, error) {
	g := &Graph{Nodes: []GNode{}, Edges: []GEdge{}, Problem: []string{}}

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
	podID := func(ns, n string) string { return "pod/" + ns + "/" + n }
	svcID := func(ns, n string) string { return "svc/" + ns + "/" + n }

	// ---- pods -------------------------------------------------------------
	svcByName := map[string]string{} // "ns/name" -> id
	for _, s := range svcs.Items {
		if keep(s.Metadata.Namespace) {
			svcByName[s.Metadata.Namespace+"/"+s.Metadata.Name] = svcID(s.Metadata.Namespace, s.Metadata.Name)
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
		g.Nodes = append(g.Nodes, GNode{
			ID: id, Name: p.Metadata.Name, Kind: "pod", Namespace: p.Metadata.Namespace,
			Phase: p.Status.Phase, Ready: readyN == total && total > 0,
			ReadyStr: itoa(readyN) + "/" + itoa(total), Restarts: restarts,
			Image: img, NodeName: p.Spec.NodeName, PodIP: p.Status.PodIP,
			Age: age(p.Metadata.CreationTimestamp), CPU: m.CPU, Mem: m.Mem,
			Role: role(p.Metadata.Namespace, p.Metadata.Name, ownerKind), Containers: cs, Ports: ports,
		})

		if p.Status.Phase == "Succeeded" {
			// Completed Jobs are 0/N ready by definition — not a fault.
		} else if p.Status.Phase != "Running" {
			g.Problem = append(g.Problem, p.Metadata.Namespace+"/"+p.Metadata.Name+" is "+p.Status.Phase)
		} else if readyN != total {
			g.Problem = append(g.Problem, p.Metadata.Namespace+"/"+p.Metadata.Name+" not ready ("+itoa(readyN)+"/"+itoa(total)+")")
		}

		// ---- declared dependencies, read from env ------------------------
		for _, c := range p.Spec.Containers {
			for _, e := range c.Env {
				mm := addrRef.FindStringSubmatch(e.Value)
				if mm == nil {
					continue
				}
				target, tns := mm[1], p.Metadata.Namespace
				if mm[2] != "" {
					tns = mm[2]
				}
				if to, ok := svcByName[tns+"/"+target]; ok {
					g.Edges = append(g.Edges, GEdge{
						From: id, To: to, Kind: "depends",
						Label: strings.ToLower(strings.TrimSuffix(e.Name, "_ADDR")),
					})
				}
			}
		}
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

	for _, n := range g.Nodes {
		switch n.Kind {
		case "pod":
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
