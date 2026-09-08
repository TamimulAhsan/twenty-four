package main

import (
	"encoding/json"
	"net/http"
	"strings"

	pospb "github.com/twentyfour/platform/gen/go/twentyfour/pos/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The day's trading, and the floor.

func (g *gateway) takings(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:takings:read") {
		return
	}
	resp, err := g.pos.GetTakings(g.downstream(r, c),
		&pospb.GetTakingsRequest{Date: r.URL.Query().Get("date")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	byMethod := make([]map[string]any, 0, len(resp.GetByMethod()))
	for _, m := range resp.GetByMethod() {
		byMethod = append(byMethod, map[string]any{
			"method": m.GetMethod(), "amount": moneyJSON(m.GetAmount()), "count": m.GetCount(),
		})
	}
	// Broken out by band because that is the shape a tax return is filed in,
	// and because a single total cannot be checked against anything.
	byBand := make([]map[string]any, 0, len(resp.GetByTaxBand()))
	for _, b := range resp.GetByTaxBand() {
		byBand = append(byBand, map[string]any{
			"basisPoints": b.GetBasisPoints(),
			"net":         moneyJSON(b.GetNet()),
			"tax":         moneyJSON(b.GetTax()),
			"gross":       moneyJSON(b.GetGross()),
		})
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"date": resp.GetDate(), "orderCount": resp.GetOrderCount(),
		"gross": moneyJSON(resp.GetGross()), "net": moneyJSON(resp.GetNet()),
		"tax": moneyJSON(resp.GetTax()), "refunded": moneyJSON(resp.GetRefunded()),
		"byMethod": byMethod, "byTaxBand": byBand,
	})
}

func dayCloseJSON(d *pospb.DayClose) map[string]any {
	out := map[string]any{
		"date":         d.GetDate(),
		"openingFloat": moneyJSON(d.GetOpeningFloat()),
		"cashTaken":    moneyJSON(d.GetCashTaken()),
		"cashRefunded": moneyJSON(d.GetCashRefunded()),
		"expectedCash": moneyJSON(d.GetExpectedCash()),
		// null until the day is counted. Zero would read as "the drawer was
		// empty", which is a different and much more alarming statement.
		"countedCash": nil, "variance": nil,
		"countedBy": nullable(d.GetCountedBy()),
		"countedAt": nil,
		"note":      d.GetNote(), "closed": d.GetClosed(),
	}
	if d.GetCountedCash() != nil {
		out["countedCash"] = moneyJSON(d.GetCountedCash())
		out["variance"] = moneyJSON(d.GetVariance())
	}
	if t := d.GetCountedAt(); t != nil {
		out["countedAt"] = t.AsTime().UTC().Format("2006-01-02T15:04:05Z")
	}
	return out
}

func (g *gateway) getDayClose(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:takings:read") {
		return
	}
	resp, err := g.pos.GetDayClose(g.downstream(r, c),
		&pospb.GetDayCloseRequest{Date: r.URL.Query().Get("date")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, dayCloseJSON(resp.GetDayClose()))
}

func (g *gateway) closeDay(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:shift:close") {
		return
	}
	var in struct {
		Date         string          `json:"date"`
		OpeningFloat json.RawMessage `json:"openingFloat"`
		CountedCash  json.RawMessage `json:"countedCash"`
		Note         string          `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	counted, err := parseMoney(in.CountedCash)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "countedCash: "+err.Error())
		return
	}
	req := &pospb.CloseDayRequest{
		Date: in.Date, CountedCash: counted, Note: in.Note,
		IdempotencyKey: idempotencyKey(r),
	}
	if len(in.OpeningFloat) > 0 && string(in.OpeningFloat) != "null" {
		float, err := parseMoney(in.OpeningFloat)
		if err != nil {
			httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "openingFloat: "+err.Error())
			return
		}
		req.OpeningFloat = float
	}
	resp, err := g.pos.CloseDay(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, dayCloseJSON(resp.GetDayClose()))
}

// --- the floor --------------------------------------------------------------

func tableJSON(t *pospb.Table) map[string]any {
	st := strings.ToLower(strings.TrimPrefix(t.GetStatus().String(), "TABLE_STATUS_"))
	out := map[string]any{
		"id": t.GetId(), "label": t.GetLabel(), "seats": t.GetSeats(),
		"area": t.GetArea(), "status": st,
		"partySize": nil, "seatedAt": nil,
		"staffId": nullable(t.GetStaffId()),
		// The parked sale running on this table. The table cannot be cleared
		// while this is set: clearing it would strand a sale nobody can find.
		"orderId": nullable(t.GetOrderId()),
	}
	if t.GetPartySize() > 0 {
		out["partySize"] = t.GetPartySize()
	}
	if s := t.GetSeatedAt(); s != nil {
		out["seatedAt"] = s.AsTime().UTC().Format("2006-01-02T15:04:05Z")
	}
	return out
}

func (g *gateway) listTables(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:read") {
		return
	}
	resp, err := g.pos.ListTables(g.downstream(r, c), &pospb.ListTablesRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetTables()))
	for _, t := range resp.GetTables() {
		out = append(out, tableJSON(t))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) createTable(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:update") {
		return
	}
	var in struct {
		Label string `json:"label"`
		Seats int32  `json:"seats"`
		Area  string `json:"area"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	resp, err := g.pos.CreateTable(g.downstream(r, c), &pospb.CreateTableRequest{
		Label: in.Label, Seats: in.Seats, Area: in.Area,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusCreated, tableJSON(resp.GetTable()))
}

func (g *gateway) updateTable(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:update") {
		return
	}
	// Pointers so null clears a field and omitting it leaves the table alone.
	// Seating a party and clearing a table down are the same request shape with
	// different nulls, and a plain value cannot tell them apart.
	var in struct {
		Status    *string `json:"status"`
		PartySize *int32  `json:"partySize"`
		StaffID   *string `json:"staffId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	req := &pospb.UpdateTableRequest{Id: r.PathValue("id")}
	if in.Status != nil {
		switch *in.Status {
		case "free":
			req.Status = pospb.TableStatus_TABLE_STATUS_FREE
		case "seated":
			req.Status = pospb.TableStatus_TABLE_STATUS_SEATED
		case "ordered":
			req.Status = pospb.TableStatus_TABLE_STATUS_ORDERED
		case "bill_requested":
			req.Status = pospb.TableStatus_TABLE_STATUS_BILL_REQUESTED
		default:
			httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
				"A table is free, seated, ordered or bill_requested.")
			return
		}
	}
	if in.PartySize != nil {
		req.PartySize = *in.PartySize
	} else {
		req.ClearPartySize = false
	}
	if in.StaffID != nil {
		req.StaffId = *in.StaffID
		req.ClearStaff = *in.StaffID == ""
	}
	resp, err := g.pos.UpdateTable(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, tableJSON(resp.GetTable()))
}
