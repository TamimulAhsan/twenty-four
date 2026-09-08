package main

import (
	"encoding/json"
	"net/http"
	"strings"

	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	pospb "github.com/twentyfour/platform/gen/go/twentyfour/pos/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The till's routes.
func (g *gateway) registerOrders(mux *http.ServeMux) {
	mux.Handle("GET /api/orders", g.authenticated(g.listOrders))
	mux.Handle("POST /api/orders", g.authenticated(g.placeOrder))
	mux.Handle("POST /api/orders/abandon", g.authenticated(g.abandonCheckout))
	mux.Handle("GET /api/orders/takings", g.authenticated(g.takings))
	mux.Handle("GET /api/orders/day-close", g.authenticated(g.getDayClose))
	mux.Handle("POST /api/orders/day-close", g.authenticated(g.closeDay))
	mux.Handle("GET /api/orders/parked", g.authenticated(g.listParked))
	mux.Handle("POST /api/orders/parked", g.authenticated(g.parkOrder))
	mux.Handle("PATCH /api/orders/parked/{id}", g.authenticated(g.updateParked))
	mux.Handle("DELETE /api/orders/parked/{id}", g.authenticated(g.discardParked))
	mux.Handle("POST /api/orders/parked/{id}/settle", g.authenticated(g.settleParked))
	mux.Handle("GET /api/orders/{id}", g.authenticated(g.getOrder))
	mux.Handle("POST /api/orders/{id}/void", g.authenticated(g.voidOrder))
	mux.Handle("POST /api/orders/{id}/refund", g.authenticated(g.refundOrder))

	mux.Handle("GET /api/tables", g.authenticated(g.listTables))
	mux.Handle("POST /api/tables", g.authenticated(g.createTable))
	mux.Handle("PATCH /api/tables/{id}", g.authenticated(g.updateTable))
}

// --- wire shapes ------------------------------------------------------------

func orderJSON(o *pospb.Order) map[string]any {
	st := strings.ToLower(strings.TrimPrefix(o.GetStatus().String(), "ORDER_STATUS_"))
	lines := make([]map[string]any, 0, len(o.GetLines()))
	refundedIDs := make([]string, 0)
	for _, l := range o.GetLines() {
		lines = append(lines, map[string]any{
			"id": l.GetId(), "itemId": l.GetItemId(), "name": l.GetName(),
			"quantity":  l.GetQuantity(),
			"unitPrice": moneyJSON(l.GetUnitPrice()),
			// Flat here, nested in the contract. The dashboard reads a number
			// and the service reads a message; translating is the gateway's job.
			"taxBasisPoints": l.GetTaxRate().GetBasisPoints(),
			"taxIncluded":    l.GetTaxIncluded(),
			// null rather than zero: a line with no discount is not a line
			// discounted by nothing.
			"discount": nullableMoney(l.GetDiscount()),
			"gross":    moneyJSON(l.GetGross()),
			"net":      moneyJSON(l.GetNet()),
			"tax":      moneyJSON(l.GetTax()),
		})
		if l.GetRefunded() {
			refundedIDs = append(refundedIDs, l.GetId())
		}
	}
	tenders := make([]map[string]any, 0, len(o.GetTenders()))
	for _, t := range o.GetTenders() {
		tenders = append(tenders, map[string]any{
			"id": t.GetId(), "method": t.GetMethod(),
			"amount": moneyJSON(t.GetAmount()),
			// Cash only. Change exists in a drawer, not in a provider.
			"tendered":  nullableMoney(t.GetTendered()),
			"change":    nullableMoney(t.GetChange()),
			"reference": nullable(t.GetReference()),
		})
	}
	out := map[string]any{
		"id": o.GetId(), "number": o.GetNumber(), "status": st,
		"placedAt":     "",
		"customerId":   nullable(o.GetCustomerId()),
		"customerName": nullable(o.GetCustomerName()),
		"discountCode": nullable(o.GetDiscountCode()),
		"discount":     nullableMoney(o.GetDiscount()),
		"lines":        lines,
		"gross":        moneyJSON(o.GetGross()),
		"net":          moneyJSON(o.GetNet()),
		"tax":          moneyJSON(o.GetTax()),
		"tenders":      tenders,
		"staffId":      nullable(o.GetStaffId()),
		"note":         o.GetNote(),
		"tableId":      nullable(o.GetTableId()),
		"refunded":     moneyJSON(o.GetRefunded()),
		// A line goes back once, and the screen keeps the button out of the way
		// using this rather than by guessing from the status.
		"refundedLineIds": refundedIDs,
	}
	if t := o.GetPlacedAt(); t != nil {
		out["placedAt"] = t.AsTime().UTC().Format("2006-01-02T15:04:05Z")
	}
	return out
}

// nullableMoney sends null for an absent amount rather than a zero, because
// "no discount" and "a discount of nothing" are different facts.
func nullableMoney(m *commonpb.Money) any {
	if m == nil || m.GetMinor() == 0 {
		return nil
	}
	return moneyJSON(m)
}

func lineInputs(raw []struct {
	ItemID   string          `json:"itemId"`
	Quantity int32           `json:"quantity"`
	Discount json.RawMessage `json:"discount"`
}) ([]*pospb.LineInput, error) {
	out := make([]*pospb.LineInput, 0, len(raw))
	for _, l := range raw {
		in := &pospb.LineInput{ItemId: l.ItemID, Quantity: l.Quantity}
		if len(l.Discount) > 0 && string(l.Discount) != "null" {
			m, err := parseMoney(l.Discount)
			if err != nil {
				return nil, err
			}
			in.DiscountMinor = m.GetMinor()
		}
		out = append(out, in)
	}
	return out, nil
}

func tenderInputs(raw []struct {
	Method   string          `json:"method"`
	Amount   json.RawMessage `json:"amount"`
	Tendered json.RawMessage `json:"tendered"`
}) ([]*pospb.TenderInput, error) {
	out := make([]*pospb.TenderInput, 0, len(raw))
	for _, t := range raw {
		in := &pospb.TenderInput{Method: t.Method}
		amount, err := parseMoney(t.Amount)
		if err != nil {
			return nil, err
		}
		in.Amount = amount
		if len(t.Tendered) > 0 && string(t.Tendered) != "null" {
			handed, err := parseMoney(t.Tendered)
			if err != nil {
				return nil, err
			}
			in.Tendered = handed
		}
		out = append(out, in)
	}
	return out, nil
}

type saleBody struct {
	Lines []struct {
		ItemID   string          `json:"itemId"`
		Quantity int32           `json:"quantity"`
		Discount json.RawMessage `json:"discount"`
	} `json:"lines"`
	Tenders []struct {
		Method   string          `json:"method"`
		Amount   json.RawMessage `json:"amount"`
		Tendered json.RawMessage `json:"tendered"`
	} `json:"tenders"`
	Note         string  `json:"note"`
	StaffID      string  `json:"staffId"`
	CustomerID   string  `json:"customerId"`
	DiscountCode string  `json:"discountCode"`
	TableID      *string `json:"tableId"`
}

func decodeSale(w http.ResponseWriter, r *http.Request) (saleBody, bool) {
	var in saleBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return saleBody{}, false
	}
	return in, true
}

