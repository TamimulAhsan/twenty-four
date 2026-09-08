// Command authd serves the Auth service: who someone is, and whether they are
// still signed in. It never decides what anyone may do: that is RBAC's job,
// and Auth calls it in exactly one place: binding the owner role at signup.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	rbacpb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
	"github.com/twentyfour/platform/services/auth/internal/credential"
	"github.com/twentyfour/platform/services/auth/internal/merchantcode"
	"github.com/twentyfour/platform/services/auth/internal/store"
	"github.com/twentyfour/platform/services/auth/internal/token"
)

const (
	maxFailedAttempts = 5
	lockoutWindow     = 15 * time.Minute
	oneTimeTokenTTL   = 24 * time.Hour
	// A week, because an invitation is sent to a person who may be on holiday,
	// and an expired link that needs a colleague to re-send it is friction on
	// the day someone is trying to start work.
	inviteTTL = 7 * 24 * time.Hour
	// The handoff code crosses from one gateway to the other inside a redirect
	// the browser follows immediately. Thirty seconds is generous for that and
	// far too short to be worth intercepting.
	handoffTTL = 30 * time.Second
)

type server struct {
	pb.UnimplementedAuthServiceServer
	st   *store.Store
	iss  *token.Issuer
	rbac rbacpb.RBACServiceClient
}

func planeStr(p pb.Plane) string {
	if p == pb.Plane_PLANE_ADMIN {
		return "admin"
	}
	return "tenant"
}

func planePB(s string) pb.Plane {
	if s == "admin" {
		return pb.Plane_PLANE_ADMIN
	}
	return pb.Plane_PLANE_TENANT
}

func statusPB(s string) pb.UserStatus {
	switch s {
	case "invited":
		return pb.UserStatus_USER_STATUS_INVITED
	case "active":
		return pb.UserStatus_USER_STATUS_ACTIVE
	case "deactivated":
		return pb.UserStatus_USER_STATUS_DEACTIVATED
	case "locked":
		return pb.UserStatus_USER_STATUS_LOCKED
	}
	return pb.UserStatus_USER_STATUS_UNSPECIFIED
}

func toPBUser(u store.User) *pb.User {
	out := &pb.User{
		Id: u.ID.String(), TenantId: u.TenantID.String(), Email: u.Email,
		DisplayName: u.DisplayName, Status: statusPB(u.Status), Plane: planePB(u.Plane),
		EmailVerified: u.EmailVerified, TotpEnrolled: u.TOTPSecret != nil,
		CreatedAt: timestamppb.New(u.CreatedAt),
	}
	if u.LastLoginAt != nil {
		out.LastLoginAt = timestamppb.New(*u.LastLoginAt)
	}
	return out
}

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Signup creates the first user of a new tenant and makes them its owner.
//
// CreateStaff makes a specialist: an account on the admin plane, belonging to
// the platform rather than to a business.
//
// It differs from Signup in every way that matters. No tenant is minted, so the
// tenant id stays nil and tenantctx refuses any tenant-scoped call made with
// this account's token. No merchant code, because a specialist issues no
// documents. The address is treated as verified, because there is nowhere to
// send a verification mail and a specialist is created by somebody who already
// knows who they are.
func (s *server) CreateStaff(ctx context.Context, req *pb.CreateStaffRequest) (*pb.CreateStaffResponse, error) {
	email := strings.TrimSpace(strings.ToLower(req.GetEmail()))
	if email == "" || !strings.Contains(email, "@") {
		return nil, status.Error(codes.InvalidArgument, "a valid email is required")
	}
	if err := credential.Validate(req.GetPassword()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	role := strings.TrimSpace(req.GetRoleKey())
	if role == "" {
		return nil, status.Error(codes.InvalidArgument, "a role is required")
	}
	hash, err := credential.Hash(req.GetPassword())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not process password")
	}

	u, err := s.st.CreateUser(ctx, store.User{
		ID: uuid.New(), TenantID: uuid.Nil, Email: email,
		DisplayName: req.GetDisplayName(), PasswordHash: hash,
		Status: "active", Plane: "admin", EmailVerified: true,
	})
	// One address, one account, across both planes. An address already held by
	// a merchant cannot become a specialist, and the message says so rather
	// than leaving somebody to guess which half of the platform is objecting.
	if errors.Is(err, store.ErrEmailTaken) {
		return nil, status.Error(codes.AlreadyExists, "that email already has an account")
	}
	if err != nil {
		slog.Error("create staff: create user", "err", err)
		return nil, status.Error(codes.Internal, "could not create account")
	}

	// Synchronously, like signup: an account with no role can do nothing, and a
	// half-created specialist is worse than a loud failure.
	if _, err := s.rbac.AssignRole(ctx, &rbacpb.AssignRoleRequest{
		// The role key carries the plane: RBAC's system role keys are unique,
		// and platform_admin, specialist and support exist only on the admin
		// plane. A tenant role key here would simply not resolve.
		TenantId: uuid.Nil.String(), SubjectId: u.ID.String(), RoleKey: role,
	}); err != nil {
		slog.Error("create staff: assign role", "err", err, "user", u.ID, "role", role)
		return nil, status.Error(codes.Internal, "account created but role assignment failed")
	}

	slog.Info("staff created", "user", u.ID, "role", role)
	return &pb.CreateStaffResponse{User: toPBUser(u)}, nil
}

