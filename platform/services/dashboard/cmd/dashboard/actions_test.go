package main

import (
	"strings"
	"testing"
)

// steps flattens the command list into one string per step, which is what the
// job log shows and what these tests are actually about.
func steps(t *testing.T, w Workload, action string) []string {
	t.Helper()
	cmds, err := w.command(action)
	if err != nil {
		t.Fatalf("%s %s: %v", w.Name, action, err)
	}
	out := make([]string, 0, len(cmds))
	for _, c := range cmds {
		out = append(out, strings.Join(c, " "))
	}
	return out
}

// A data-tier workload is restarted as whatever kind it actually is.
//
// This is a regression test with a specific history: the kind was hard-coded as
// statefulset, which is true of Postgres, Kafka, ClickHouse and MinIO and false
// of Redis and Kafka Connect. Both of those are Deployments, so the one button
// they offer failed with "statefulsets.apps not found" — a button that always
// failed, on the two data-tier workloads most likely to need a kick.
func TestDatastoreRestartUsesTheRightKind(t *testing.T) {
	for _, tc := range []struct{ name, kind, want string }{
		{"postgres", "StatefulSet", "statefulset/postgres"},
		{"kafka", "StatefulSet", "statefulset/kafka"},
		{"redis", "Deployment", "deployment/redis"},
		{"connect", "Deployment", "deployment/connect"},
	} {
		w := Workload{
			Name:    tc.name,
			Parts:   []Part{{Deployment: tc.name, Runner: "kubectl", Target: tc.name, Half: "store", Kind: tc.kind}},
			Actions: []string{"restart"},
		}
		got := steps(t, w, "restart")
		if len(got) != 2 {
			t.Fatalf("%s: want restart then status, got %v", tc.name, got)
		}
		for _, step := range got {
			if !strings.Contains(step, tc.want) {
				t.Errorf("%s: step %q does not name %s", tc.name, step, tc.want)
			}
		}
	}
}

// A data-tier workload offers restart and refuses everything else, because its
// image is not built from this repository and its volume outlives the pod.
func TestDatastoreRefusesEverythingButRestart(t *testing.T) {
	w := Workload{
		Name:    "postgres",
		Parts:   []Part{{Deployment: "postgres", Runner: "kubectl", Target: "postgres", Kind: "StatefulSet"}},
		Actions: []string{"restart"},
	}
	for _, action := range []string{"stop", "start", "rebuild"} {
		if _, err := w.command(action); err == nil {
			t.Errorf("postgres accepted %q", action)
		}
	}
}

// A paired surface moves both halves, and every part goes down before any part
// comes back up. Interleaving them would leave the new frontend talking to the
// old API for a few seconds on every restart.
func TestPairedSurfaceMovesBothHalvesDownBeforeUp(t *testing.T) {
	w := pos()
	got := steps(t, w, "restart")
	want := []string{
		"./scripts/web-app.sh down pos",
		"./scripts/service.sh down pos",
		"./scripts/web-app.sh up pos",
		"./scripts/service.sh up pos",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d steps, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("step %d: got %q, want %q", i, got[i], want[i])
		}
	}
}

// Rebuild is stop, build, start, with REBUILD=1 on the halves that consult it.
// The scripts reuse the image in the registry unless told otherwise, so a
// rebuild that forgot the flag would roll out the image it was replacing and
// report success.
func TestRebuildForcesABuildOnEveryBuildingStep(t *testing.T) {
	got := steps(t, pos(), "rebuild")
	for _, step := range got {
		wantsFlag := strings.Contains(step, " build ") || strings.Contains(step, " up ")
		hasFlag := strings.HasPrefix(step, "REBUILD=1 ")
		if wantsFlag != hasFlag {
			t.Errorf("step %q: REBUILD=1 present=%v, wanted=%v", step, hasFlag, wantsFlag)
		}
	}
}

// scrubbed drops an inherited REBUILD so an action means what its own name
// says, whatever shell started the monitor.
func TestScrubbedDropsInheritedRebuild(t *testing.T) {
	got := scrubbed([]string{"PATH=/usr/bin", "REBUILD=1", "HOME=/home/x"})
	for _, kv := range got {
		if strings.HasPrefix(kv, "REBUILD=") {
			t.Fatalf("REBUILD survived scrubbing: %v", got)
		}
	}
	if len(got) != 2 {
		t.Errorf("dropped more than REBUILD: %v", got)
	}
}

func pos() Workload {
	return Workload{
		Name: "pos",
		Parts: []Part{
			{Deployment: "web-pos", Runner: "web-app.sh", Target: "pos", Half: "web", Kind: "Deployment"},
			{Deployment: "pos", Runner: "service.sh", Target: "pos", Half: "api", Kind: "Deployment"},
		},
		Actions: []string{"stop", "start", "restart", "rebuild"},
	}
}
