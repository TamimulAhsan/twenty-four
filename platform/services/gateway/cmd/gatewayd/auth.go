package main

import (
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	rbacpb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// sessionBody is what the frontend expects back from login and /auth/session.
type sessionBody struct {
	UserID   string `json:"userId"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	TenantID string `json:"tenantId"`
}

// loginBody is what one sign-in form gets back.
//
// Redirect is always set and the client always follows it, so the form does not
// have to know that two planes exist. Session is set only for a merchant: an
// admin has no session on this origin and never will, which is why the field is
// omitted rather than sent empty.
type loginBody struct {
	Session  *sessionBody `json:"session,omitempty"`
	Redirect string       `json:"redirect"`
}

func (g *gateway) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}

	resp, err := g.auth.Login(r.Context(), &authpb.LoginRequest{
		Email:    strings.TrimSpace(in.Email),
		Password: in.Password,
		// Which gateway is asking, not which account to look for. Auth resolves
		// the account from the address alone and answers with a token only if
		// it belongs to this plane.
		CallerPlane: authpb.Plane_PLANE_TENANT,
		UserAgent:   r.UserAgent(),
		Ip:          clientIP(r),
	})
	if err != nil {
		status, code, message := grpcStatus(err)
		httpx.Fail(w, r, status, code, message)
		return
	}
	if resp.GetTotpRequired() {
		httpx.Fail(w, r, http.StatusUnauthorized, "totp_required",
			"Enter the code from your authenticator app.")
		return
	}

	// A specialist signing in on the merchant origin. Auth gave us a one-time
	// code instead of a token, so there is nothing here that could be set as a
	// cookie even by mistake, and the browser is sent to the admin gateway to
	// exchange it for a session on its own host.
	if code := resp.GetHandoffCode(); code != "" {
		httpx.JSON(w, r, http.StatusOK, loginBody{
			Redirect: g.adminURL + "/session?code=" + url.QueryEscape(code),
		})
		return
	}

	g.cookies.Set(w, resp.GetToken())
	body := g.sessionOf(r, resp.GetUser())
	httpx.JSON(w, r, http.StatusOK, loginBody{Session: &body, Redirect: "/"})
}

func (g *gateway) logout(w http.ResponseWriter, r *http.Request) {
	if token := g.cookies.Token(r); token != "" {
		// Revoke server-side as well as clearing the cookie. Clearing alone
		// leaves a valid token that anything holding a copy could still use.
		if _, err := g.auth.Logout(r.Context(), &authpb.LogoutRequest{Token: token}); err != nil {
			slog.Warn("logout", "err", err, "request_id", httpx.RequestID(r))
		}
	}
	g.cookies.Clear(w)
	httpx.NoContent(w)
}

// currentSession answers "who am I". It returns null rather than 401 when there
// is no session: SessionGate calls it to decide whether to redirect, and an
// error would make a normal signed-out visit look like a fault.
func (g *gateway) currentSession(w http.ResponseWriter, r *http.Request) {
	token := g.cookies.Token(r)
	if token == "" {
		httpx.JSON(w, r, http.StatusOK, nil)
		return
	}
	verified, err := g.auth.VerifyToken(r.Context(), &authpb.VerifyTokenRequest{Token: token})
	if err != nil {
		httpx.Fail(w, r, http.StatusServiceUnavailable, httpx.CodeUnavailable,
			"We could not check your session. Try again in a moment.")
		return
	}
	if !verified.GetValid() {
		g.cookies.Clear(w)
		httpx.JSON(w, r, http.StatusOK, nil)
		return
	}

	user, err := g.auth.GetUser(r.Context(), &authpb.GetUserRequest{
		TenantId: verified.GetTenantId(), UserId: verified.GetUserId(),
	})
	if err != nil {
		httpx.Fail(w, r, http.StatusServiceUnavailable, httpx.CodeUnavailable,
			"We could not load your account. Try again in a moment.")
		return
	}
	httpx.JSON(w, r, http.StatusOK, g.sessionOf(r, user.GetUser()))
}

// sessionOf builds the session body, asking RBAC for the role rather than
// storing one on the user: roles live in exactly one service.
func (g *gateway) sessionOf(r *http.Request, u *authpb.User) sessionBody {
	role := "staff"
	roles, err := g.rbac.GetSubjectRoles(r.Context(), &rbacpb.GetSubjectRolesRequest{
		TenantId: u.GetTenantId(), SubjectId: u.GetId(),
	})
	if err != nil {
		slog.Warn("load roles", "err", err, "user", u.GetId(), "request_id", httpx.RequestID(r))
	} else if rs := roles.GetRoles(); len(rs) > 0 {
		// The frontend shows one role. Where someone holds several, the most
		// capable is the honest label.
		role = mostCapable(rs)
	}
	return sessionBody{
		UserID:   u.GetId(),
		Email:    u.GetEmail(),
		Name:     u.GetDisplayName(),
		Role:     role,
		TenantID: u.GetTenantId(),
	}
}

// rank orders the roles the frontend knows about. Anything unrecognised sorts
// lowest, so an unknown custom role never masquerades as an owner.
var rank = map[string]int{"owner": 4, "manager": 3, "accountant": 2, "staff": 1}

func mostCapable(roles []*rbacpb.Role) string {
	best, bestRank := "staff", 0
	for _, r := range roles {
		if n := rank[r.GetKey()]; n > bestRank {
			best, bestRank = r.GetKey(), n
		}
	}
	return best
}

func clientIP(r *http.Request) string {
	// Traefik sets this. Taking the first entry is correct because only the
	// proxy in front of us can append to it.
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := strings.IndexByte(fwd, ','); i > 0 {
			return strings.TrimSpace(fwd[:i])
		}
		return strings.TrimSpace(fwd)
	}
	return r.RemoteAddr
}