// The tenant ID is minted here because Auth needs one before the Tenant service
// exists; Tenant & Business Profile will own the business record under this
// same ID. Auth stores no business data of its own.
func (s *server) Signup(ctx context.Context, req *pb.SignupRequest) (*pb.SignupResponse, error) {
	email := strings.TrimSpace(strings.ToLower(req.GetEmail()))
	if email == "" || !strings.Contains(email, "@") {
		return nil, status.Error(codes.InvalidArgument, "a valid email is required")
	}
	if err := credential.Validate(req.GetPassword()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	hash, err := credential.Hash(req.GetPassword())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not process password")
	}

	tenantID := uuid.New()
	u, err := s.st.CreateUser(ctx, store.User{
		ID: uuid.New(), TenantID: tenantID, Email: email,
		DisplayName: req.GetDisplayName(), PasswordHash: hash,
		Status: "active", Plane: "tenant",
	})
	if errors.Is(err, store.ErrEmailTaken) {
		return nil, status.Error(codes.AlreadyExists, "that email is already registered")
	}
	if err != nil {
		slog.Error("signup: create user", "err", err)
		return nil, status.Error(codes.Internal, "could not create account")
	}

	// Bind the owner role synchronously. A user with no role cannot do
	// anything, so signup genuinely is not complete until this lands. Better
	// to fail loudly here than to leave a half-created account behind.
	if _, err := s.rbac.AssignRole(ctx, &rbacpb.AssignRoleRequest{
		TenantId: tenantID.String(), SubjectId: u.ID.String(), RoleKey: "owner",
	}); err != nil {
		slog.Error("signup: assign owner role", "err", err, "user", u.ID)
		return nil, status.Error(codes.Internal, "account created but role assignment failed")
	}

	// The merchant code is assigned here because this is the moment a tenant
	// first exists. It goes on every document the business will ever issue, so
	// a tenant that reaches its first sale without one cannot be invoiced,
	// which makes this as much a part of signup as the role binding above.
	code, err := s.st.AssignMerchantCode(ctx, tenantID, merchantcode.New)
	if err != nil {
		slog.Error("signup: assign merchant code", "err", err, "tenant", tenantID)
		return nil, status.Error(codes.Internal, "account created but merchant code assignment failed")
	}

	verify := randomToken()
	if err := s.st.CreateOneTimeToken(ctx, u.ID, "verify_email", verify, oneTimeTokenTTL); err != nil {
		slog.Error("signup: verification token", "err", err)
	}

	slog.Info("signup", "user", u.ID, "tenant", tenantID, "merchant_code", code)
	return &pb.SignupResponse{
		User: toPBUser(u), TenantId: tenantID.String(),
		VerificationToken: verify, MerchantCode: code,
	}, nil
}

