package store

import (
	"testing"
	"time"
)

func at(offset time.Duration) *time.Time {
	t := time.Now().Add(offset)
	return &t
}

func TestOnlyALiveGrantIsUsable(t *testing.T) {
	// Nobody approves these in advance, so a grant is written live. What is
	// left to check is that it stops being live, and that it stops on its own.
	now := time.Now()
	cases := []struct {
		name string
		req  Request
		want bool
	}{
		{"live and in date", Request{State: "approved", ExpiresAt: at(time.Hour)}, true},
		{"live and run out", Request{State: "approved", ExpiresAt: at(-time.Minute)}, false},
		// The one that matters: expiry is a property of the grant, checked on
		// every use, not a state somebody has to remember to write. A grant
		// with no expiry is permanent access, which is the one thing this must
		// never produce.
		{"live with no expiry", Request{State: "approved"}, false},
		{"taken back by the merchant", Request{State: "revoked", ExpiresAt: at(time.Hour)}, false},
		{"expired", Request{State: "expired", ExpiresAt: at(-time.Hour)}, false},
	}
	for _, c := range cases {
		if got := c.req.Usable(now); got != c.want {
			t.Errorf("%s: usable = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestASessionStopsAtItsExpiryWhetherOrNotAnybodyEndedIt(t *testing.T) {
	now := time.Now()
	// A console tab left open overnight is the case this covers. Nobody clicked
	// anything, and the session must stop working anyway.
	stale := Session{ExpiresAt: now.Add(-time.Minute)}
	if stale.Active(now) {
		t.Fatal("a session past its expiry is still active")
	}
	live := Session{ExpiresAt: now.Add(time.Hour)}
	if !live.Active(now) {
		t.Fatal("a session inside its window is not active")
	}
	ended := Session{ExpiresAt: now.Add(time.Hour), EndedAt: at(-time.Minute)}
	if ended.Active(now) {
		t.Fatal("an ended session is still active")
	}
}