// --- selling ----------------------------------------------------------------

func (g *gateway) placeOrder(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:create") {
		return
	}
	in, ok := decodeSale(w, r)
	if !ok {
		return
	}
	lines, err := lineInputs(in.Lines)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, err.Error())
		return
	}
	tenders, err := tenderInputs(in.Tenders)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, err.Error())
		return
	}

	resp, err := g.pos.PlaceOrder(g.downstream(r, c), &pospb.PlaceOrderRequest{
		Lines: lines, Tenders: tenders, Note: in.Note,
		StaffId: in.StaffID, CustomerId: in.CustomerID,
		DiscountCode: in.DiscountCode,
		// The till generates this, because a retried checkout without one is a
		// double charge and the client is the only thing that knows a retry is
		// a retry.
		IdempotencyKey: idempotencyKey(r),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	if action := resp.GetAwaiting(); action != nil {
		awaitingJSON(w, r, action)
		return
	}
	httpx.JSON(w, r, http.StatusCreated, orderJSON(resp.GetOrder()))
}

// awaitingJSON answers a checkout that cannot finish without a person.
//
// 202 rather than 201, because nothing was created: no sale exists yet and the
// till must not print a receipt for one. The status field is what the client
// actually branches on, since a body is easier to read than a code.
//
// The URL goes to the browser rather than being followed here. Whatever is at
// the other end is for the customer, not for the gateway: a hosted page, a
// bank's app, a terminal's own screen.
func awaitingJSON(w http.ResponseWriter, r *http.Request, action *pospb.PaymentAction) {
	httpx.JSON(w, r, http.StatusAccepted, map[string]any{
		"status":     "awaiting_payment",
		"checkoutId": action.GetCheckoutId(),
		"paymentId":  action.GetPaymentId(),
		"method":     action.GetMethodKey(),
		"url":        action.GetUrl(),
		"amount":     moneyJSON(action.GetAmount()),
	})
}

// abandonCheckout gives back the money of a checkout nobody finished.
func (g *gateway) abandonCheckout(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:create") {
		return
	}
	var in struct {
		CheckoutID string `json:"checkoutId"`
		Reason     string `json:"reason"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	resp, err := g.pos.AbandonCheckout(g.downstream(r, c), &pospb.AbandonCheckoutRequest{
		CheckoutId: in.CheckoutID, Reason: in.Reason,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{"released": resp.GetReleased()})
}

// idempotencyKey reads the header the API client sends on every mutating call.
func idempotencyKey(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("Idempotency-Key"))
}

func (g *gateway) getOrder(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:read") {
		return
	}
	resp, err := g.pos.GetOrder(g.downstream(r, c), &pospb.GetOrderRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, orderJSON(resp.GetOrder()))
}

func (g *gateway) listOrders(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:read") {
		return
	}
	q := r.URL.Query()
	resp, err := g.pos.ListOrders(g.downstream(r, c), &pospb.ListOrdersRequest{
		From: q.Get("from"), To: q.Get("to"),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetOrders()))
	for _, o := range resp.GetOrders() {
		out = append(out, orderJSON(o))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) voidOrder(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:void") {
		return
	}
	var in struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in)
	resp, err := g.pos.VoidOrder(g.downstream(r, c), &pospb.VoidOrderRequest{
		Id: r.PathValue("id"), Reason: in.Reason, IdempotencyKey: idempotencyKey(r),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, orderJSON(resp.GetOrder()))
}

func (g *gateway) refundOrder(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:refund:create") {
		return
	}
	var in struct {
		LineIDs []string `json:"lineIds"`
		Reason  string   `json:"reason"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in)
	resp, err := g.pos.RefundOrder(g.downstream(r, c), &pospb.RefundOrderRequest{
		Id: r.PathValue("id"), LineIds: in.LineIDs, Reason: in.Reason,
		IdempotencyKey: idempotencyKey(r),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, orderJSON(resp.GetOrder()))
}

// --- parked sales -----------------------------------------------------------

func (g *gateway) listParked(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:read") {
		return
	}
	resp, err := g.pos.ListParked(g.downstream(r, c), &pospb.ListParkedRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetOrders()))
	for _, o := range resp.GetOrders() {
		out = append(out, orderJSON(o))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) parkOrder(w http.ResponseWriter, r *http.Request, c caller) {
	// Parking is not selling: it takes no money, so it needs no permission to
	// take money. It is still a write, so it needs one to ring up a sale.
	if !g.requirePermission(w, r, c, "pos:order:create") {
		return
	}
	in, ok := decodeSale(w, r)
	if !ok {
		return
	}
	lines, err := lineInputs(in.Lines)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, err.Error())
		return
	}
	req := &pospb.ParkOrderRequest{
		Lines: lines, Note: in.Note, StaffId: in.StaffID,
		CustomerId: in.CustomerID, IdempotencyKey: idempotencyKey(r),
	}
	if in.TableID != nil {
		req.TableId = *in.TableID
	}
	resp, err := g.pos.ParkOrder(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusCreated, orderJSON(resp.GetOrder()))
}

