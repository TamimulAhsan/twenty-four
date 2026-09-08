package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	provpb "github.com/twentyfour/platform/gen/go/twentyfour/provisioning/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// Signing up, and the checklist that follows.
func (g *gateway) registerSignup(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/signup", g.signup)
	// The password rule, so the form states the number the server enforces
	// rather than a copy of it that drifts. Unauthenticated: it is needed
	// before anyone has an account.
	mux.HandleFunc("GET /api/auth/policy", g.passwordPolicy)
	mux.HandleFunc("POST /api/auth/password-reset", g.requestPasswordReset)
	mux.HandleFunc("POST /api/auth/password-reset/confirm", g.confirmPasswordReset)

	mux.Handle("GET /api/onboarding", g.authenticated(g.getOnboarding))
	mux.Handle("POST /api/onboarding/steps/{id}/retry", g.authenticated(g.retryOnboardingStep))
	mux.Handle("POST /api/onboarding/steps/{id}/complete", g.authenticated(g.completeOnboardingStep))
}

func (g *gateway) passwordPolicy(w http.ResponseWriter, r *http.Request) {
	resp, err := g.auth.GetPasswordPolicy(r.Context(), &authpb.GetPasswordPolicyRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"minPasswordLength": resp.GetMinLength(),
	})
}

