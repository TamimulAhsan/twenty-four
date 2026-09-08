package main

import (
	"encoding/json"
	"net/http"
	"strings"

	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	paymentspb "github.com/twentyfour/platform/gen/go/twentyfour/payments/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The payment routes.
//
// POS is not built, so these are how a payment gets started today. They are not
// scaffolding: the till will call exactly these, and the shape is already what
// it needs. What the till adds is a cart to attach the payment to.
func (g *gateway) registerPayments(mux *http.ServeMux) {
	mux.Handle("GET /api/payments", g.authenticated(g.listPayments))
	mux.Handle("GET /api/payments/methods", g.authenticated(g.listMethods))
	mux.Handle("POST /api/payments/intents", g.authenticated(g.createIntent))
	mux.Handle("POST /api/payments/{id}/refunds", g.authenticated(g.refundPayment))
	mux.Handle("GET /api/payments/{id}", g.authenticated(g.getPayment))
}

func paymentJSON(p *paymentspb.Payment) map[string]any {
	st := strings.ToLower(strings.TrimPrefix(p.GetStatus().String(), "PAYMENT_STATUS_"))
	// The dashboard's vocabulary is narrower than the contract's, because a
	// merchant does not distinguish "authorized" from "captured" on a list.
	// Translating here keeps the contract precise and the screen readable.
	switch st {
	case "authorized":
		st = "pending"
	case "partially_refunded":
		st = "refunded"
	}
	out := map[string]any{
		"id": p.GetId(), "status": st, "method": p.GetMethodKey(),
		"amount":   moneyJSON(p.GetAmount()),
		"refunded": moneyJSON(p.GetRefundedAmount()),
		// Whatever this market's provider returned. Never parsed for meaning.
		"providerReference": nullable(p.GetProviderReference()),
		"orderId":           nullable(p.GetReferenceId()),
		"referenceType":     nullable(p.GetReferenceType()),
		"createdAt":         "",
	}
	if t := p.GetCreatedAt(); t != nil {
		out["createdAt"] = t.AsTime().UTC().Format("2006-01-02T15:04:05Z")
	}
	return out
}

func (g *gateway) listPayments(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "payment:payment:read") {
		return
	}
	q := r.URL.Query()
	resp, err := g.payments.ListPayments(g.downstream(r, c), &paymentspb.ListPaymentsRequest{
		ReferenceType: q.Get("referenceType"), ReferenceId: q.Get("referenceId"),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetPayments()))
	for _, p := range resp.GetPayments() {
		out = append(out, paymentJSON(p))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

// listMethods is what a till renders its tender buttons from. Hardcoding "cash
// or card" is how a platform ends up unable to sell in a market that uses a
// mobile wallet.
func (g *gateway) listMethods(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "payment:payment:read") {
		return
	}
	resp, err := g.payments.ListMethods(g.downstream(r, c), &paymentspb.ListMethodsRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetMethods()))
	for _, m := range resp.GetMethods() {
		out = append(out, map[string]any{
			"key": m.GetKey(), "label": m.GetLabel(),
			"requiresExternalAction": m.GetRequiresExternalAction(),
			"electronic":             m.GetElectronic(),
		})
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) createIntent(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "pos:order:create") {
		return
	}
	var in struct {
		Amount struct {
			Minor    any    `json:"minor"`
			Currency string `json:"currency"`
		} `json:"amount"`
		Method         string            `json:"method"`
		ReferenceType  string            `json:"referenceType"`
		ReferenceID    string            `json:"referenceId"`
		IdempotencyKey string            `json:"idempotencyKey"`
		Metadata       map[string]string `json:"metadata"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	raw, err := json.Marshal(in.Amount)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "An amount is required.")
		return
	}
	amount, err := parseMoney(raw)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "amount: "+err.Error())
		return
	}

	resp, err := g.payments.CreateIntent(g.downstream(r, c), &paymentspb.CreateIntentRequest{
		IdempotencyKey: in.IdempotencyKey,
		Amount:         &commonpb.Money{Minor: amount.GetMinor(), Currency: amount.GetCurrency()},
		MethodKey:      in.Method,
		ReferenceType:  in.ReferenceType, ReferenceId: in.ReferenceID,
		Metadata: in.Metadata,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}

	out := paymentJSON(resp.GetPayment())
	// The one field a caller must act on. Set when something outside the
	// software has to happen: a terminal tapped, a customer sent somewhere. The
	// till opens it and waits; it never assumes a payment completed because the
	// call returned.
	out["externalActionUrl"] = nullable(resp.GetExternalActionUrl())
	httpx.JSON(w, r, http.StatusCreated, out)
}

func (g *gateway) getPayment(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "payment:payment:read") {
		return
	}
	resp, err := g.payments.GetPayment(g.downstream(r, c),
		&paymentspb.GetPaymentRequest{PaymentId: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, paymentJSON(resp.GetPayment()))
}

func (g *gateway) refundPayment(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "payment:refund:create") {
		return
	}
	var in struct {
		Amount         json.RawMessage `json:"amount"`
		Reason         string          `json:"reason"`
		IdempotencyKey string          `json:"idempotencyKey"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	req := &paymentspb.RefundRequest{
		PaymentId: r.PathValue("id"), Reason: in.Reason,
		IdempotencyKey: in.IdempotencyKey,
	}
	// Omitting the amount refunds everything still refundable, which is what a
	// "refund this sale" button means.
	if len(in.Amount) > 0 && string(in.Amount) != "null" {
		amount, err := parseMoney(in.Amount)
		if err != nil {
			httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "amount: "+err.Error())
			return
		}
		req.Amount = &commonpb.Money{Minor: amount.GetMinor(), Currency: amount.GetCurrency()}
	}

	resp, err := g.payments.Refund(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, paymentJSON(resp.GetPayment()))
}
