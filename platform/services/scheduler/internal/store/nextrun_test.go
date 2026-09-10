package store

import (
	"testing"
	"time"
)

func hour(h int32) *int32 { return &h }

func TestShortIntervalsIgnoreTheHour(t *testing.T) {
	// The six-hour budget cycle runs every six hours, not at 02:00. An hour is
	// only meaningful once the interval is a day or more.
	from := time.Date(2026, 3, 10, 13, 20, 0, 0, time.UTC)
	next := NextRun(from, 6*3600, hour(2), "Europe/Budapest")
	if !next.Equal(from.Add(6 * time.Hour)) {
		t.Fatalf("got %s, want six hours on from %s", next, from)
	}
}

func TestADailyScheduleFiresAtItsHourInTheTenantsOwnZone(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Budapest")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	// Midday local, wanting 02:00: tomorrow morning, not fourteen hours from
	// now in whatever zone the pod happens to run in.
	from := time.Date(2026, 3, 10, 12, 0, 0, 0, loc)
	next := NextRun(from, 24*3600, hour(2), "Europe/Budapest").In(loc)
	if next.Hour() != 2 || next.Day() != 11 {
		t.Fatalf("got %s, want 02:00 on the 11th", next.Format("2006-01-02 15:04"))
	}
}

func TestTheSameHourInTwoMarketsIsTwoDifferentInstants(t *testing.T) {
	// This is the whole reason the zone is stored rather than assumed. "The
	// nightly reconciliation at two" has to mean two in Budapest and two in
	// Dhaka, which are not the same moment.
	from := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	budapest := NextRun(from, 24*3600, hour(2), "Europe/Budapest")
	dhaka := NextRun(from, 24*3600, hour(2), "Asia/Dhaka")
	if budapest.Equal(dhaka) {
		t.Fatal("two zones produced the same instant, so the zone is being ignored")
	}
}

func TestAnHourAlreadyPassedTodayGoesToTomorrow(t *testing.T) {
	loc, _ := time.LoadLocation("Europe/Budapest")
	// 03:00 local, wanting 02:00. Today's has gone.
	from := time.Date(2026, 3, 10, 3, 0, 0, 0, loc)
	next := NextRun(from, 24*3600, hour(2), "Europe/Budapest").In(loc)
	if next.Day() != 11 {
		t.Fatalf("got %s, want tomorrow", next.Format("2006-01-02 15:04"))
	}
}

func TestAnUnknownZoneStillSchedules(t *testing.T) {
	// Falling back to UTC may be the wrong hour, which is visible. Not running
	// at all is not.
	from := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	next := NextRun(from, 24*3600, hour(2), "Mars/Olympus_Mons")
	if next.IsZero() || !next.After(from) {
		t.Fatalf("got %s, want a future time despite the zone", next)
	}
}