func (g *gateway) updateParked(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:update") {
		return
	}
	in, ok := decodeSale(w, r)
	if !ok {
		return
	}
	lines, err := lineInputs(in.Lines)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, err.Error())
		return
	}
	req := &pospb.UpdateParkedRequest{
		Id: r.PathValue("id"), Lines: lines, Note: in.Note,
		StaffId: in.StaffID, CustomerId: in.CustomerID,
	}
	// null clears the table, omitting it leaves the tab where it is. A plain
	// string cannot express the difference.
	if in.TableID != nil {
		req.TableId = *in.TableID
		req.ClearTable = *in.TableID == ""
	}
	resp, err := g.pos.UpdateParked(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, orderJSON(resp.GetOrder()))
}

func (g *gateway) discardParked(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:update") {
		return
	}
	if _, err := g.pos.DiscardParked(g.downstream(r, c),
		&pospb.DiscardParkedRequest{Id: r.PathValue("id")}); err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.NoContent(w)
}

func (g *gateway) settleParked(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:create") {
		return
	}
	in, ok := decodeSale(w, r)
	if !ok {
		return
	}
	tenders, err := tenderInputs(in.Tenders)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, err.Error())
		return
	}
	resp, err := g.pos.SettleParked(g.downstream(r, c), &pospb.SettleParkedRequest{
		Id: r.PathValue("id"), Tenders: tenders, IdempotencyKey: idempotencyKey(r),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	if action := resp.GetAwaiting(); action != nil {
		awaitingJSON(w, r, action)
		return
	}
	httpx.JSON(w, r, http.StatusOK, orderJSON(resp.GetOrder()))
}