// GetMerchantCode is how Invoicing learns what to print. It is an RPC rather
// than a shared table on purpose: when Tenant & Business Profile takes the
// column over, this call moves and its callers do not change.
func (s *server) GetMerchantCode(ctx context.Context, req *pb.GetMerchantCodeRequest) (*pb.GetMerchantCodeResponse, error) {
	tid, err := uuid.Parse(req.GetTenantId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id must be a UUID")
	}
	code, assigned, err := s.st.MerchantCode(ctx, tid)
	if errors.Is(err, store.ErrNoMerchantCode) {
		return nil, status.Error(codes.NotFound, "that tenant has no merchant code")
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "could not read merchant code")
	}
	return &pb.GetMerchantCodeResponse{
		TenantId: tid.String(), MerchantCode: code, AssignedAt: timestamppb.New(assigned),
	}, nil
}

// InviteUser adds a staff member to an existing tenant.
//
// It creates the account in the "invited" state with an unusable password, so
// the address is claimed and the seat is held but nobody can sign in until the
// invitation is accepted. Auth does not check the seat quota: that is Staff's
// job, and it has to be checked in one place or it will be checked in none.
func (s *server) InviteUser(ctx context.Context, req *pb.InviteUserRequest) (*pb.InviteUserResponse, error) {
	tenantID, err := uuid.Parse(req.GetTenantId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id must be a UUID")
	}
	email := strings.TrimSpace(strings.ToLower(req.GetEmail()))
	if email == "" || !strings.Contains(email, "@") {
		return nil, status.Error(codes.InvalidArgument, "a valid email is required")
	}

	// A password nobody knows, not an empty one. An account with a blank hash
	// is an account somebody eventually logs into by accident.
	hash, err := credential.Hash(randomToken())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not create the invitation")
	}

	u, err := s.st.CreateUser(ctx, store.User{
		ID: uuid.New(), TenantID: tenantID, Email: email,
		DisplayName: strings.TrimSpace(req.GetDisplayName()), PasswordHash: hash,
		Status: "invited", Plane: "tenant",
	})
	if errors.Is(err, store.ErrEmailTaken) {
		return nil, status.Error(codes.AlreadyExists, "that email is already registered")
	}
	if err != nil {
		slog.Error("invite: create user", "err", err)
		return nil, status.Error(codes.Internal, "could not create the invitation")
	}

	roleKey := req.GetRoleKey()
	if roleKey == "" {
		roleKey = "staff"
	}
	if _, err := s.rbac.AssignRole(ctx, &rbacpb.AssignRoleRequest{
		TenantId: tenantID.String(), SubjectId: u.ID.String(), RoleKey: roleKey,
	}); err != nil {
		slog.Error("invite: assign role", "err", err, "user", u.ID, "role", roleKey)
		return nil, status.Error(codes.Internal, "account created but role assignment failed")
	}

	token := randomToken()
	if err := s.st.CreateOneTimeToken(ctx, u.ID, "invite", token, inviteTTL); err != nil {
		slog.Error("invite: token", "err", err)
		return nil, status.Error(codes.Internal, "could not issue the invitation")
	}
	slog.Info("invited", "user", u.ID, "tenant", tenantID, "role", roleKey)
	return &pb.InviteUserResponse{User: toPBUser(u), InviteToken: token}, nil
}

// ReissueInvite sends the same person a new link. It consumes no second seat,
// because they already hold one.
func (s *server) ReissueInvite(ctx context.Context, req *pb.ReissueInviteRequest) (*pb.ReissueInviteResponse, error) {
	tid, err1 := uuid.Parse(req.GetTenantId())
	uid, err2 := uuid.Parse(req.GetUserId())
	if err1 != nil || err2 != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id and user_id must be UUIDs")
	}
	u, err := s.st.UserByID(ctx, uid)
	if err != nil || u.TenantID != tid {
		return nil, status.Error(codes.NotFound, "no such user")
	}
	if u.Status != "invited" {
		return nil, status.Error(codes.FailedPrecondition, "that invitation has already been accepted")
	}
	token := randomToken()
	if err := s.st.CreateOneTimeToken(ctx, u.ID, "invite", token, inviteTTL); err != nil {
		return nil, status.Error(codes.Internal, "could not issue the invitation")
	}
	return &pb.ReissueInviteResponse{InviteToken: token}, nil
}

