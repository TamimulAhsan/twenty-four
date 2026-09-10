package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	auditpb "github.com/twentyfour/platform/gen/go/twentyfour/audit/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The trail, read two ways: newest first for the whole business, and everything
// about one thing.
//
// Both are gated on audit:log:read, which an owner holds through the wildcard
// and a manager does not. That is deliberate rather than an oversight: the
// trail names who did what, and a record of the staff visible to the staff is a
// different product decision from a record of the business visible to its
// owner.
func (g *gateway) registerAudit(mux *http.ServeMux) {
	mux.Handle("GET /api/audit", g.authenticated(g.listAudit))
	mux.Handle("GET /api/audit/{subjectType}/{subjectId}", g.authenticated(g.auditTrail))
}

var actorKindNames = map[auditpb.ActorKind]string{
	auditpb.ActorKind_ACTOR_KIND_USER:      "user",
	auditpb.ActorKind_ACTOR_KIND_STAFF:     "staff",
	auditpb.ActorKind_ACTOR_KIND_SYSTEM:    "system",
	auditpb.ActorKind_ACTOR_KIND_ANONYMOUS: "anonymous",
}

func auditJSON(e *auditpb.Entry) map[string]any {
	out := map[string]any{
		"id":          e.GetId(),
		"action":      e.GetAction(),
		"actorKind":   actorKindNames[e.GetActorKind()],
		"actorId":     e.GetActorId(),
		"actor":       e.GetActorLabel(),
		"subjectType": e.GetSubjectType(),
		"subjectId":   e.GetSubjectId(),
		"summary":     e.GetSummary(),
		"source":      e.GetSource(),
		"occurredAt":  e.GetOccurredAt().AsTime(),
	}
	// Detail is JSON held as a string downstream, so it is re-parsed here
	// rather than shipped as an escaped blob the browser has to parse again.
	if d := e.GetDetail(); d != "" {
		var parsed any
		if json.Unmarshal([]byte(d), &parsed) == nil {
			out["detail"] = parsed
		}
	}
	return out
}

func (g *gateway) listAudit(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "audit:log:read") {
		return
	}
	q := r.URL.Query()
	size := 0
	if n, err := strconv.Atoi(q.Get("pageSize")); err == nil {
		size = n
	}
	resp, err := g.audit.ListEntries(g.downstream(r, c), &auditpb.ListEntriesRequest{
		Action: q.Get("action"), ActorId: q.Get("actorId"),
		PageSize: int32(size), PageToken: q.Get("pageToken"),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetEntries()))
	for _, e := range resp.GetEntries() {
		out = append(out, auditJSON(e))
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"entries": out, "nextPageToken": resp.GetNextPageToken(),
	})
}

func (g *gateway) auditTrail(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "audit:log:read") {
		return
	}
	resp, err := g.audit.Trail(g.downstream(r, c), &auditpb.TrailRequest{
		SubjectType: r.PathValue("subjectType"),
		SubjectId:   r.PathValue("subjectId"),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetEntries()))
	for _, e := range resp.GetEntries() {
		out = append(out, auditJSON(e))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}
