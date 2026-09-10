package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/twentyfour/platform/services/notification/internal/desk"
	"github.com/twentyfour/platform/services/notification/internal/store"
)

// The message desk: this transport's stand-in for a provider's dashboard.
//
// HTTP and not gRPC, and not part of NotificationService, for the same reason
// the payment desk is not part of PaymentsService. No provider exposes "show me
// what you would have sent" on its sending API; it exposes a console.
type deskHandler struct{ st *store.Store }

func (d *deskHandler) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /messages/{$}", d.list)
	mux.HandleFunc("GET /messages/recent.json", d.recentJSON)
	mux.HandleFunc("GET /messages/{id}", d.show)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return mux
}

// view is a separate shape from store.Delivery so a template cannot reach a
// field that should not be on a page: the idempotency key and the tenant are
// not the reader's business.
type view struct {
	ID            string
	TemplateKey   string
	Channel       string
	Category      string
	Status        string
	StatusLabel   string
	Recipient     string
	Subject       string
	Body          string
	ReferenceType string
	ReferenceID   string
	FailureReason string
	Age           string
}

func toView(d store.Delivery) view {
	label := map[string]string{
		"queued":     "Queued",
		"held":       "Held until quiet hours end",
		"sent":       "Sent",
		"failed":     "Failed",
		"suppressed": "Not sent",
	}[d.Status]
	if label == "" {
		label = d.Status
	}
	return view{
		ID: d.ID.String(), TemplateKey: d.TemplateKey, Channel: d.Channel,
		Category: d.Category, Status: d.Status, StatusLabel: label,
		Recipient: d.Recipient, Subject: d.Subject, Body: d.Body,
		ReferenceType: d.ReferenceType, ReferenceID: d.ReferenceID,
		FailureReason: d.FailureReason,
		Age:           age(d.CreatedAt),
	}
}

func age(t time.Time) string {
	d := time.Since(t).Round(time.Second)
	if d < time.Minute {
		return d.String()
	}
	return d.Round(time.Minute).String()
}

func (d *deskHandler) list(w http.ResponseWriter, r *http.Request) {
	list, err := d.st.Recent(r.Context(), 40)
	if err != nil {
		http.Error(w, "could not read the desk", http.StatusInternalServerError)
		return
	}
	views := make([]view, 0, len(list))
	for _, m := range list {
		views = append(views, toView(m))
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := desk.Templates.ExecuteTemplate(w, "desk.html", map[string]any{
		"Deliveries": views, "Base": "/messages",
	}); err != nil {
		slog.Error("render desk", "err", err)
	}
}

// recentJSON is what a tab opener polls, mirroring the payment desk, so a
// specialist can watch invitations arrive without refreshing a page.
func (d *deskHandler) recentJSON(w http.ResponseWriter, r *http.Request) {
	list, err := d.st.Recent(r.Context(), 40)
	if err != nil {
		http.Error(w, "could not read the desk", http.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, m := range list {
		out = append(out, map[string]any{
			"id": m.ID.String(), "template": m.TemplateKey, "channel": m.Channel,
			"recipient": m.Recipient, "subject": m.Subject, "status": m.Status,
			"createdAt": m.CreatedAt.UTC(),
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
	m, err := d.st.Unscoped(r.Context(), id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := desk.Templates.ExecuteTemplate(w, "message.html", map[string]any{
		"Message": toView(m), "Base": "/messages",
	}); err != nil {
		slog.Error("render message", "err", err)
	}
}