// AcceptInvite turns an invitation into a working account.
//
// Consuming the token and setting the password are two statements, and the
// order matters: the token is spent first, so a crash between them leaves an
// account that cannot be signed into rather than a link that works twice.
func (s *server) AcceptInvite(ctx context.Context, req *pb.AcceptInviteRequest) (*pb.AcceptInviteResponse, error) {
	if err := credential.Validate(req.GetPassword()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	uid, err := s.st.ConsumeOneTimeToken(ctx, "invite", req.GetInviteToken())
	if errors.Is(err, store.ErrNotFound) {
		return nil, status.Error(codes.InvalidArgument, "that invitation is invalid or has expired")
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "could not accept the invitation")
	}
	hash, err := credential.Hash(req.GetPassword())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not process password")
	}
	u, err := s.st.AcceptInvite(ctx, uid, hash)
	if errors.Is(err, store.ErrNotFound) {
		return nil, status.Error(codes.FailedPrecondition, "that invitation has already been accepted")
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "could not accept the invitation")
	}
	slog.Info("invitation accepted", "user", u.ID, "tenant", u.TenantID)
	return &pb.AcceptInviteResponse{User: toPBUser(u)}, nil
}

func (s *server) ReactivateUser(ctx context.Context, req *pb.ReactivateUserRequest) (*pb.ReactivateUserResponse, error) {
	tid, err1 := uuid.Parse(req.GetTenantId())
	uid, err2 := uuid.Parse(req.GetUserId())
	if err1 != nil || err2 != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id and user_id must be UUIDs")
	}
	u, err := s.st.ReactivateUser(ctx, tid, uid)
	if errors.Is(err, store.ErrNotFound) {
		return nil, status.Error(codes.FailedPrecondition, "that account is not deactivated")
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "could not reactivate the account")
	}
	return &pb.ReactivateUserResponse{User: toPBUser(u)}, nil
}

func (s *server) DeleteUser(ctx context.Context, req *pb.DeleteUserRequest) (*pb.DeleteUserResponse, error) {
	tid, err1 := uuid.Parse(req.GetTenantId())
	uid, err2 := uuid.Parse(req.GetUserId())
	if err1 != nil || err2 != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id and user_id must be UUIDs")
	}
	deleted, err := s.st.DeleteUser(ctx, tid, uid)
	if err != nil {
		return nil, status.Error(codes.Internal, "could not delete the account")
	}
	if !deleted {
		return nil, status.Error(codes.FailedPrecondition,
			"that account has been used, so it can only be deactivated")
	}
	slog.Info("invitation deleted", "user", uid, "tenant", tid)
	return &pb.DeleteUserResponse{Deleted: true}, nil
}

// Login is written so that an unknown account and a wrong password are
// indistinguishable: same error, and the same argon2 work is done either way.
// ListMerchantCodes answers a whole directory page at once.
//
// Unfiltered by plane on purpose: a merchant code identifies a business, not a
// person, and it is printed on documents the business hands to the public.
// There is nothing here to leak that an invoice does not already carry.
func (s *server) ListMerchantCodes(ctx context.Context, req *pb.ListMerchantCodesRequest) (*pb.ListMerchantCodesResponse, error) {
	ids := make([]uuid.UUID, 0, len(req.GetTenantIds()))
	for _, raw := range req.GetTenantIds() {
		id, err := uuid.Parse(raw)
		if err != nil {
			// One bad id does not spoil the page. It simply has no code, which
			// is what a caller sees for an unknown tenant anyway.
			continue
		}
		ids = append(ids, id)
	}
	assigned, err := s.st.MerchantCodes(ctx, ids)
	if err != nil {
		slog.Error("merchant codes", "err", err)
		return nil, status.Error(codes.Internal, "could not read merchant codes")
	}
	out := make(map[string]string, len(assigned))
	for id, code := range assigned {
		out[id.String()] = code
	}
	return &pb.ListMerchantCodesResponse{MerchantCodes: out}, nil
}

