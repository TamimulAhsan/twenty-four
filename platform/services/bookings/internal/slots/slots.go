// Package slots computes free times.
//
// Derived, never stored. A table of free slots is a table something has to keep
// up to date, and the thing that fails to update it is always the path nobody
// tested: a cancellation at the same moment as a booking, a rota change, an
// opening hour edited on a Sunday. So availability is the opening pattern minus
// what is already booked, computed on the question.
//
// Two things this package is careful about.
//
// Opening hours are wall clock times, not instants. A business that opens at
// nine opens at nine on both sides of a daylight saving change, so the window
// is applied in the tenant's own zone to the tenant's own date, and only then
// becomes an instant.
//
// Capacity is a count of overlaps, not a boolean. A chair holds one booking, a
// table for six holds more, and a class holds a dozen. Treating every resource
// as exclusive is what makes a service that cannot describe a restaurant.
package slots

import (
	"fmt"
	"sort"
	"time"
)

// Window is when a resource is open on one weekday, as wall clock times.
type Window struct {
	// ISO weekday, 1 is Monday.
	Weekday int
	Opens   string
	Closes  string
}

// Busy is one booking already in the diary.
type Busy struct {
	Start time.Time
	End   time.Time
}

// Resource is what is being asked about.
type Resource struct {
	ID       string
	Name     string
	Capacity int
	Opening  []Window
}

// Slot is a free time on a resource.
type Slot struct {
	Start        time.Time
	End          time.Time
	ResourceID   string
	ResourceName string
}

// Free returns the times a resource can take a booking of the given length on
// one local date.
//
// step is how far apart the offered starts are: a fifteen-minute grid for a
// forty-minute appointment offers 09:00, 09:15, 09:30, which is what a customer
// expects to see and what fills a day efficiently.
func Free(r Resource, date time.Time, loc *time.Location, duration, step time.Duration,
	busy []Busy, now time.Time) []Slot {
	if duration <= 0 || step <= 0 {
		return nil
	}
	weekday := isoWeekday(date.In(loc))

	var out []Slot
	for _, w := range r.Opening {
		if w.Weekday != weekday {
			continue
		}
		open, ok := at(date, loc, w.Opens)
		if !ok {
			continue
		}
		close, ok := at(date, loc, w.Closes)
		if !ok {
			continue
		}
		// A window that closes before it opens crosses midnight, which a
		// business that shuts at 02:00 genuinely does.
		if !close.After(open) {
			close = close.AddDate(0, 0, 1)
		}

		for start := open; !start.Add(duration).After(close); start = start.Add(step) {
			end := start.Add(duration)
			// A slot that has already begun is not a slot. Offering 09:00 at
			// half past nine is how a booking arrives for a time that has gone.
			if !start.After(now) {
				continue
			}
			if overlaps(busy, start, end) >= r.Capacity {
				continue
			}
			out = append(out, Slot{
				Start: start.UTC(), End: end.UTC(),
				ResourceID: r.ID, ResourceName: r.Name,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start.Before(out[j].Start) })
	return out
}

// Fits reports whether a booking can be added without breaking capacity.
//
// The same test Free uses, exposed on its own because creating a booking has to
// ask it again at the moment of writing: a slot that was free when the page
// rendered is not necessarily free when the button is pressed, and that gap is
// exactly where a double booking comes from.
func Fits(capacity int, busy []Busy, start, end time.Time) bool {
	return overlaps(busy, start, end) < capacity
}

// overlaps counts how many existing bookings run over the proposed time.
//
// Half-open on purpose: a booking ending at 10:00 and one starting at 10:00 do
// not overlap. Getting this wrong in the other direction makes a diary that
// refuses every back-to-back appointment, which is most of a salon's day.
func overlaps(busy []Busy, start, end time.Time) int {
	n := 0
	for _, b := range busy {
		if b.Start.Before(end) && start.Before(b.End) {
			n++
		}
	}
	return n
}

// WithinOpening reports whether a proposed booking falls inside the resource's
// hours. Checked separately from capacity, because "we are closed" and "we are
// full" are different answers and a customer deserves the right one.
func WithinOpening(r Resource, start, end time.Time, loc *time.Location) bool {
	local := start.In(loc)
	weekday := isoWeekday(local)
	date := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	for _, w := range r.Opening {
		if w.Weekday != weekday {
			continue
		}
		open, ok := at(date, loc, w.Opens)
		if !ok {
			continue
		}
		close, ok := at(date, loc, w.Closes)
		if !ok {
			continue
		}
		if !close.After(open) {
			close = close.AddDate(0, 0, 1)
		}
		if !start.Before(open) && !end.After(close) {
			return true
		}
	}
	return false
}

// at applies a wall clock time to a local date.
//
// This is the step that keeps "we open at nine" true across a daylight saving
// change: the hour is applied in the zone, and the instant falls out of it,
// rather than an instant being stored and drifting by an hour twice a year.
func at(date time.Time, loc *time.Location, clock string) (time.Time, bool) {
	var h, m int
	if _, err := fmt.Sscanf(clock, "%d:%d", &h, &m); err != nil {
		return time.Time{}, false
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return time.Time{}, false
	}
	local := date.In(loc)
	return time.Date(local.Year(), local.Month(), local.Day(), h, m, 0, 0, loc), true
}

// isoWeekday returns 1 for Monday through 7 for Sunday.
//
// Go counts from Sunday as zero. The opening table, the analytics heatmap and
// the calendar all use ISO, so the conversion happens once, here.
func isoWeekday(t time.Time) int {
	d := int(t.Weekday())
	if d == 0 {
		return 7
	}
	return d
}
