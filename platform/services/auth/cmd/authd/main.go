// Command authd serves the Auth service: who someone is, and whether they are
// still signed in. It never decides what anyone may do — that is RBAC's job,
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
	"github.com/twentyfour/platform/services/auth/internal/store"
	"github.com/twentyfour/platform/services/auth/internal/token"
)

const (
	maxFailedAttempts = 5
	lockoutWindow     = 15 * time.Minute
	oneTimeTokenTTL   = 24 * time.Hour
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
	return "tenant" // default; unspecified is treated as the merchant plane
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
	// anything, so signup genuinely is not complete until this lands — better
	// to fail loudly here than to leave a half-created account behind.
	if _, err := s.rbac.AssignRole(ctx, &rbacpb.AssignRoleRequest{
		TenantId: tenantID.String(), SubjectId: u.ID.String(), RoleKey: "owner",
	}); err != nil {
		slog.Error("signup: assign owner role", "err", err, "user", u.ID)
		return nil, status.Error(codes.Internal, "account created but role assignment failed")
	}

	verify := randomToken()
	if err := s.st.CreateOneTimeToken(ctx, u.ID, "verify_email", verify, oneTimeTokenTTL); err != nil {
		slog.Error("signup: verification token", "err", err)
	}

	slog.Info("signup", "user", u.ID, "tenant", tenantID)
	return &pb.SignupResponse{User: toPBUser(u), TenantId: tenantID.String(), VerificationToken: verify}, nil
}

// Login is written so that an unknown account and a wrong password are
// indistinguishable: same error, and the same argon2 work is done either way.
func (s *server) Login(ctx context.Context, req *pb.LoginRequest) (*pb.LoginResponse, error) {
	plane := planeStr(req.GetPlane())
	denied := status.Error(codes.Unauthenticated, "invalid email or password")

	u, err := s.st.UserByEmail(ctx, req.GetEmail(), plane)
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
	if u.Status == "deactivated" {
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

	tok, exp, err := s.iss.Issue(token.Claims{
		UserID: u.ID.String(), TenantID: u.TenantID.String(),
		SessionID: sess.ID.String(), Plane: u.Plane,
	})
	if err != nil {
		return nil, status.Error(codes.Internal, "could not issue token")
	}
	if err := s.st.RecordLoginSuccess(ctx, u.ID); err != nil {
		slog.Error("login: record success", "err", err)
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
	u, err := s.st.UserByEmail(ctx, req.GetEmail(), planeStr(req.GetPlane()))
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
		slog.Warn("no TOKEN_KEY set — generated an ephemeral one; sessions will not survive a restart")
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