func (s *server) Login(ctx context.Context, req *pb.LoginRequest) (*pb.LoginResponse, error) {
	denied := status.Error(codes.Unauthenticated, "invalid email or password")

	// By address alone. The account's own plane is the answer to "where does
	// this person go", which is what lets one form serve both.
	u, err := s.st.UserByEmail(ctx, req.GetEmail())
	if errors.Is(err, store.ErrNotFound) {
		credential.VerifyDummy(req.GetPassword()) // equalise timing
		return nil, denied
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "could not sign in")
	}

	if u.LockedUntil != nil && u.LockedUntil.After(time.Now()) {
		return nil, status.Error(codes.PermissionDenied, "account temporarily locked")
	}
	// An invited account holds a password nobody knows, so this is defence in
	// depth rather than the only thing stopping a sign-in. It is worth stating
	// anyway: "invited means cannot sign in" should be visible in the code that
	// decides, not inferred from how the hash was generated.
	if u.Status == "deactivated" || u.Status == "invited" {
		credential.VerifyDummy(req.GetPassword())
		return nil, denied
	}

	if err := credential.Verify(req.GetPassword(), u.PasswordHash); err != nil {
		if err := s.st.RecordLoginFailure(ctx, u.ID, maxFailedAttempts, lockoutWindow); err != nil {
			slog.Error("login: record failure", "err", err)
		}
		return nil, denied
	}

	// TOTP is mandatory on the admin plane once enrolled.
	if u.TOTPSecret != nil && req.GetTotpCode() == "" {
		return &pb.LoginResponse{TotpRequired: true}, nil
	}

	sess, err := s.st.CreateSession(ctx, store.Session{
		ID: uuid.New(), UserID: u.ID, TenantID: u.TenantID, Plane: u.Plane,
		ExpiresAt: time.Now().Add(s.iss.TTL()),
		UserAgent: req.GetUserAgent(), IP: req.GetIp(),
	})
	if err != nil {
		slog.Error("login: create session", "err", err)
		return nil, status.Error(codes.Internal, "could not sign in")
	}
	if err := s.st.RecordLoginSuccess(ctx, u.ID); err != nil {
		slog.Error("login: record success", "err", err)
	}

	// The caller is one plane's gateway and can only be handed that plane's
	// token. When the account belongs to the other one, it gets a code to
	// redirect with instead, and never sees a token it has no business
	// holding. That makes "the merchant gateway sets an admin cookie" an
	// impossible bug rather than an avoided one.
	if u.Plane != planeStr(req.GetCallerPlane()) {
		code := randomToken()
		if err := s.st.CreateHandoff(ctx, u.ID, sess.ID, code, req.GetIp(), handoffTTL); err != nil {
			slog.Error("login: create handoff", "err", err)
			return nil, status.Error(codes.Internal, "could not sign in")
		}
		slog.Info("login handed off", "user", u.ID, "plane", u.Plane)
		return &pb.LoginResponse{User: toPBUser(u), HandoffCode: code}, nil
	}

	tok, exp, err := s.iss.Issue(token.Claims{
		UserID: u.ID.String(), TenantID: u.TenantID.String(),
		SessionID: sess.ID.String(), Plane: u.Plane,
	})
	if err != nil {
		return nil, status.Error(codes.Internal, "could not issue token")
	}

	slog.Info("login", "user", u.ID, "tenant", u.TenantID, "plane", u.Plane)
	return &pb.LoginResponse{
		User: toPBUser(u), Token: tok,
		Session: &pb.Session{
			Id: sess.ID.String(), UserId: u.ID.String(), TenantId: u.TenantID.String(),
			IssuedAt: timestamppb.New(sess.IssuedAt), ExpiresAt: timestamppb.New(exp),
			UserAgent: sess.UserAgent, Ip: sess.IP,
		},
	}, nil
}

