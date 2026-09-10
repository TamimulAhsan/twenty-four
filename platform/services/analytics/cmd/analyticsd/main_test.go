package main

import (
	"context"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/google/uuid"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/analytics/v1"
	"github.com/twentyfour/platform/packages/tenantctx"
)

// What a period may be.
//
// Everything else in this service is SQL, and SQL is verified against a real
// ClickHouse. These are the refusals, and a refusal that quietly becomes a
// default is worse than the request being rejected: a period silently read in
// UTC moves takings between days for every business that trades in the evening.

func withTenant() context.Context {
	return tenantctx.With(context.Background(), tenantctx.Identity{TenantID: uuid.New()})
}

func TestPeriodMustCarryItsTimeZone(t *testing.T) {
	s := &server{currency: "HUF"}
	_, err := s.bind(withTenant(), &pb.Period{From: "2026-01-01", To: "2026-01-31"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("a period with no zone was accepted: %v", err)
	}
}

func TestPeriodRefusals(t *testing.T) {
	s := &server{currency: "HUF"}
	cases := map[string]*pb.Period{
		"backwards":     {From: "2026-02-01", To: "2026-01-01", TimeZone: "Europe/Budapest"},
		"not a date":    {From: "last tuesday", To: "2026-01-01", TimeZone: "Europe/Budapest"},
		"not a zone":    {From: "2026-01-01", To: "2026-01-02", TimeZone: "Mars/Olympus"},
		"a decade wide": {From: "2016-01-01", To: "2026-01-01", TimeZone: "Europe/Budapest"},
	}
	for name, period := range cases {
		if _, err := s.bind(withTenant(), period); status.Code(err) != codes.InvalidArgument {
			t.Errorf("%s: accepted, or refused for the wrong reason: %v", name, err)
		}
	}
}

func TestNoTenantIsRefused(t *testing.T) {
	s := &server{currency: "HUF"}
	_, err := s.bind(context.Background(),
		&pb.Period{From: "2026-01-01", To: "2026-01-02", TimeZone: "UTC"})
	if err == nil {
		t.Fatal("a request with no tenant was bound anyway")
	}
}

// The comparison window is equal in length and immediately before, never "the
// same period last month". A 31-day month against a 28-day one moves every
// figure for a reason that has nothing to do with the business.
func TestPreviousIsEqualLengthAndAdjacent(t *testing.T) {
	for _, tc := range []struct{ from, to, wantFrom, wantTo string }{
		{"2026-01-08", "2026-01-14", "2026-01-01", "2026-01-07"},
		{"2026-03-01", "2026-03-01", "2026-02-28", "2026-02-28"},
		// 31 days back from 1 March lands in January, because February is short.
		{"2026-03-01", "2026-03-31", "2026-01-29", "2026-02-28"},
	} {
		got := previous(&pb.Period{From: tc.from, To: tc.to, TimeZone: "Europe/Budapest"})
		if got.GetFrom() != tc.wantFrom || got.GetTo() != tc.wantTo {
			t.Errorf("%s..%s: got %s..%s, want %s..%s",
				tc.from, tc.to, got.GetFrom(), got.GetTo(), tc.wantFrom, tc.wantTo)
		}
		if got.GetTimeZone() != "Europe/Budapest" {
			t.Errorf("the comparison window lost its time zone")
		}
	}
}
