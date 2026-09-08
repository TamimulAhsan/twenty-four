package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/twentyfour/platform/services/payments/internal/manual"
	"github.com/twentyfour/platform/services/payments/internal/store"
)

// The approval desk: this provider's stand-in for a card terminal.
//
// It is HTTP and not gRPC, and it is not part of PaymentsService, because no
// real provider exposes an Approve call. What a real provider exposes is a
// hosted page the customer is sent to, and this sits in exactly that place.
//
// It is unauthenticated on purpose. Whoever is standing at the terminal is not
// signed in as anybody: they are the customer, or the person holding the card
// machine. Knowing the payment's UUID is what stands in for holding the card,
// which is thin, and is why this provider must never be deployed anywhere real.
type deskHandler struct{ st *store.Store }

func (d *deskHandler) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /pay/{$}", d.desk)
	mux.HandleFunc("GET /pay/pending.json", d.pendingJSON)
	mux.HandleFunc("GET /pay/{id}", d.show)
	mux.HandleFunc("POST /pay/{id}/decide", d.decide)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return mux
}

// view is what the templates render. It is a separate shape from store.Payment
// so a template cannot reach a field that should not be on a screen a customer
// might be looking at.
type view struct {
	ID                string
	AmountMinor       int64
	RefundedMinor     int64
	Currency          string
	MethodLabel       string
	Status            string
	StatusLabel       string
	ReferenceType     string
	ReferenceID       string
	ProviderReference string
	Age               string
	Pending           bool
	Good              bool
}

func toView(p store.Payment) view {
	label := p.MethodKey
	if m, ok := manual.MethodByKey(p.MethodKey); ok {
		label = m.Label
	}
	statusLabel := map[string]string{
		"pending":            "Waiting",
		"captured":           "Approved",
		"failed":             "Declined",
		"refunded":           "Refunded",
		"partially_refunded": "Partly refunded",
		"cancelled":          "Cancelled",
		"authorized":         "Held",
	}[p.Status]
	if statusLabel == "" {
		statusLabel = p.Status
	}
	return view{
		ID: p.ID.String(), AmountMinor: p.AmountMinor, RefundedMinor: p.RefundedMinor,
		Currency: p.Currency, MethodLabel: label, Status: p.Status, StatusLabel: statusLabel,
		ReferenceType: p.ReferenceType, ReferenceID: p.ReferenceID,
		ProviderReference: p.ProviderReference,
		Age:               age(p.CreatedAt),
		Pending:           p.Status == "pending",
		Good:              p.Status == "captured" || p.Status == "authorized",
	}
}

func age(t time.Time) string {
	d := time.Since(t).Round(time.Second)
	switch {
	case d < time.Minute:
		return d.String()
	case d < time.Hour:
		return d.Round(time.Minute).String()
	default:
		return d.Round(time.Minute).String()
	}
}

func (d *deskHandler) desk(w http.ResponseWriter, r *http.Request) {
	list, err := d.st.Pending(r.Context(), 20)
	if err != nil {
		http.Error(w, "could not read the desk", http.StatusInternalServerError)
		return
	}
	views := make([]view, 0, len(list))
	for _, p := range list {
		views = append(views, toView(p))
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := manual.Templates.ExecuteTemplate(w, "desk.html", map[string]any{
		"Pending": views, "Base": "/pay",
	}); err != nil {
		slog.Error("render desk", "err", err)
	}
}

// pendingJSON is what the tab opener polls. A page cannot open its own tabs
// unprompted, so the thing that opens one runs on the host.
func (d *deskHandler) pendingJSON(w http.ResponseWriter, r *http.Request) {
	list, err := d.st.Pending(r.Context(), 20)
	if err != nil {
		http.Error(w, "could not read the desk", http.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, p := range list {
		out = append(out, map[string]any{
			"id": p.ID.String(), "minor": p.AmountMinor, "currency": p.Currency,
			"method": p.MethodKey, "referenceType": p.ReferenceType,
			"referenceId": p.ReferenceID, "createdAt": p.CreatedAt.UTC(),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (d *deskHandler) show(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	p, err := d.st.Unscoped(r.Context(), id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := manual.Templates.ExecuteTemplate(w, "pay.html", map[string]any{
		"Payment": toView(p), "Base": "/pay",
	}); err != nil {
		slog.Error("render payment", "err", err)
	}
}

// decide is the human acting as the processor.
//
// Approving goes straight to captured rather than to authorised, because most
// markets settle in one step and a two-step flow nobody exercises is a two-step
// flow that will be wrong when somebody finally does. The Capture RPC still
// exists for a market that separates them.
func (d *deskHandler) decide(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}

	approved := r.PostForm.Get("decision") == "approve"
	to, reason := "failed", "declined at the terminal"
	if approved {
		to, reason = "captured", ""
	}

	// Legal only from pending, so a second click on a stale tab cannot flip a
	// settled payment. The redirect afterwards shows what it actually is.
	if _, err := d.st.Settle(r.Context(), id, to, reason, "", "pending"); err != nil {
		slog.Warn("decision ignored", "payment", id, "err", err)
	} else {
		slog.Info("decided at the desk", "payment", id, "approved", approved)
	}
	// See-other so a refresh does not re-post the decision.
	http.Redirect(w, r, "/pay/"+id.String(), http.StatusSeeOther)
}
