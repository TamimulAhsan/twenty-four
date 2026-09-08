package main

import (
	"encoding/json"
	"net/http"
	"strings"

	inventorypb "github.com/twentyfour/platform/gen/go/twentyfour/inventory/v1"
	staffpb "github.com/twentyfour/platform/gen/go/twentyfour/staff/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The team and stock routes.
func (g *gateway) registerTeamAndStock(mux *http.ServeMux) {
	mux.Handle("GET /api/staff", g.authenticated(g.listStaff))
	mux.Handle("POST /api/staff/invitations", g.authenticated(g.inviteStaff))
	mux.Handle("PATCH /api/staff/{id}", g.authenticated(g.updateStaff))
	mux.Handle("POST /api/staff/{id}/invitation", g.authenticated(g.reissueInvitation))
	mux.Handle("DELETE /api/staff/{id}", g.authenticated(g.removeStaff))

	mux.Handle("GET /api/inventory/levels", g.authenticated(g.listLevels))
	mux.Handle("POST /api/inventory/adjustments", g.authenticated(g.adjustStock))
	mux.Handle("PUT /api/inventory/thresholds/{itemId}", g.authenticated(g.setThreshold))
}

// --- team -------------------------------------------------------------------

func memberJSON(m *staffpb.Member, selfID string) map[string]any {
	st := strings.ToLower(strings.TrimPrefix(m.GetStatus().String(), "MEMBER_STATUS_"))
	out := map[string]any{
		"id": m.GetId(), "name": m.GetName(), "email": m.GetEmail(),
		"role": m.GetRoleKey(), "status": st, "colour": m.GetColour(),
		"invitedAt": nil, "lastActiveAt": nil,
		// The rules that stop a team locking itself out all key off this, so
		// the server states it rather than leaving the client to compare IDs
		// and get it wrong on one screen out of six.
		"isSelf": m.GetId() == selfID,
	}
	if t := m.GetInvitedAt(); t != nil {
		out["invitedAt"] = t.AsTime().UTC().Format("2006-01-02T15:04:05Z")
	}
	if t := m.GetLastActiveAt(); t != nil {
		out["lastActiveAt"] = t.AsTime().UTC().Format("2006-01-02T15:04:05Z")
	}
	return out
}

func (g *gateway) listStaff(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "staff:member:read") {
		return
	}
	resp, err := g.staff.ListMembers(g.downstream(r, c),
		&staffpb.ListMembersRequest{IncludeDeactivated: true})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetMembers()))
	for _, m := range resp.GetMembers() {
		out = append(out, memberJSON(m, c.UserID))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) inviteStaff(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "staff:member:create") {
		return
	}
	var in struct {
		Email string `json:"email"`
		Name  string `json:"name"`
		Role  string `json:"role"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	resp, err := g.staff.InviteMember(g.downstream(r, c), &staffpb.InviteMemberRequest{
		Email: in.Email, Name: in.Name, RoleKey: in.Role,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	// There is no Notification service yet, so the link is logged rather than
	// sent. It is logged at the gateway as well as at Staff because this is
	// where someone testing the flow is already looking.
	if tok := resp.GetInviteToken(); tok != "" {
		logInviteToken(r, resp.GetMember().GetEmail(), tok)
	}
	httpx.JSON(w, r, http.StatusCreated, memberJSON(resp.GetMember(), c.UserID))
}

func (g *gateway) updateStaff(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "staff:member:update") {
		return
	}
	var in struct {
		Role   string `json:"role"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	req := &staffpb.UpdateMemberRequest{Id: r.PathValue("id"), RoleKey: in.Role}
	switch in.Status {
	case "active":
		req.Status = staffpb.MemberStatus_MEMBER_STATUS_ACTIVE
	case "deactivated":
		req.Status = staffpb.MemberStatus_MEMBER_STATUS_DEACTIVATED
	case "":
	default:
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
			"Status can only be set to active or deactivated.")
		return
	}
	resp, err := g.staff.UpdateMember(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, memberJSON(resp.GetMember(), c.UserID))
}

func (g *gateway) reissueInvitation(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "staff:member:update") {
		return
	}
	resp, err := g.staff.ReissueInvitation(g.downstream(r, c),
		&staffpb.ReissueInvitationRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	if tok := resp.GetInviteToken(); tok != "" {
		logInviteToken(r, resp.GetMember().GetEmail(), tok)
	}
	httpx.JSON(w, r, http.StatusOK, memberJSON(resp.GetMember(), c.UserID))
}

func (g *gateway) removeStaff(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "staff:member:update") {
		return
	}
	if _, err := g.staff.RemoveMember(g.downstream(r, c),
		&staffpb.RemoveMemberRequest{Id: r.PathValue("id")}); err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.NoContent(w)
}

// --- stock ------------------------------------------------------------------

func levelJSON(l *inventorypb.Level) map[string]any {
	out := map[string]any{
		"itemId": l.GetItemId(), "itemName": l.GetItemName(),
		"onHand": l.GetOnHand(), "reserved": l.GetReserved(),
		// null, not zero. An item with no threshold never warns; one set to
		// zero warns when it runs out, and those are different intentions.
		"lowStockThreshold": nil,
	}
	if l.LowStockThreshold != nil {
		out["lowStockThreshold"] = l.GetLowStockThreshold()
	}
	return out
}

func (g *gateway) listLevels(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "inventory:stock:read") {
		return
	}
	resp, err := g.inventory.ListLevels(g.downstream(r, c), &inventorypb.ListLevelsRequest{
		LowOnly: r.URL.Query().Get("lowOnly") == "true",
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetLevels()))
	for _, l := range resp.GetLevels() {
		out = append(out, levelJSON(l))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) adjustStock(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "inventory:stock:adjust") {
		return
	}
	var in struct {
		ItemID         string `json:"itemId"`
		Delta          int32  `json:"delta"`
		Reason         string `json:"reason"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	resp, err := g.inventory.Adjust(g.downstream(r, c), &inventorypb.AdjustRequest{
		ItemId: in.ItemID, Delta: in.Delta, Reason: in.Reason,
		IdempotencyKey: in.IdempotencyKey,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, levelJSON(resp.GetLevel()))
}

func (g *gateway) setThreshold(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "inventory:stock:adjust") {
		return
	}
	var in struct {
		// Pointer so null clears the threshold and omitting it is refused,
		// rather than both quietly meaning zero.
		LowStockThreshold *int32 `json:"lowStockThreshold"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	resp, err := g.inventory.SetThreshold(g.downstream(r, c), &inventorypb.SetThresholdRequest{
		ItemId: r.PathValue("itemId"), LowStockThreshold: in.LowStockThreshold,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, levelJSON(resp.GetLevel()))
}
