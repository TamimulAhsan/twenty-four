package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Graph is what the UI renders: nodes are cluster objects, edges are the real
// relationships between them, all derived from the live cluster.
type Graph struct {
	At      time.Time         `json:"at"`
	Nodes   []GNode           `json:"nodes"`
	Edges   []GEdge           `json:"edges"`
	Stats   Stats             `json:"stats"`
	Problem []string          `json:"problems"`
	Metrics map[string]Metric `json:"-"`
}

type GNode struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	Kind       string      `json:"kind"` // ingress | service | pod | external
	Namespace  string      `json:"namespace"`
	Phase      string      `json:"phase"`
	Ready      bool        `json:"ready"`
	ReadyStr   string      `json:"readyStr"`
	Restarts   int         `json:"restarts"`
	Image      string      `json:"image"`
	NodeName   string      `json:"nodeName"`
	PodIP      string      `json:"podIP"`
	Age        string      `json:"age"`
	CPU        string      `json:"cpu"`
	Mem        string      `json:"mem"`
	Role       string      `json:"role"` // app | datastore | edge | system
	Containers []Container `json:"containers"`
	Ports      []int32     `json:"ports"`
}

type Container struct {
	Name     string `json:"name"`
	Ready    bool   `json:"ready"`
	Restarts int    `json:"restarts"`
	Image    string `json:"image"`
	State    string `json:"state"`
}

type GEdge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Kind  string `json:"kind"` // routes | selects | depends
	Label string `json:"label"`
}

type Stats struct {
	Pods, PodsReady, Services, Ingresses, Restarts int
	Namespaces                                     int
}

type Metric struct{ CPU, Mem string }

// kubectlJSON runs kubectl and decodes the result into v.
func kubectlJSON(v any, args ...string) error {
	args = append(args, "-o", "json")
	out, err := exec.Command("kubectl", args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if ok := asExit(err, &ee); ok && len(ee.Stderr) > 0 {
			return fmt.Errorf("kubectl %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return fmt.Errorf("kubectl %s: %w", strings.Join(args, " "), err)
	}
	return json.Unmarshal(out, v)
}

func asExit(err error, target **exec.ExitError) bool {
	if ee, ok := err.(*exec.ExitError); ok {
		*target = ee
		return true
	}
	return false
}

func age(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ""
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// role classifies a workload so the UI can lay it out and colour it sensibly.
func role(ns, name string, ownerKind string) string {
	switch {
	case ns == "kube-system":
		return "system"
	case ownerKind == "StatefulSet":
		return "datastore"
	}
	for _, d := range []string{"postgres", "redis", "kafka", "clickhouse", "minio"} {
		if strings.Contains(name, d) {
			return "datastore"
		}
	}
	return "app"
}

func shortImage(img string) string {
	if i := strings.LastIndex(img, "/"); i >= 0 {
		img = img[i+1:]
	}
	if i := strings.Index(img, "@"); i >= 0 {
		img = img[:i]
	}
	return img
}

func kubectlText(args ...string) (string, error) {
	out, err := exec.Command("kubectl", args...).CombinedOutput()
	return string(out), err
}
