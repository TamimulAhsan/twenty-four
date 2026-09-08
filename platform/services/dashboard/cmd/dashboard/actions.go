package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Starting, stopping and rebuilding a workload.
//
// This is the one place the monitor stops being read-only, and it is worth
// being explicit about what that means: it runs the same scripts the Makefile
// runs, as you, with your kubeconfig. It does not reimplement them. "Bring the
// till up" already has a definition in web-app.sh and service.sh, and a second
// one here would drift from the first the day either changed.
//
// Nothing here can reach a cluster you could not already reach from a shell.

// JobView is what a job looks like on the wire: plain data, safe to copy.
//
// Separate from Job because Job carries the lock that guards its growing
// output, and a value copy of a lock is a lock that guards nothing. go vet
// says so, which is how this was caught rather than deduced.
type JobView struct {
	ID       string    `json:"id"`
	Workload string    `json:"workload"`
	Action   string    `json:"action"`
	State    string    `json:"state"` // running | done | failed
	Output   string    `json:"output"`
	Started  time.Time `json:"started"`
}

// A rebuild builds an image from source and rolls it out, which takes minutes.
// So an action is a job with an id and a growing log, not a request that waits.
type Job struct {
	view JobView
	mu   sync.Mutex
}

func (j *Job) snapshot() JobView {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.view
}

func (j *Job) append(line string) {
	j.mu.Lock()
	j.view.Output += line + "\n"
	j.mu.Unlock()
}

func (j *Job) finish(state string) {
	j.mu.Lock()
	j.view.State = state
	j.mu.Unlock()
}

type jobs struct {
	mu sync.Mutex
	m  map[string]*Job
	// One at a time. Two rebuilds of the same image racing each other is a
	// coin toss over which one the registry ends up with, and two rollouts of
	// different services at once is simply harder to read in the log.
	busy bool
}

func newJobs() *jobs { return &jobs{m: map[string]*Job{}} }

func (s *jobs) get(id string) (JobView, bool) {
	s.mu.Lock()
	j, ok := s.m[id]
	s.mu.Unlock()
	if !ok {
		return JobView{}, false
	}
	return j.snapshot(), true
}

// start runs one action. It refuses while another is in flight.
func (s *jobs) start(w Workload, action string, run func(*Job) error) (JobView, error) {
	s.mu.Lock()
	if s.busy {
		s.mu.Unlock()
		return JobView{}, fmt.Errorf("another action is already running: wait for it to finish")
	}
	s.busy = true
	j := &Job{view: JobView{
		ID:       fmt.Sprintf("%d", time.Now().UnixNano()),
		Workload: w.Name, Action: action, State: "running", Started: time.Now(),
	}}
	s.m[j.view.ID] = j
	s.mu.Unlock()

	go func() {
		err := run(j)
		if err != nil {
			j.append("")
			j.append("failed: " + err.Error())
			j.finish("failed")
		} else {
			j.finish("done")
		}
		s.mu.Lock()
		s.busy = false
		s.mu.Unlock()
	}()

	return j.snapshot(), nil
}

// command builds the shell steps for one action on one workload.
//
// A surface with two halves produces steps for both, which is the whole point:
// stopping "pos" and leaving its frontend serving a dead API is the failure
// this replaced. The halves are ordered rather than interleaved — every part
// goes down before any part comes back up — so a restart never has the new
// frontend talking to the old API for a few seconds.
//
// Rebuild is stop, build, start, which is what the flag on the scripts already
// means: REBUILD=1 makes "up" build from source first. It is spelled out as
// separate steps rather than one so the log says which part is slow, because
// the build is the part that takes minutes and a reader watching a silent
// spinner has no way to know that.
func (w Workload) command(action string) ([][]string, error) {
	if !w.allows(action) {
		return nil, fmt.Errorf("%s does not accept %q", w.Name, action)
	}
	if len(w.Parts) == 0 {
		return nil, fmt.Errorf("nothing here can act on %s", w.Name)
	}

	// A datastore is not ours to build and its volume outlives the pod, so it
	// is never part of a surface and only ever restarted in place.
	if w.Parts[0].Runner == "kubectl" {
		if action != "restart" {
			return nil, fmt.Errorf("%s only accepts restart", w.Name)
		}
		t := w.Parts[0].Target
		return [][]string{
			{"kubectl", "-n", "twentyfour", "rollout", "restart", "statefulset/" + t},
			{"kubectl", "-n", "twentyfour", "rollout", "status", "statefulset/" + t, "--timeout=180s"},
		}, nil
	}

	down := func() [][]string {
		var out [][]string
		for _, p := range w.Parts {
			out = append(out, []string{"./scripts/" + p.Runner, "down", p.Target})
		}
		return out
	}
	up := func() [][]string {
		var out [][]string
		for _, p := range w.Parts {
			out = append(out, []string{"./scripts/" + p.Runner, "up", p.Target})
		}
		return out
	}
	build := func() [][]string {
		var out [][]string
		for _, p := range w.Parts {
			out = append(out, []string{"REBUILD=1", "./scripts/" + p.Runner, "build", p.Target})
		}
		return out
	}

	switch action {
	case "stop":
		return down(), nil
	case "start":
		return up(), nil
	case "restart":
		return append(down(), up()...), nil
	case "rebuild":
		steps := append(down(), build()...)
		for _, u := range up() {
			steps = append(steps, append([]string{"REBUILD=1"}, u...))
		}
		return steps, nil
	}
	return nil, fmt.Errorf("nothing here can act on %s", w.Name)
}

// scrubbed drops the variables an action must decide for itself.
func scrubbed(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, "REBUILD=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func (w Workload) allows(action string) bool {
	for _, a := range w.Actions {
		if a == action {
			return true
		}
	}
	return false
}

// runSteps executes each step in order, streaming its output into the job.
func runSteps(j *Job, steps [][]string) error {
	for _, step := range steps {
		env := []string{}
		for len(step) > 0 && strings.Contains(step[0], "=") {
			env = append(env, step[0])
			step = step[1:]
		}
		j.append("$ " + strings.Join(append(env, step...), " "))

		cmd := exec.Command(step[0], step[1:]...)
		// The environment is built, not inherited wholesale. REBUILD is the
		// reason: the scripts read it, and this process picked one up from
		// whatever shell started it, so a monitor launched with
		// `make monitoring-up REBUILD=1` turned every later "restart" into a
		// rebuild without saying so. An action means what its own name says,
		// whatever the process was started with.
		cmd.Env = append(scrubbed(cmd.Environ()), env...)
		out, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		cmd.Stderr = cmd.Stdout
		if err := cmd.Start(); err != nil {
			return err
		}
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			j.append(sc.Text())
		}
		if err := cmd.Wait(); err != nil {
			return err
		}
	}
	j.append("")
	j.append("done")
	return nil
}