// signup creates the account, provisions the business, and signs them in.
//
// Three services in one request, in a fixed order. Auth first, because it mints
// the tenant ID and the merchant code and nothing else can proceed without
// them. Provisioning second, because it needs a tenant to provision. The
// session cookie last, because a merchant who is signed in to an account that
// has not been set up sees an empty dashboard and concludes it is broken.
//
// If provisioning fails the account still exists and they are still signed in.
// That is deliberate: the alternative is deleting a perfectly good account
// because a catalog template did not seed, and provisioning is resumable by
// design. They see a checklist with a failed step rather than a login that
// does not work.
func (g *gateway) signup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email        string `json:"email"`
		Password     string `json:"password"`
		DisplayName  string `json:"displayName"`
		BusinessName string `json:"businessName"`
		Industry     string `json:"industry"`
		Tier         string `json:"tier"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	// Checked here as well as in Auth, so the merchant gets one message naming
	// the field rather than a generic refusal from three layers down.
	var fields []httpx.FieldError
	if !strings.Contains(in.Email, "@") {
		fields = append(fields, httpx.FieldError{Field: "email", Message: "That does not look like an email address."})
	}
	if strings.TrimSpace(in.BusinessName) == "" {
		fields = append(fields, httpx.FieldError{Field: "businessName", Message: "Your business needs a name."})
	}
	if strings.TrimSpace(in.DisplayName) == "" {
		fields = append(fields, httpx.FieldError{Field: "displayName", Message: "We need your name for your sales and your team."})
	}
	if in.Industry == "" {
		fields = append(fields, httpx.FieldError{Field: "industry", Message: "Pick what kind of business this is."})
	}
	if len(fields) > 0 {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
			"Some of that needs another look.", fields...)
		return
	}
	if in.Tier == "" {
		// Arriving without a tier is normal: somebody who found the signup form
		// without going through the pricing page. Starter is the honest default
		// and they can change it in a click.
		in.Tier = "starter"
	}

	// Check the tier and the trade before creating anything.
	//
	// Provisioning failing later is survivable and the account stays; a tier or
	// a business type that does not exist is not a failure, it is a request
	// that was never going to work, and creating an account for it leaves an
	// orphan nobody provisions.
	if _, err := g.tenant.ResolveTier(r.Context(), &tenantpb.ResolveTierRequest{
		Tier: in.Tier, Industry: in.Industry,
	}); err != nil {
		if status.Code(err) == codes.InvalidArgument {
			httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
				status.Convert(err).Message(),
				httpx.FieldError{Field: "industry", Message: status.Convert(err).Message()})
			return
		}
		g.failGRPC(w, r, err)
		return
	}

	created, err := g.auth.Signup(r.Context(), &authpb.SignupRequest{
		Email: in.Email, Password: in.Password,
		DisplayName: in.DisplayName, BusinessName: in.BusinessName,
	})
	if err != nil {
		g.failSignup(w, r, err)
		return
	}
	tenantID := created.GetTenantId()
	slog.Info("signed up", "tenant", tenantID, "user", created.GetUser().GetId(),
		"industry", in.Industry, "tier", in.Tier, "merchant_code", created.GetMerchantCode())

	if _, err := g.provisioning.Start(r.Context(), &provpb.StartRequest{
		TenantId: tenantID, OwnerUserId: created.GetUser().GetId(),
		BusinessName: in.BusinessName, Industry: in.Industry, Tier: in.Tier,
	}); err != nil {
		// Not fatal, on purpose. See the note above the handler.
		slog.Error("provisioning did not complete at signup",
			"tenant", tenantID, "err", err,
			"action", "the merchant can retry the failed step from their checklist")
	}

	// Sign them in. A new merchant should land on their dashboard, not on a
	// login form asking for the password they typed forty seconds ago.
	resp, err := g.auth.Login(r.Context(), &authpb.LoginRequest{
		Email: in.Email, Password: in.Password,
		UserAgent: r.UserAgent(), Ip: clientIP(r),
	})
	if err != nil {
		slog.Error("could not sign in a newly created account", "tenant", tenantID, "err", err)
		httpx.Fail(w, r, http.StatusCreated, httpx.CodeUnauthenticated,
			"Your account is ready. Sign in to continue.")
		return
	}
	g.cookies.Set(w, resp.GetToken())
	httpx.JSON(w, r, http.StatusCreated, g.sessionOf(r, resp.GetUser()))
}

// failSignup turns a refusal into something a person can act on.
func (g *gateway) failSignup(w http.ResponseWriter, r *http.Request, err error) {
	code, kind, message := grpcStatus(err)
	switch code {
	case http.StatusConflict:
		httpx.Fail(w, r, http.StatusConflict, httpx.CodeConflict,
			"There is already an account with that email.",
			httpx.FieldError{Field: "email", Message: "Already registered. Sign in instead?"})
	case http.StatusBadRequest:
		// Auth owns the password rule, so its wording is the one that is right.
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, message,
			httpx.FieldError{Field: "password", Message: message})
	default:
		httpx.Fail(w, r, code, kind, message)
	}
}

// requestPasswordReset always reports success, whether or not the address
// exists. Reporting "no such account" would turn this into a way of finding out
// who banks here.
func (g *gateway) requestPasswordReset(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in)
	if _, err := g.auth.RequestPasswordReset(r.Context(), &authpb.RequestPasswordResetRequest{
		Email: in.Email,
	}); err != nil {
		slog.Error("password reset", "err", err, "request_id", httpx.RequestID(r))
	}
	httpx.NoContent(w)
}

func (g *gateway) confirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	if _, err := g.auth.ResetPassword(r.Context(), &authpb.ResetPasswordRequest{
		ResetToken: in.Token, NewPassword: in.Password,
	}); err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.NoContent(w)
}

// --- the checklist ----------------------------------------------------------

// timeOrNull renders a timestamp the way the dashboard parses it, and null
// rather than a zero date for one that has not happened. A step "completed" in
// year one is worse than a step with no completion time.
func timeOrNull(t *timestamppb.Timestamp) any {
	if t == nil || !t.IsValid() || t.AsTime().IsZero() {
		return nil
	}
	return t.AsTime().UTC().Format("2006-01-02T15:04:05Z")
}

func onboardingJSON(run *provpb.Run) any {
	// null rather than an empty object for a tenant that was never provisioned
	// through this service. The dashboard renders no checklist, which is right:
	// there isn't one.
	if run == nil {
		return nil
	}
	steps := make([]map[string]any, 0, len(run.GetSteps()))
	for _, s := range run.GetSteps() {
		steps = append(steps, map[string]any{
			"id": s.GetId(), "title": s.GetTitle(), "description": s.GetDescription(),
			"hour":   s.GetHour(),
			"status": strings.ToLower(strings.TrimPrefix(s.GetStatus().String(), "STEP_STATUS_")),
			// Who it is waiting on. The only question the merchant actually
			// has is which of these are theirs.
			"owner":       strings.ToLower(strings.TrimPrefix(s.GetOwner().String(), "STEP_OWNER_")),
			"completedAt": timeOrNull(s.GetCompletedAt()),
		})
	}
	out := map[string]any{
		"startedAt":   timeOrNull(run.GetStartedAt()),
		"dueAt":       timeOrNull(run.GetDueAt()),
		"completedAt": timeOrNull(run.GetCompletedAt()),
		"steps":       steps,
	}
	return out
}

func (g *gateway) getOnboarding(w http.ResponseWriter, r *http.Request, c caller) {
	resp, err := g.provisioning.Get(g.downstream(r, c), &provpb.GetRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, onboardingJSON(resp.GetRun()))
}

func (g *gateway) retryOnboardingStep(w http.ResponseWriter, r *http.Request, c caller) {
	resp, err := g.provisioning.RetryStep(g.downstream(r, c),
		&provpb.RetryStepRequest{StepId: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, onboardingJSON(resp.GetRun()))
}

func (g *gateway) completeOnboardingStep(w http.ResponseWriter, r *http.Request, c caller) {
	resp, err := g.provisioning.CompleteStep(g.downstream(r, c),
		&provpb.CompleteStepRequest{StepId: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, onboardingJSON(resp.GetRun()))
}
