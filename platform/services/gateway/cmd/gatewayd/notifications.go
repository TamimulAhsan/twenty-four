package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	notificationpb "github.com/twentyfour/platform/gen/go/twentyfour/notification/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

func (g *gateway) registerNotifications(mux *http.ServeMux) {
	mux.Handle("GET /api/settings/notifications", g.authenticated(g.notificationPrefs))
	mux.Handle("PATCH /api/settings/notifications", g.authenticated(g.updateNotificationPrefs))
	// The delivery log, read beside the thing it concerns. It is the answer to
	// "did the customer get their receipt", which is a support question long
	// before it is a reporting one.
	mux.Handle("GET /api/messages", g.authenticated(g.listMessages))
}

var channelNames = map[notificationpb.Channel]string{
	notificationpb.Channel_CHANNEL_EMAIL: "email",
	notificationpb.Channel_CHANNEL_SMS:   "sms",
	notificationpb.Channel_CHANNEL_PUSH:  "push",
}

var channelValues = map[string]notificationpb.Channel{
	"email": notificationpb.Channel_CHANNEL_EMAIL,
	"sms":   notificationpb.Channel_CHANNEL_SMS,
	"push":  notificationpb.Channel_CHANNEL_PUSH,
}

func prefsJSON(p *notificationpb.Preferences) map[string]any {
	channels := make([]string, 0, len(p.GetChannels()))
	for _, c := range p.GetChannels() {
		if name, ok := channelNames[c]; ok {
			channels = append(channels, name)
		}
	}
	return map[string]any{
		"channels":         channels,
		"quietFrom":        p.GetQuietFrom(),
		"quietTo":          p.GetQuietTo(),
		"timeZone":         p.GetTimeZone(),
		"bookingReminders": p.GetBookingReminders(),
		"receiptByEmail":   p.GetReceiptByEmail(),
		"marketing":        p.GetMarketing(),
	}
}

func (g *gateway) notificationPrefs(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "tenant:profile:update") {
		return
	}
	resp, err := g.notification.GetPreferences(g.downstream(r, c),
		&notificationpb.GetPreferencesRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, prefsJSON(resp.GetPreferences()))
}

func (g *gateway) updateNotificationPrefs(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "tenant:profile:update") {
		return
	}
	// Pointers, so an absent field is distinguishable from a false one. A
	// merchant switching off marketing must not also switch off reminders
	// because the form only sent the field it changed.
	var in struct {
		Channels         *[]string `json:"channels"`
		QuietFrom        *string   `json:"quietFrom"`
		QuietTo          *string   `json:"quietTo"`
		TimeZone         *string   `json:"timeZone"`
		BookingReminders *bool     `json:"bookingReminders"`
		ReceiptByEmail   *bool     `json:"receiptByEmail"`
		Marketing        *bool     `json:"marketing"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}

	prefs := &notificationpb.Preferences{}
	var mask []string
	if in.Channels != nil {
		for _, name := range *in.Channels {
			ch, ok := channelValues[strings.ToLower(name)]
			if !ok {
				httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
					"We can send by email, SMS or push, and nothing else yet.")
				return
			}
			prefs.Channels = append(prefs.Channels, ch)
		}
		mask = append(mask, "channels")
	}
	if in.QuietFrom != nil {
		prefs.QuietFrom = *in.QuietFrom
		mask = append(mask, "quiet_from")
	}
	if in.QuietTo != nil {
		prefs.QuietTo = *in.QuietTo
		mask = append(mask, "quiet_to")
	}
	if in.TimeZone != nil {
		prefs.TimeZone = *in.TimeZone
		mask = append(mask, "time_zone")
	}
	if in.BookingReminders != nil {
		prefs.BookingReminders = *in.BookingReminders
		mask = append(mask, "booking_reminders")
	}
	if in.ReceiptByEmail != nil {
		prefs.ReceiptByEmail = *in.ReceiptByEmail
		mask = append(mask, "receipt_by_email")
	}
	if in.Marketing != nil {
		prefs.Marketing = *in.Marketing
		mask = append(mask, "marketing")
	}
	if len(mask) == 0 {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "There is nothing to change.")
		return
	}

	resp, err := g.notification.UpdatePreferences(g.downstream(r, c),
		&notificationpb.UpdatePreferencesRequest{Preferences: prefs, UpdateMask: mask})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, prefsJSON(resp.GetPreferences()))
}

func (g *gateway) listMessages(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "tenant:profile:update") {
		return
	}
	req := &notificationpb.ListDeliveriesRequest{
		ReferenceType: r.URL.Query().Get("referenceType"),
		ReferenceId:   r.URL.Query().Get("referenceId"),
		PageToken:     r.URL.Query().Get("pageToken"),
	}
	resp, err := g.notification.ListDeliveries(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	statusNames := map[notificationpb.Status]string{
		notificationpb.Status_STATUS_QUEUED:     "queued",
		notificationpb.Status_STATUS_HELD:       "held",
		notificationpb.Status_STATUS_SENT:       "sent",
		notificationpb.Status_STATUS_FAILED:     "failed",
		notificationpb.Status_STATUS_SUPPRESSED: "suppressed",
	}
	out := make([]map[string]any, 0, len(resp.GetDeliveries()))
	for _, d := range resp.GetDeliveries() {
		out = append(out, map[string]any{
			"id":            d.GetId(),
			"template":      d.GetTemplateKey(),
			"channel":       channelNames[d.GetChannel()],
			"status":        statusNames[d.GetStatus()],
			"recipient":     d.GetRecipient(),
			"subject":       d.GetSubject(),
			"referenceType": d.GetReferenceType(),
			"referenceId":   d.GetReferenceId(),
			"reason":        d.GetFailureReason(),
			"createdAt":     d.GetCreatedAt().AsTime(),
		})
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"messages": out, "nextPageToken": resp.GetNextPageToken(),
	})
}

// acceptURL is where an invitation link points.
//
// Built here rather than in Notification, because the address of the merchant
// applications is the gateway's business: Notification composes messages and
// has no opinion about where this deployment serves its sign-in form.
func (g *gateway) acceptURL(token string) string {
	return g.appURL + "/auth/invite?token=" + url.QueryEscape(token)
}

// sendInvitation asks Notification for the invitation email.
//
// It replaces the log line that stood in for this while there was no service to
// ask. Failure is deliberately not fatal to the invitation: the staff record
// exists, the token exists, and refusing to add somebody to a rota because a
// mail service hiccupped would be the "a third party being down must never
// block a sale" rule broken in a smaller way.
func (g *gateway) sendInvitation(ctx context.Context, r *http.Request, email, name, token, acceptURL string) {
	if email == "" || token == "" {
		return
	}
	_, err := g.notification.Send(ctx, &notificationpb.SendRequest{
		TemplateKey: "staff.invitation",
		Category:    notificationpb.Category_CATEGORY_TRANSACTIONAL,
		Recipient:   email,
		Params: map[string]string{
			"name":       name,
			"accept_url": acceptURL,
			"expires_in": "seven days",
		},
		ReferenceType: "staff_invitation",
		// Keyed on the token, so reissuing an invitation sends a new message
		// and a retried request does not send a second copy of the same one.
		IdempotencyKey: "invite:" + token,
	})
	if err != nil {
		slog.Error("could not send the invitation", "err", err, "email", email,
			"request_id", httpx.RequestID(r))
		// Still logged, so a specialist can finish onboarding by hand rather
		// than being stuck behind a service that is down.
		slog.Warn("invitation issued but not sent", "email", email,
			"accept_token", token, "request_id", httpx.RequestID(r))
	}
}
