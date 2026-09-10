package slots

import (
	"testing"
	"time"
)

func budapest(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Budapest")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	return loc
}

func day(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.ParseInLocation("2006-01-02", s, budapest(t))
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return d
}

func chair(opening ...Window) Resource {
	return Resource{ID: "r1", Name: "Chair one", Capacity: 1, Opening: opening}
}

// 2026-03-10 is a Tuesday.
const tuesday = "2026-03-10"

func TestSlotsComeFromTheOpeningPatternMinusWhatIsBooked(t *testing.T) {
	loc := budapest(t)
	r := chair(Window{Weekday: 2, Opens: "09:00", Closes: "11:00"})
	free := Free(r, day(t, tuesday), loc, time.Hour, 30*time.Minute, nil,
		day(t, tuesday))
	// 09:00, 09:30, 10:00. Not 10:30, because an hour from it runs past close.
	if len(free) != 3 {
		t.Fatalf("got %d slots, want 3: %v", len(free), free)
	}
	if got := free[0].Start.In(loc).Format("15:04"); got != "09:00" {
		t.Fatalf("first slot at %s", got)
	}
	if got := free[2].Start.In(loc).Format("15:04"); got != "10:00" {
		t.Fatalf("last slot at %s", got)
	}
}

func TestAResourceIsOnlyOpenOnTheDaysItWorks(t *testing.T) {
	loc := budapest(t)
	// Open Wednesdays only, asked about a Tuesday.
	r := chair(Window{Weekday: 3, Opens: "09:00", Closes: "17:00"})
	if free := Free(r, day(t, tuesday), loc, time.Hour, time.Hour, nil, day(t, tuesday)); len(free) != 0 {
		t.Fatalf("got %d slots on a day this resource does not work", len(free))
	}
}

func TestABookingRemovesTheSlotsItCovers(t *testing.T) {
	loc := budapest(t)
	r := chair(Window{Weekday: 2, Opens: "09:00", Closes: "12:00"})
	start := time.Date(2026, 3, 10, 10, 0, 0, 0, loc)
	busy := []Busy{{Start: start, End: start.Add(time.Hour)}}
	free := Free(r, day(t, tuesday), loc, time.Hour, time.Hour, busy, day(t, tuesday))
	for _, s := range free {
		if s.Start.In(loc).Format("15:04") == "10:00" {
			t.Fatal("a slot was offered on top of an existing booking")
		}
	}
	if len(free) != 2 {
		t.Fatalf("got %d slots, want 09:00 and 11:00", len(free))
	}
}

func TestBackToBackBookingsDoNotOverlap(t *testing.T) {
	// A booking ending at 10:00 and one starting at 10:00 do not clash. Getting
	// this wrong the other way refuses every back-to-back appointment, which is
	// most of a salon's day.
	loc := budapest(t)
	ten := time.Date(2026, 3, 10, 10, 0, 0, 0, loc)
	busy := []Busy{{Start: ten.Add(-time.Hour), End: ten}}
	if !Fits(1, busy, ten, ten.Add(time.Hour)) {
		t.Fatal("a booking starting when another ends was treated as a clash")
	}
	if Fits(1, busy, ten.Add(-30*time.Minute), ten.Add(30*time.Minute)) {
		t.Fatal("a genuine overlap was allowed")
	}
}

func TestCapacityIsACountRatherThanABoolean(t *testing.T) {
	// A chair holds one, a table for six holds more. Treating every resource as
	// exclusive is what makes a service that cannot describe a restaurant.
	loc := budapest(t)
	ten := time.Date(2026, 3, 10, 10, 0, 0, 0, loc)
	busy := []Busy{
		{Start: ten, End: ten.Add(time.Hour)},
		{Start: ten, End: ten.Add(time.Hour)},
	}
	if !Fits(3, busy, ten, ten.Add(time.Hour)) {
		t.Fatal("a resource with room for three refused a third booking")
	}
	if Fits(2, busy, ten, ten.Add(time.Hour)) {
		t.Fatal("a resource with room for two took a third booking")
	}
}

func TestASlotThatHasAlreadyStartedIsNotOffered(t *testing.T) {
	loc := budapest(t)
	r := chair(Window{Weekday: 2, Opens: "09:00", Closes: "12:00"})
	// It is half past nine.
	now := time.Date(2026, 3, 10, 9, 30, 0, 0, loc)
	free := Free(r, day(t, tuesday), loc, time.Hour, time.Hour, nil, now)
	for _, s := range free {
		if !s.Start.After(now) {
			t.Fatalf("offered %s, which has already begun", s.Start.In(loc).Format("15:04"))
		}
	}
}

func TestOpeningHoursAreWallClockAcrossADaylightSavingChange(t *testing.T) {
	// Hungary moves its clocks on 29 March 2026. A business that opens at nine
	// opens at nine on both sides of it: the window is applied in the zone to
	// the date, so the instant falls out rather than drifting by an hour.
	loc := budapest(t)
	r := chair(
		Window{Weekday: 6, Opens: "09:00", Closes: "10:00"},
		Window{Weekday: 7, Opens: "09:00", Closes: "10:00"},
	)
	before := Free(r, day(t, "2026-03-28"), loc, time.Hour, time.Hour, nil, day(t, "2026-01-01"))
	after := Free(r, day(t, "2026-03-29"), loc, time.Hour, time.Hour, nil, day(t, "2026-01-01"))
	if len(before) != 1 || len(after) != 1 {
		t.Fatalf("got %d before and %d after", len(before), len(after))
	}
	if got := before[0].Start.In(loc).Format("15:04"); got != "09:00" {
		t.Fatalf("before the change: %s", got)
	}
	if got := after[0].Start.In(loc).Format("15:04"); got != "09:00" {
		t.Fatalf("after the change: %s", got)
	}
	// And they are genuinely different instants, an hour apart in UTC, which is
	// the proof the zone was applied rather than ignored.
	if before[0].Start.UTC().Hour() == after[0].Start.UTC().Hour() {
		t.Fatal("the two nine o'clocks are the same UTC hour, so the zone was ignored")
	}
}

func TestAWindowThatClosesAfterMidnightStaysOpen(t *testing.T) {
	// A bar that shuts at two is open from ten to two, not closed for sixteen
	// hours.
	loc := budapest(t)
	r := chair(Window{Weekday: 2, Opens: "22:00", Closes: "02:00"})
	free := Free(r, day(t, tuesday), loc, time.Hour, time.Hour, nil, day(t, tuesday))
	if len(free) != 4 {
		t.Fatalf("got %d slots, want 22:00, 23:00, 00:00 and 01:00: %v", len(free), free)
	}
}

func TestWithinOpeningSeparatesClosedFromFull(t *testing.T) {
	// "We are closed" and "we are full" are different answers, and a customer
	// deserves the right one.
	loc := budapest(t)
	r := chair(Window{Weekday: 2, Opens: "09:00", Closes: "17:00"})
	inside := time.Date(2026, 3, 10, 10, 0, 0, 0, loc)
	if !WithinOpening(r, inside, inside.Add(time.Hour), loc) {
		t.Fatal("a time inside opening hours was called closed")
	}
	outside := time.Date(2026, 3, 10, 20, 0, 0, 0, loc)
	if WithinOpening(r, outside, outside.Add(time.Hour), loc) {
		t.Fatal("a time after closing was called open")
	}
	// Running past closing time is outside, even though it starts inside.
	late := time.Date(2026, 3, 10, 16, 30, 0, 0, loc)
	if WithinOpening(r, late, late.Add(time.Hour), loc) {
		t.Fatal("a booking running past closing was allowed")
	}
}