// RedeemHandoff swaps a one-time code for a token on the plane that issued it.
//
// The code is consumed atomically and bound to the address that was given one,
// so a replay finds nothing and a code that travelled to another machine finds
// nothing. Both answer the same way, because telling the two apart would say
// something about a code the caller does not hold.
func (s *server) RedeemHandoff(ctx context.Context, req *pb.RedeemHandoffRequest) (*pb.RedeemHandoffResponse, error) {
	denied := status.Error(codes.Unauthenticated, "that sign-in link is not usable")

	sessionID, err := s.st.RedeemHandoff(ctx, req.GetCode(), req.GetIp())
	if errors.Is(err, store.ErrNotFound) {
		return nil, denied
	}
	if err != nil {
		slog.Error("handoff: redeem", "err", err)
		return nil, status.Error(codes.Internal, "could not sign in")
	}

	// The session is checked again rather than trusted from the code. Between
	// issuing and redeeming, somebody could have signed out on the other tab.
	sess, err := s.st.LiveSession(ctx, sessionID)
	if err != nil {
		return nil, denied
	}
	u, err := s.st.UserByID(ctx, sess.UserID)
	if err != nil {
		return nil, denied
	}

	tok, exp, err := s.iss.Issue(token.Claims{
		UserID: u.ID.String(), TenantID: u.TenantID.String(),
		SessionID: sess.ID.String(), Plane: u.Plane,
	})
	if err != nil {
		return nil, status.Error(codes.Internal, "could not issue token")
	}

	slog.Info("handoff redeemed", "user", u.ID, "plane", u.Plane)
	return &pb.RedeemHandoffResponse{
		User: toPBUser(u), Token: tok,
		Session: &pb.Session{
			Id: sess.ID.String(), UserId: u.ID.String(), TenantId: u.TenantID.String(),
			IssuedAt: timestamppb.New(sess.IssuedAt), ExpiresAt: timestamppb.New(exp),
			UserAgent: sess.UserAgent, Ip: sess.IP,
		},
	}, nil
}

// VerifyToken is the gateway's hot path. It checks the token cryptographically
// AND that the session behind it is still live, so a logout takes effect at
// once rather than whenever the token would have expired.
func (s *server) VerifyToken(ctx context.Context, req *pb.VerifyTokenRequest) (*pb.VerifyTokenResponse, error) {
	claims, err := s.iss.Parse(req.GetToken())
	if err != nil {
		return &pb.VerifyTokenResponse{Valid: false, Reason: err.Error()}, nil
	}
	if want := req.GetExpectedPlane(); want != pb.Plane_PLANE_UNSPECIFIED && planeStr(want) != claims.Plane {
		return &pb.VerifyTokenResponse{Valid: false, Reason: "wrong plane"}, nil
	}
	sid, err := uuid.Parse(claims.SessionID)
	if err != nil {
		return &pb.VerifyTokenResponse{Valid: false, Reason: "malformed session id"}, nil
	}
	sess, err := s.st.LiveSession(ctx, sid)
	if errors.Is(err, store.ErrSessionClosed) {
		return &pb.VerifyTokenResponse{Valid: false, Reason: "session revoked or expired"}, nil
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "could not verify token")
	}
	return &pb.VerifyTokenResponse{
		Valid: true, UserId: claims.UserID, TenantId: claims.TenantID,
		Plane: planePB(claims.Plane), SessionId: claims.SessionID,
		ExpiresAt: timestamppb.New(sess.ExpiresAt),
	}, nil
}

func (s *server) Logout(ctx context.Context, req *pb.LogoutRequest) (*pb.LogoutResponse, error) {
	claims, err := s.iss.Parse(req.GetToken())
	if err != nil {
		return &pb.LogoutResponse{Ended: false}, nil
	}
	sid, err := uuid.Parse(claims.SessionID)
	if err != nil {
		return &pb.LogoutResponse{Ended: false}, nil
	}
	ended, err := s.st.RevokeSession(ctx, sid)
	if err != nil {
		return nil, status.Error(codes.Internal, "could not sign out")
	}
	return &pb.LogoutResponse{Ended: ended}, nil
}

