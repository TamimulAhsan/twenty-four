// Package websession owns the browser-facing half of authentication: the
// cookie. Both gateways use it, and the difference between how they configure
// it is the entire browser-side separation of the two planes.
//
// The token itself never reaches JavaScript. It travels in an httpOnly cookie.
//
// On the merchant plane the cookie is scoped to the parent domain, which is
// what lets the dashboard, till, calendar and the Twenty CRM subdomain share
// one sign-in without a second login.
//
// On the admin plane it must be HOST-ONLY: no Domain attribute, so the browser
// never sends it to a sibling subdomain. The admin console is the surface that
// can see every merchant, and a parent-domain cookie there would put it inside
// the namespace every merchant application already reads. Leave Domain empty
// for the admin gateway, always. There is no configuration in which setting it
// is correct.
//
// The two also use different cookie names, so neither can be mistaken for the
// other in a log or a browser inspector.
package websession

import (
	"net/http"
	"time"
)

// The merchant plane's cookie, shared across the application subdomains.
const CookieName = "tf_session"

// The admin plane's cookie. A different name so the two are never confused,
// and always host-only.
const AdminCookieName = "tf_admin_session"

type Manager struct {
	// Name is the cookie this manager reads and writes.
	Name string
	// Domain is the parent the cookie is scoped to, so every subdomain sees it.
	// Empty means host-only: correct for localhost development, and the only
	// correct value on the admin plane anywhere.
	Domain string
	// Secure is off for plain-HTTP local development and must be on anywhere
	// else. A session cookie sent over HTTP is a session anyone on the path can
	// take.
	Secure bool
	TTL    time.Duration
}

func (m Manager) Set(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     m.name(),
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
		Name:     m.name(),
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

// name falls back to the merchant cookie so an unconfigured manager behaves as
// it did before this package served two planes.
func (m Manager) name() string {
	if m.Name == "" {
		return CookieName
	}
	return m.Name
}

// Token reads whichever cookie this manager owns.
func (m Manager) Token(r *http.Request) string {
	c, err := r.Cookie(m.name())
	if err != nil {
		return ""
	}
	return c.Value
}
