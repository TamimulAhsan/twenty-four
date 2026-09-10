package main

import (
	"net/http"

	supportpb "github.com/twentyfour/platform/gen/go/twentyfour/support/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The merchant's side of impersonation: seeing who has looked, and stopping one
// that is running.
//
// Nothing prompts them to come here. A specialist starts a session through the
// admin gateway, on its own host, without asking. What lives on this side is
// the record and the off switch, which are worth keeping precisely because
// nobody is notified: a merchant who goes looking should find a full answer and
// a way to act on it.
func (g *gateway) registerSupport(mux *http.ServeMux) {
	mux.Handle("GET /api/support/requests", g.authenticated(g.supportRequests))
	mux.Handle("DELETE /api/support/requests/{id}", g.authenticated(g.revokeSupport))
	mux.Handle("GET /api/support/sessions", g.authenticated(g.supportSessions))
}

var supportStateNames = map[supportpb.RequestState]string{
	supportpb.RequestState_REQUEST_STATE_APPROVED: "live",
	supportpb.RequestState_REQUEST_STATE_REVOKED:  "stopped",
	supportpb.RequestState_REQUEST_STATE_EXPIRED:  "expired",
}

var supportScopeNames = map[supportpb.Scope]string{
	supportpb.Scope_SCOPE_READ_ONLY:     "read_only",
	supportpb.Scope_SCOPE_ACT_ON_BEHALF: "act_on_behalf",
	supportpb.Scope_SCOPE_UNSPECIFIED:   "",
}

func supportRequestJSON(r *supportpb.AccessRequest) map[string]any {
	out := map[string]any{
		"id": r.GetId(), "specialist": r.GetSpecialistName(),
		"specialistId": r.GetSpecialistId(), "reason": r.GetReason(),
		"scope": supportScopeNames[r.GetScope()], "state": supportStateNames[r.GetState()],
		"createdAt": r.GetCreatedAt().AsTime(),
	}
	if t := r.GetExpiresAt(); t.IsValid() {
		out["expiresAt"] = t.AsTime()
	}
	return out
}

// Reading who has looked needs no permission beyond being signed in. A member
// of staff seeing that somebody at TwentyFour opened their books is the whole
// of what transparency means here; stopping one is the part that is gated.
func (g *gateway) supportRequests(w http.ResponseWriter, r *http.Request, c caller) {
	resp, err := g.support.ListRequests(g.downstream(r, c), &supportpb.ListRequestsRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetRequests()))
	for _, req := range resp.GetRequests() {
		out = append(out, supportRequestJSON(req))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) revokeSupport(w http.ResponseWriter, r *http.Request, c caller) {
	// Stopping the vendor reading your books is an owner's act, which is the
	// closest thing in the vocabulary to "this person speaks for the business".
	if !g.requirePermission(w, r, c, "tenant:billing:manage") {
		return
	}
	resp, err := g.support.RevokeAccess(g.downstream(r, c),
		&supportpb.RevokeAccessRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"request": supportRequestJSON(resp.GetRequest()),
		// Said out loud, because the merchant clicking this wants to know
		// whether somebody was actually looking at the time.
		"sessionsEnded": resp.GetSessionsEnded(),
	})
}

func (g *gateway) supportSessions(w http.ResponseWriter, r *http.Request, c caller) {
	resp, err := g.support.ListSessions(g.downstream(r, c), &supportpb.ListSessionsRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetSessions()))
	for _, s := range resp.GetSessions() {
		row := map[string]any{
			"id": s.GetId(), "specialist": s.GetSpecialistName(),
			"scope": supportScopeNames[s.GetScope()], "active": s.GetActive(),
			"startedAt": s.GetStartedAt().AsTime(),
			"expiresAt": s.GetExpiresAt().AsTime(),
		}
		if t := s.GetEndedAt(); t.IsValid() {
			row["endedAt"] = t.AsTime()
		}
		out = append(out, row)
	}
	httpx.JSON(w, r, http.StatusOK, out)
}