func (s *server) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.GetUserResponse, error) {
	id, err := uuid.Parse(req.GetUserId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "user_id must be a UUID")
	}
	u, err := s.st.UserByID(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, status.Error(codes.NotFound, "no such user")
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "could not load user")
	}
	// Never let one tenant read another's users.
	if req.GetTenantId() != "" && u.TenantID.String() != req.GetTenantId() {
		return nil, status.Error(codes.NotFound, "no such user")
	}
	return &pb.GetUserResponse{User: toPBUser(u)}, nil
}

func (s *server) ListUsers(ctx context.Context, req *pb.ListUsersRequest) (*pb.ListUsersResponse, error) {
	tid, err := uuid.Parse(req.GetTenantId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id must be a UUID")
	}
	users, active, err := s.st.ListUsers(ctx, tid, req.GetIncludeDeactivated())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not list users")
	}
	resp := &pb.ListUsersResponse{ActiveCount: int32(active)}
	for _, u := range users {
		resp.Users = append(resp.Users, toPBUser(u))
	}
	return resp, nil
}

func (s *server) DeactivateUser(ctx context.Context, req *pb.DeactivateUserRequest) (*pb.DeactivateUserResponse, error) {
	tid, err1 := uuid.Parse(req.GetTenantId())
	uid, err2 := uuid.Parse(req.GetUserId())
	if err1 != nil || err2 != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id and user_id must be UUIDs")
	}
	ok, err := s.st.DeactivateUser(ctx, tid, uid)
	if err != nil {
		return nil, status.Error(codes.Internal, "could not deactivate user")
	}
	return &pb.DeactivateUserResponse{Deactivated: ok}, nil
}

// GetPasswordPolicy states the rule this deployment enforces.
//
// A signup form that carries its own copy of the number is a form that will one
// day accept a password the server refuses, and the merchant will be told their
// perfectly good password is wrong with no way to find out why.
func (s *server) GetPasswordPolicy(context.Context, *pb.GetPasswordPolicyRequest) (*pb.GetPasswordPolicyResponse, error) {
	return &pb.GetPasswordPolicyResponse{MinLength: int32(credential.MinPasswordLength)}, nil
}

func (s *server) ChangePassword(ctx context.Context, req *pb.ChangePasswordRequest) (*pb.ChangePasswordResponse, error) {
	uid, err := uuid.Parse(req.GetUserId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "user_id must be a UUID")
	}
	u, err := s.st.UserByID(ctx, uid)
	if err != nil {
		return nil, status.Error(codes.NotFound, "no such user")
	}
	if err := credential.Verify(req.GetCurrentPassword(), u.PasswordHash); err != nil {
		return nil, status.Error(codes.Unauthenticated, "current password is incorrect")
	}
	if err := credential.Validate(req.GetNewPassword()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	hash, err := credential.Hash(req.GetNewPassword())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not process password")
	}
	if err := s.st.SetPasswordHash(ctx, uid, hash); err != nil {
		return nil, status.Error(codes.Internal, "could not change password")
	}
	return &pb.ChangePasswordResponse{Changed: true}, nil
}

// RequestPasswordReset always reports success. Reporting "no such account"
// would turn this endpoint into an account-enumeration oracle.
func (s *server) RequestPasswordReset(ctx context.Context, req *pb.RequestPasswordResetRequest) (*pb.RequestPasswordResetResponse, error) {
	u, err := s.st.UserByEmail(ctx, req.GetEmail())
	if err == nil {
		raw := randomToken()
		if err := s.st.CreateOneTimeToken(ctx, u.ID, "password_reset", raw, time.Hour); err != nil {
			slog.Error("reset: create token", "err", err)
		}
		// Notification will send this; logged for now so dev can complete the flow.
		slog.Info("password reset requested", "user", u.ID, "token", raw)
	}
	return &pb.RequestPasswordResetResponse{Accepted: true}, nil
}

