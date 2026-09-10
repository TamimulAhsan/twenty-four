package main

import (
	"net/http"
	"strconv"
	"strings"

	analyticspb "github.com/twentyfour/platform/gen/go/twentyfour/analytics/v1"
	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The reporting routes.
//
// All four are reads, all four take the same period, and all four are behind
// one permission. Analytics answers about the whole business, so a staff member
// who can ring up a sale is not thereby somebody who can see the month.
func (g *gateway) registerAnalytics(mux *http.ServeMux) {
	mux.Handle("GET /api/analytics/summary", g.authenticated(g.analyticsSummary))
	mux.Handle("GET /api/analytics/series", g.authenticated(g.analyticsSeries))
	mux.Handle("GET /api/analytics/breakdown", g.authenticated(g.analyticsBreakdown))
	mux.Handle("GET /api/analytics/heatmap", g.authenticated(g.analyticsHeatmap))
}

// period reads the window off the query string.
//
// The time zone comes from the caller rather than from a header or a guess,
// because it decides which day a sale belongs to and the browser is the only
// participant that knows what the merchant's clock says. Sending none is
// refused downstream rather than defaulted here: a quietly wrong day boundary
// moves takings between days for every business that trades in the evening.
func period(r *http.Request) *analyticspb.Period {
	q := r.URL.Query()
	return &analyticspb.Period{
		From:     q.Get("from"),
		To:       q.Get("to"),
		TimeZone: q.Get("tz"),
	}
}

// optionalMoney is null only when the figure is absent, and never because it
// happens to be zero.
//
// Not nullableMoney, which folds a zero into null. That is right for a line's
// discount, where nothing and nothing-off are the same thing. It is wrong for
// every figure here: a margin of zero is a business breaking even, and a margin
// that could not be worked out is a question nobody has answered. Reporting the
// first as the second is how a merchant loses a day looking for missing costs
// that were never missing.
func optionalMoney(m *commonpb.Money) any {
	if m == nil {
		return nil
	}
	return moneyJSON(m)
}

func freshnessJSON(f *analyticspb.Freshness) any {
	if f.GetThrough() == nil {
		// Null rather than a zero time. "We hold nothing for you" and "we are
		// current as of the epoch" are different answers.
		return nil
	}
	return map[string]any{"through": f.GetThrough().AsTime()}
}

func totalsJSON(t *analyticspb.Totals) map[string]any {
	return map[string]any{
		"gross":    moneyJSON(t.GetGross()),
		"net":      moneyJSON(t.GetNet()),
		"tax":      moneyJSON(t.GetTax()),
		"discount": moneyJSON(t.GetDiscount()),
		"refunded": moneyJSON(t.GetRefunded()),
		// null where a line in the period had no recorded cost. An item nobody
		// costed has no margin, which is not a margin of zero and certainly not
		// one of a hundred percent.
		"cost":          optionalMoney(t.GetCost()),
		"margin":        optionalMoney(t.GetMargin()),
		"orders":        t.GetOrders(),
		"customers":     t.GetCustomers(),
		"averageBasket": moneyJSON(t.GetAverageBasket()),
		// Sent as thousandths, the way it crosses the wire, so the client does
		// the division for display and nobody rounds it twice.
		"averageLinesPerOrderMilli": t.GetAverageLinesPerOrderMilli(),
	}
}

func (g *gateway) analyticsSummary(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "analytics:report:read") {
		return
	}
	resp, err := g.analytics.Summary(g.downstream(r, c),
		&analyticspb.SummaryRequest{Period: period(r)})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"current":  totalsJSON(resp.GetCurrent()),
		"previous": totalsJSON(resp.GetPrevious()),
		"previousPeriod": map[string]any{
			"from": resp.GetPreviousPeriod().GetFrom(),
			"to":   resp.GetPreviousPeriod().GetTo(),
		},
		"freshness": freshnessJSON(resp.GetFreshness()),
	})
}

func (g *gateway) analyticsSeries(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "analytics:report:read") {
		return
	}
	resp, err := g.analytics.Series(g.downstream(r, c),
		&analyticspb.SeriesRequest{Period: period(r)})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	points := make([]map[string]any, 0, len(resp.GetPoints()))
	for _, p := range resp.GetPoints() {
		points = append(points, map[string]any{
			"date":      p.GetDate(),
			"gross":     moneyJSON(p.GetGross()),
			"net":       moneyJSON(p.GetNet()),
			"tax":       moneyJSON(p.GetTax()),
			"margin":    optionalMoney(p.GetMargin()),
			"orders":    p.GetOrders(),
			"customers": p.GetCustomers(),
		})
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"points": points, "freshness": freshnessJSON(resp.GetFreshness()),
	})
}

// dimensions is the whole vocabulary the API accepts, so an unknown one is
// refused by name rather than passed down to be refused as an enum nobody
// recognises.
var dimensions = map[string]analyticspb.Dimension{
	"method":   analyticspb.Dimension_DIMENSION_METHOD,
	"category": analyticspb.Dimension_DIMENSION_CATEGORY,
	"item":     analyticspb.Dimension_DIMENSION_ITEM,
}

func sliceJSON(s *analyticspb.Slice) map[string]any {
	return map[string]any{
		"key":   s.GetKey(),
		"label": s.GetLabel(),
		"gross": moneyJSON(s.GetGross()),
		// Basis points on the wire, for the same reason money is integer minor
		// units: a share that has been through a float disagrees with the
		// total it came from.
		"shareBasisPoints": s.GetShareBasisPoints(),
		"orders":           s.GetOrders(),
	}
}

func (g *gateway) analyticsBreakdown(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "analytics:report:read") {
		return
	}
	q := r.URL.Query()
	dim, ok := dimensions[strings.ToLower(q.Get("by"))]
	if !ok {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
			"Split the revenue by method, category or item.")
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))

	resp, err := g.analytics.Breakdown(g.downstream(r, c), &analyticspb.BreakdownRequest{
		Period: period(r), Dimension: dim, Limit: int32(limit),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	slices := make([]map[string]any, 0, len(resp.GetSlices()))
	for _, s := range resp.GetSlices() {
		slices = append(slices, sliceJSON(s))
	}
	body := map[string]any{"slices": slices, "freshness": freshnessJSON(resp.GetFreshness())}
	// Separate from the list, so a client cannot sort the remainder into the
	// middle of the ranking and so it can be rendered as what it is.
	if other := resp.GetOther(); other != nil {
		body["other"] = sliceJSON(other)
	} else {
		body["other"] = nil
	}
	httpx.JSON(w, r, http.StatusOK, body)
}

func (g *gateway) analyticsHeatmap(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "analytics:report:read") {
		return
	}
	resp, err := g.analytics.Heatmap(g.downstream(r, c),
		&analyticspb.HeatmapRequest{Period: period(r)})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	cells := make([]map[string]any, 0, len(resp.GetCells()))
	for _, cell := range resp.GetCells() {
		cells = append(cells, map[string]any{
			"weekday": cell.GetWeekday(), "hour": cell.GetHour(),
			"orders": cell.GetOrders(), "gross": moneyJSON(cell.GetGross()),
		})
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"cells": cells, "freshness": freshnessJSON(resp.GetFreshness()),
	})
}
