// Package session owns the browser-facing half of authentication: the cookie.
//
// The token itself never reaches JavaScript. It travels in an httpOnly cookie
// scoped to the parent domain, which is what lets the dashboard, till, calendar
// and the Twenty CRM subdomain share one sign-in without a second login.
package session

import (
	"net/http"
	"time"
)

const CookieName = "tf_session"

type Manager struct {
	// Domain is the parent the cookie is scoped to, so every subdomain sees it.
	// Empty means host-only, which is correct for localhost development.
	Domain string
	// Secure is off for plain-HTTP local development and must be on anywhere
	// else. A session cookie sent over HTTP is a session anyone on the path can
	// take.
	Secure bool
	TTL    time.Duration
}

func (m Manager) Set(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		Domain:   m.Domain,
		HttpOnly: true,
		Secure:   m.Secure,
		// Lax rather than Strict: the merchant follows links between the
		// applications, and Strict would drop the cookie on those navigations
		// and appear as a random sign-out.
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(m.TTL),
		MaxAge:   int(m.TTL.Seconds()),
	})
}

func (m Manager) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		Domain:   m.Domain,
		HttpOnly: true,
		Secure:   m.Secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

func Token(r *http.Request) string {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return ""
	}
	return c.Value
}