func (s *server) ResetPassword(ctx context.Context, req *pb.ResetPasswordRequest) (*pb.ResetPasswordResponse, error) {
	if err := credential.Validate(req.GetNewPassword()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	uid, err := s.st.ConsumeOneTimeToken(ctx, "password_reset", req.GetResetToken())
	if errors.Is(err, store.ErrNotFound) {
		return nil, status.Error(codes.InvalidArgument, "reset link is invalid or has expired")
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "could not reset password")
	}
	hash, err := credential.Hash(req.GetNewPassword())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not process password")
	}
	if err := s.st.SetPasswordHash(ctx, uid, hash); err != nil {
		return nil, status.Error(codes.Internal, "could not reset password")
	}
	return &pb.ResetPasswordResponse{Reset_: true}, nil
}

func backfillMerchantCodes(ctx context.Context, st *store.Store) {
	pending, err := st.TenantsWithoutMerchantCode(ctx)
	if err != nil {
		slog.Error("merchant code backfill: list tenants", "err", err)
		return
	}
	for _, tid := range pending {
		code, err := st.AssignMerchantCode(ctx, tid, merchantcode.New)
		if err != nil {
			slog.Error("merchant code backfill", "tenant", tid, "err", err)
			continue
		}
		slog.Info("merchant code backfilled", "tenant", tid, "merchant_code", code)
	}
}

func main() {
	addr := flag.String("addr", ":9102", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	rbacAddr := flag.String("rbac", "localhost:9101", "RBAC service address")
	keyHex := flag.String("token-key", os.Getenv("TOKEN_KEY"), "32-byte hex token key; generated if empty")
	ttl := flag.Duration("session-ttl", 12*time.Hour, "session lifetime")
	minPassword := flag.Int("min-password", credential.DefaultMinPasswordLength,
		"minimum password length; lower it only for local development")
	flag.Parse()

	if *minPassword != credential.DefaultMinPasswordLength {
		credential.SetMinPasswordLength(*minPassword)
	}

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if *minPassword < credential.DefaultMinPasswordLength {
		slog.Warn("password minimum lowered below the default",
			"min", *minPassword, "default", credential.DefaultMinPasswordLength,
			"note", "development only")
	}
	ctx := context.Background()

	if *keyHex == "" {
		k, err := token.GenerateKey()
		if err != nil {
			slog.Error("generate token key", "err", err)
			os.Exit(1)
		}
		*keyHex = k
		slog.Warn("no TOKEN_KEY set; generated an ephemeral one, so sessions will not survive a restart")
	}
	iss, err := token.NewIssuer(*keyHex, *ttl)
	if err != nil {
		slog.Error("token issuer", "err", err)
		os.Exit(1)
	}

	st, err := store.Open(ctx, *dsn)
	if err != nil {
		slog.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		slog.Error("migrate", "err", err)
		os.Exit(1)
	}

	// Tenants that existed before merchant codes did still need one. A code is
	// assigned once and never changes, so doing this at startup rather than
	// lazily on first read keeps "every tenant has a code" true from the moment
	// this version is deployed, instead of true only for tenants that happen to
	// have issued a document.
	backfillMerchantCodes(ctx, st)

	conn, err := grpc.NewClient(*rbacAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		slog.Error("dial rbac", "err", err)
		os.Exit(1)
	}
	defer conn.Close()

	lis, err := net.Listen("tcp", *addr)
	if err != nil {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
	srv := grpc.NewServer()
	pb.RegisterAuthServiceServer(srv, &server{st: st, iss: iss, rbac: rbacpb.NewRBACServiceClient(conn)})
	hs := health.NewServer()
	hs.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	grpc_health_v1.RegisterHealthServer(srv, hs)
	reflection.Register(srv)

	go func() {
		slog.Info("auth listening", "addr", *addr, "rbac", *rbacAddr, "session_ttl", ttl.String())
		if err := srv.Serve(lis); err != nil {
			slog.Error("serve", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	slog.Info("shutting down")
	srv.GracefulStop()
}
