package store

import (
	"testing"
	"time"
)

func prefs() Preferences {
	return Preferences{
		Channels: []string{"email"}, QuietFrom: "21:00", QuietTo: "08:00",
		TimeZone: "Europe/Budapest", BookingReminders: true,
		ReceiptByEmail: true, Marketing: false,
	}
}

func at(t *testing.T, clock string) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Budapest")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	parsed, err := time.ParseInLocation("2006-01-02 15:04", "2026-03-10 "+clock, loc)
	if err != nil {
		t.Fatalf("parse %q: %v", clock, err)
	}
	return parsed
}

func TestAChannelTheBusinessDoesNotUseCarriesNothing(t *testing.T) {
	p := prefs()
	// Not even a transactional message. There is no transport: a business that
	// has not set up SMS cannot send one, and recording a send that could never
	// have happened would make the delivery log a work of fiction.
	if ok, why := p.Allows("sms", "transactional"); ok {
		t.Fatalf("SMS should be refused when it is not a channel this business uses, got %q", why)
	}
	if ok, _ := p.Allows("email", "transactional"); !ok {
		t.Fatal("email is a channel this business uses")
	}
}

func TestTransactionalOverridesCategorySwitches(t *testing.T) {
	p := prefs()
	p.BookingReminders = false
	p.ReceiptByEmail = false

	// A category switched off is a choice about content. A password reset is
	// not content, and somebody is waiting for it.
	if ok, why := p.Allows("email", "transactional"); !ok {
		t.Fatalf("transactional messages are not a preference: %q", why)
	}
	if ok, _ := p.Allows("email", "reminder"); ok {
		t.Fatal("reminders are switched off and should be refused")
	}
	if ok, _ := p.Allows("email", "receipt"); ok {
		t.Fatal("emailed receipts are switched off and should be refused")
	}
}

func TestMarketingIsTheOnlyOptIn(t *testing.T) {
	p := prefs()
	if ok, _ := p.Allows("email", "marketing"); ok {
		t.Fatal("marketing must be opted into, not out of")
	}
	p.Marketing = true
	if ok, why := p.Allows("email", "marketing"); !ok {
		t.Fatalf("opted in and still refused: %q", why)
	}
}

func TestQuietHoursWrapMidnight(t *testing.T) {
	p := prefs()
	// 21:00 to 08:00 is quiet at 23:00 and at 02:00, and noisy at noon. A
	// simple range test gets the middle case exactly backwards.
	for _, quiet := range []string{"21:00", "23:30", "02:00", "07:59"} {
		if p.HeldUntil(at(t, quiet), "reminder").IsZero() {
			t.Errorf("%s is inside quiet hours and should be held", quiet)
		}
	}
	for _, loud := range []string{"08:00", "12:00", "20:59"} {
		if !p.HeldUntil(at(t, loud), "reminder").IsZero() {
			t.Errorf("%s is outside quiet hours and should go now", loud)
		}
	}
}

func TestAHeldMessageWaitsForTheEndOfTheWindowNotAFixedDelay(t *testing.T) {
	p := prefs()
	until := p.HeldUntil(at(t, "23:30"), "reminder")
	loc, _ := time.LoadLocation("Europe/Budapest")
	local := until.In(loc)
	if local.Hour() != 8 || local.Minute() != 0 {
		t.Fatalf("held until %s, want 08:00 local", local.Format("15:04"))
	}
	// 23:30 is before midnight, so the window ends the following morning.
	if local.Day() != 11 {
		t.Fatalf("held until day %d, want the next day", local.Day())
	}

	// A message sent after midnight is still inside the same window, and waits
	// for that morning rather than the next one.
	sameWindow := p.HeldUntil(at(t, "02:00"), "reminder").In(loc)
	if sameWindow.Day() != 10 || sameWindow.Hour() != 8 {
		t.Fatalf("held until %s, want 08:00 the same morning", sameWindow.Format("2006-01-02 15:04"))
	}
}

func TestTransactionalIsNeverHeld(t *testing.T) {
	p := prefs()
	if !p.HeldUntil(at(t, "03:00"), "transactional").IsZero() {
		t.Fatal("somebody is waiting for a reset link at three in the morning too")
	}
}

func TestEqualQuietHoursMeanNoQuietHours(t *testing.T) {
	p := prefs()
	p.QuietFrom, p.QuietTo = "00:00", "00:00"
	if !p.HeldUntil(at(t, "03:00"), "reminder").IsZero() {
		t.Fatal("equal bounds mean no window, not a window of the whole day")
	}
}
