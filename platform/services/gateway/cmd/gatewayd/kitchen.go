package main

import (
	"encoding/json"
	"net/http"

	kitchenpb "github.com/twentyfour/platform/gen/go/twentyfour/kitchen/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The prep screens.
//
// Gated on the POS permissions rather than a set of its own. A kitchen display
// is a trade capability inside POS, not a sold module, so somebody who can work
// the till can work the pass: inventing a kitchen permission would mean a
// merchant switching on prep screens then discovering none of their staff can
// see them.
func (g *gateway) registerKitchen(mux *http.ServeMux) {
	mux.Handle("GET /api/kitchen/tickets", g.authenticated(g.kitchenTickets))
	mux.Handle("POST /api/kitchen/lines/{id}/claim", g.authenticated(g.claimLine))
	mux.Handle("POST /api/kitchen/lines/{id}/done", g.authenticated(g.completeLine))
	mux.Handle("POST /api/kitchen/lines/{id}/void", g.authenticated(g.voidLine))
	mux.Handle("POST /api/kitchen/tickets/{id}/pass", g.authenticated(g.passTicket))

	mux.Handle("GET /api/kitchen/stations", g.authenticated(g.kitchenStations))
	mux.Handle("PUT /api/kitchen/stations", g.authenticated(g.putStation))
	mux.Handle("DELETE /api/kitchen/stations/{id}", g.authenticated(g.deleteStation))
	mux.Handle("PUT /api/kitchen/routes/{itemId}", g.authenticated(g.routeItem))
}

var ticketStateNames = map[kitchenpb.TicketState]string{
	kitchenpb.TicketState_TICKET_STATE_WAITING: "waiting",
	kitchenpb.TicketState_TICKET_STATE_COOKING: "cooking",
	kitchenpb.TicketState_TICKET_STATE_READY:   "ready",
	kitchenpb.TicketState_TICKET_STATE_PASSED:  "passed",
	kitchenpb.TicketState_TICKET_STATE_VOIDED:  "voided",
}

var lineStateNames = map[kitchenpb.LineState]string{
	kitchenpb.LineState_LINE_STATE_WAITING: "waiting",
	kitchenpb.LineState_LINE_STATE_CLAIMED: "claimed",
	kitchenpb.LineState_LINE_STATE_DONE:    "done",
	kitchenpb.LineState_LINE_STATE_VOIDED:  "voided",
}

func ticketJSON(t *kitchenpb.Ticket) map[string]any {
	lines := make([]map[string]any, 0, len(t.GetLines()))
	for _, l := range t.GetLines() {
		lines = append(lines, map[string]any{
			"id": l.GetId(), "itemId": l.GetItemId(), "name": l.GetName(),
			"quantity": l.GetQuantity(), "note": l.GetNote(),
			"stationId": l.GetStationId(), "stationName": l.GetStationName(),
			"state": lineStateNames[l.GetState()], "claimedBy": nullable(l.GetClaimedBy()),
		})
	}
	out := map[string]any{
		"id": t.GetId(), "orderId": t.GetOrderId(), "orderNumber": t.GetOrderNumber(),
		"tableLabel": t.GetTableLabel(), "state": ticketStateNames[t.GetState()],
		"note": t.GetNote(), "lines": lines,
		// The till's clock, not this service's. A prep screen colours by how
		// long a table has been waiting, and that starts when the order was
		// rung up rather than when the kitchen happened to read it.
		"placedAt": t.GetPlacedAt().AsTime(),
	}
	if ts := t.GetPassedAt(); ts.IsValid() {
		out["passedAt"] = ts.AsTime()
	}
	return out
}

func (g *gateway) kitchenTickets(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:read") {
		return
	}
	resp, err := g.kitchen.ListTickets(g.downstream(r, c), &kitchenpb.ListTicketsRequest{
		StationId:       r.URL.Query().Get("stationId"),
		IncludeFinished: r.URL.Query().Get("includeFinished") == "true",
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetTickets()))
	for _, t := range resp.GetTickets() {
		out = append(out, ticketJSON(t))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

// Working a ticket is updating a sale in progress, which is what pos:order:update
// already means. A cook claiming a dish is not a different kind of authority
// from a server amending an order.
func (g *gateway) claimLine(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:update") {
		return
	}
	// The staff id comes from the verified session, never from the body: a
	// claim is what stops two cooks starting the same dish, and one a caller
	// could set is one a caller could set to somebody else.
	resp, err := g.kitchen.ClaimLine(g.downstream(r, c), &kitchenpb.ClaimLineRequest{
		LineId: r.PathValue("id"), StaffId: c.UserID,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, ticketJSON(resp.GetTicket()))
}

func (g *gateway) completeLine(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:update") {
		return
	}
	resp, err := g.kitchen.CompleteLine(g.downstream(r, c),
		&kitchenpb.CompleteLineRequest{LineId: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, ticketJSON(resp.GetTicket()))
}

func (g *gateway) voidLine(w http.ResponseWriter, r *http.Request, c caller) {
	// Taking a dish off a ticket is not the same as cooking it. It is the
	// kitchen's half of a void, so it is the void permission.
	if !g.requirePermission(w, r, c, "pos:order:void") {
		return
	}
	var in struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in)
	resp, err := g.kitchen.VoidLine(g.downstream(r, c),
		&kitchenpb.VoidLineRequest{LineId: r.PathValue("id"), Reason: in.Reason})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, ticketJSON(resp.GetTicket()))
}

func (g *gateway) passTicket(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:update") {
		return
	}
	resp, err := g.kitchen.PassTicket(g.downstream(r, c),
		&kitchenpb.PassTicketRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, ticketJSON(resp.GetTicket()))
}

func stationJSON(s *kitchenpb.Station) map[string]any {
	return map[string]any{
		"id": s.GetId(), "name": s.GetName(),
		"isPass": s.GetIsPass(), "active": s.GetActive(),
	}
}

func (g *gateway) kitchenStations(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:read") {
		return
	}
	resp, err := g.kitchen.ListStations(g.downstream(r, c), &kitchenpb.ListStationsRequest{
		IncludeInactive: r.URL.Query().Get("includeInactive") == "true",
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetStations()))
	for _, s := range resp.GetStations() {
		out = append(out, stationJSON(s))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

// Arranging the kitchen is configuration, not service. Setting up stations and
// deciding which dish goes where is the catalog owner's act, not a cook's.
func (g *gateway) putStation(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:update") {
		return
	}
	var in struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		IsPass bool   `json:"isPass"`
		Active bool   `json:"active"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	resp, err := g.kitchen.PutStation(g.downstream(r, c), &kitchenpb.PutStationRequest{
		Id: in.ID, Name: in.Name, IsPass: in.IsPass, Active: in.Active,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, stationJSON(resp.GetStation()))
}

func (g *gateway) deleteStation(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:update") {
		return
	}
	if _, err := g.kitchen.DeleteStation(g.downstream(r, c),
		&kitchenpb.DeleteStationRequest{Id: r.PathValue("id")}); err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.NoContent(w)
}

func (g *gateway) routeItem(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:update") {
		return
	}
	var in struct {
		StationID string `json:"stationId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	// An empty station removes the routing, which sends the dish to the pass
	// rather than to nowhere: one that reaches no screen is one nobody cooks.
	if _, err := g.kitchen.RouteItem(g.downstream(r, c), &kitchenpb.RouteItemRequest{
		ItemId: r.PathValue("itemId"), StationId: in.StationID,
	}); err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.NoContent(w)
}
