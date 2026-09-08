// Command staffd serves the Staff service: the people who work for a tenant.
//
// It owns the employment view of a person and the seat quota. It does not own
// their login, which is Auth's, or their role, which is RBAC's: a member's ID
// here IS their Auth user ID, so one person has one identifier everywhere.
//
// The seat limit is enforced here. One seat is one person across both surfaces,
// so when CRM Sync exists it must refuse the matching Twenty workspace member
// from the same number. Enforcing it only in the dashboard is how a CRM drifts
// past the tier without anyone noticing.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"sort"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	rbacpb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/staff/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/staff/internal/store"
)

type server struct {
	pb.UnimplementedStaffServiceServer
	st   *store.Store
	auth authpb.AuthServiceClient
	rbac rbacpb.RBACServiceClient
	// seatLimit is a flag until Entitlement exists. Zero means unlimited,
	// which is what Enterprise negotiates.
	seatLimit int32
}

func statusPB(s string) pb.MemberStatus {
	switch s {
	case "active":
		return pb.MemberStatus_MEMBER_STATUS_ACTIVE
	case "invited":
		return pb.MemberStatus_MEMBER_STATUS_INVITED
	case "deactivated":
		return pb.MemberStatus_MEMBER_STATUS_DEACTIVATED
	case "locked":
		// A locked account is a person who mistyped their password five times.
		// They still work here and still hold a seat, so the dashboard should
		// show them as active rather than inventing a fourth state for it.
		return pb.MemberStatus_MEMBER_STATUS_ACTIVE
	}
	return pb.MemberStatus_MEMBER_STATUS_UNSPECIFIED
}

// holdsSeat is the seat rule in one place.
//
// An invitation holds a seat because the person will accept, and a seat that
// frees up while someone is slow to read their email is a seat that gets sold
// twice. Deactivating releases one and keeps their history intact.
func holdsSeat(status string) bool { return status != "deactivated" }

func parseID(s, what string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, status.Errorf(codes.InvalidArgument, "%s must be a UUID", what)
	}
	return id, nil
}

// roster is everything needed to answer a list or check a quota, gathered once.
type roster struct {
	users []*authpb.User
	roles map[string]string
	seats *pb.Seats
}

func (s *server) load(ctx context.Context, tenant uuid.UUID, includeDeactivated bool) (roster, error) {
	list, err := s.auth.ListUsers(ctx, &authpb.ListUsersRequest{
		TenantId: tenant.String(), IncludeDeactivated: true,
	})
	if err != nil {
		slog.Error("list users", "err", err, "tenant", tenant)
		return roster{}, status.Error(codes.Unavailable, "could not read the team right now")
	}

	var used int32
	kept := make([]*authpb.User, 0, len(list.GetUsers()))
	for _, u := range list.GetUsers() {
		st := strings.ToLower(strings.TrimPrefix(u.GetStatus().String(), "USER_STATUS_"))
		if holdsSeat(st) {
			used++
		}
		if includeDeactivated || st != "deactivated" {
			kept = append(kept, u)
		}
	}

	// One call per person, which is fine at these numbers: the largest tier is
	// fifteen seats. If that ever changes, RBAC grows a bulk lookup rather than
	// this growing a cache that can be stale.
	roles := map[string]string{}
	for _, u := range kept {
		resp, err := s.rbac.GetSubjectRoles(ctx, &rbacpb.GetSubjectRolesRequest{
			TenantId: tenant.String(), SubjectId: u.GetId(),
		})
		if err != nil {
			slog.Warn("subject roles", "err", err, "user", u.GetId())
			continue
		}
		roles[u.GetId()] = mostCapableRole(resp.GetRoles())
	}
	return roster{users: kept, roles: roles, seats: &pb.Seats{Limit: s.seatLimit, Used: used}}, nil
}

// mostCapableRole picks one label for someone who holds several.
//
// A person with both owner and staff is an owner: showing the narrower of the
// two would misrepresent what they can do. Unknown roles rank below the known
// ones rather than above, so a custom role never outranks owner by accident.
func mostCapableRole(roles []*rbacpb.Role) string {
	rank := map[string]int{"owner": 4, "manager": 3, "accountant": 2, "staff": 1}
	best, bestRank := "", -1
	keys := make([]string, 0, len(roles))
	for _, r := range roles {
		keys = append(keys, r.GetKey())
	}
	// Sorted so a tie between two custom roles resolves the same way twice.
	sort.Strings(keys)
	for _, k := range keys {
		if r := rank[k]; r > bestRank {
			best, bestRank = k, r
		}
	}
	return best
}

func (s *server) memberPB(u *authpb.User, role, colour string) *pb.Member {
	st := strings.ToLower(strings.TrimPrefix(u.GetStatus().String(), "USER_STATUS_"))
	m := &pb.Member{
		Id: u.GetId(), Name: u.GetDisplayName(), Email: u.GetEmail(),
		RoleKey: role, Status: statusPB(st), Colour: colour,
	}
	if st == "invited" {
		m.InvitedAt = u.GetCreatedAt()
	}
	if u.GetLastLoginAt() != nil {
		m.LastActiveAt = u.GetLastLoginAt()
	}
	return m
}

func (s *server) assemble(ctx context.Context, tenant uuid.UUID, r roster) ([]*pb.Member, error) {
	colours, err := s.st.Colours(ctx, tenant)
	if err != nil {
		return nil, status.Error(codes.Internal, "could not read the team")
	}
	out := make([]*pb.Member, 0, len(r.users))
	for _, u := range r.users {
		id, err := uuid.Parse(u.GetId())
		if err != nil {
			continue
		}
		colour, ok := colours[id]
		if !ok {
			// Someone who exists in Auth with no member row: the tenant owner
			// is the obvious case, created by Signup rather than by an invite.
			// Backfilling rather than falling back to a default matters,
			// because a default is not "taken" as far as colour assignment is
			// concerned, and the first person invited would be handed the
			// owner's colour.
			colour = s.claimColour(ctx, tenant, id, colours)
			colours[id] = colour
		}
		out = append(out, s.memberPB(u, r.roles[u.GetId()], colour))
	}
	return out, nil
}

// claimColour assigns and records a colour for someone who has none, counting
// the colours already handed out in this pass so a backfill of several people
// does not give them all the same one.
func (s *server) claimColour(ctx context.Context, tenant, user uuid.UUID, taken map[uuid.UUID]string) string {
	count := map[string]int{}
	for _, c := range taken {
		count[c]++
	}
	best, bestN := store.Palette[0], -1
	for _, c := range store.Palette {
		if n := count[c]; bestN < 0 || n < bestN {
			best, bestN = c, n
		}
	}
	// No event: nobody joined, this is bookkeeping catching up with a person
	// who was already here.
	if _, err := s.st.Upsert(ctx, store.Member{TenantID: tenant, UserID: user, Colour: best}, "", nil); err != nil {
		slog.Warn("backfill colour", "err", err, "user", user)
	}
	return best
}

func (s *server) ListMembers(ctx context.Context, req *pb.ListMembersRequest) (*pb.ListMembersResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.load(ctx, tenant, req.GetIncludeDeactivated())
	if err != nil {
		return nil, err
	}
	members, err := s.assemble(ctx, tenant, r)
	if err != nil {
		return nil, err
	}
	return &pb.ListMembersResponse{Members: members, Seats: r.seats}, nil
}

func (s *server) GetSeats(ctx context.Context, _ *pb.GetSeatsRequest) (*pb.GetSeatsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.load(ctx, tenant, false)
	if err != nil {
		return nil, err
	}
	return &pb.GetSeatsResponse{Seats: r.seats}, nil
}

// InviteMember is the seat check, and the only place it happens.
//
// The order matters: check the quota, create the login, bind the role, then
// record the member and announce it. A failure part way leaves an account that
// can be re-invited, which is recoverable; doing it the other way round would
// leave a seat consumed by nobody, which is not visible to anyone.
func (s *server) InviteMember(ctx context.Context, req *pb.InviteMemberRequest) (*pb.InviteMemberResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	email := strings.TrimSpace(strings.ToLower(req.GetEmail()))
	if email == "" || !strings.Contains(email, "@") {
		return nil, status.Error(codes.InvalidArgument, "a valid email address is required")
	}
	if strings.TrimSpace(req.GetName()) == "" {
		return nil, status.Error(codes.InvalidArgument, "a name is required")
	}

	r, err := s.load(ctx, tenant, false)
	if err != nil {
		return nil, err
	}
	if s.seatLimit > 0 && r.seats.GetUsed() >= s.seatLimit {
		return nil, status.Errorf(codes.ResourceExhausted,
			"this plan includes %d seats and all of them are in use", s.seatLimit)
	}

	// Assemble first: it backfills a member row for anyone who has none, so
	// the owner's colour counts as taken before the next one is chosen.
	if _, err := s.assemble(ctx, tenant, r); err != nil {
		return nil, err
	}
	colour, err := s.st.NextColour(ctx, tenant)
	if err != nil {
		slog.Warn("colour", "err", err)
	}

	invited, err := s.auth.InviteUser(ctx, &authpb.InviteUserRequest{
		TenantId: tenant.String(), Email: email,
		DisplayName: strings.TrimSpace(req.GetName()),
		RoleKey:     req.GetRoleKey(), ActorId: tenantctx.User(ctx).String(),
	})
	if err != nil {
		if status.Code(err) == codes.AlreadyExists {
			return nil, status.Error(codes.AlreadyExists, "someone with that email is already on the team")
		}
		slog.Error("invite", "err", err, "tenant", tenant)
		return nil, status.Error(codes.Internal, "could not send that invitation")
	}
	userID, err := uuid.Parse(invited.GetUser().GetId())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not send that invitation")
	}

	role := req.GetRoleKey()
	if role == "" {
		role = "staff"
	}
	if _, err := s.st.Upsert(ctx, store.Member{
		TenantID: tenant, UserID: userID, Colour: colour,
	}, "staff.added", map[string]any{
		"user_id": userID, "email": email,
		"name": strings.TrimSpace(req.GetName()), "role_key": role,
	}); err != nil {
		slog.Error("record member", "err", err, "user", userID)
		return nil, status.Error(codes.Internal, "the invitation was sent but the record failed")
	}

	slog.Info("member invited", "tenant", tenant, "user", userID, "role", role,
		"seats_used", r.seats.GetUsed()+1, "seats_limit", s.seatLimit)
	return &pb.InviteMemberResponse{
		Member:      s.memberPB(invited.GetUser(), role, colour),
		InviteToken: invited.GetInviteToken(),
		Seats:       &pb.Seats{Limit: s.seatLimit, Used: r.seats.GetUsed() + 1},
	}, nil
}

func (s *server) UpdateMember(ctx context.Context, req *pb.UpdateMemberRequest) (*pb.UpdateMemberResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	actor := tenantctx.User(ctx)

	r, err := s.load(ctx, tenant, true)
	if err != nil {
		return nil, err
	}
	var subject *authpb.User
	for _, u := range r.users {
		if u.GetId() == req.GetId() {
			subject = u
		}
	}
	if subject == nil {
		return nil, status.Error(codes.NotFound, "no such team member")
	}
	current := strings.ToLower(strings.TrimPrefix(subject.GetStatus().String(), "USER_STATUS_"))

	// The rule that stops a team locking itself out. It is enforced here rather
	// than only in the dashboard, because the dashboard is one of several
	// things that can call this.
	if err := s.protectLastOwner(ctx, tenant, r, req, userID, actor); err != nil {
		return nil, err
	}

	if role := req.GetRoleKey(); role != "" && role != r.roles[req.GetId()] {
		if old := r.roles[req.GetId()]; old != "" {
			if _, err := s.rbac.RevokeRole(ctx, &rbacpb.RevokeRoleRequest{
				TenantId: tenant.String(), SubjectId: req.GetId(),
				RoleKey: old, ActorId: actor.String(),
			}); err != nil {
				slog.Error("revoke role", "err", err)
				return nil, status.Error(codes.Internal, "could not change that role")
			}
		}
		if _, err := s.rbac.AssignRole(ctx, &rbacpb.AssignRoleRequest{
			TenantId: tenant.String(), SubjectId: req.GetId(),
			RoleKey: role, ActorId: actor.String(),
		}); err != nil {
			slog.Error("assign role", "err", err)
			return nil, status.Error(codes.Internal, "could not change that role")
		}
		r.roles[req.GetId()] = role
	}

	switch req.GetStatus() {
	case pb.MemberStatus_MEMBER_STATUS_DEACTIVATED:
		if current != "deactivated" {
			if _, err := s.auth.DeactivateUser(ctx, &authpb.DeactivateUserRequest{
				TenantId: tenant.String(), UserId: req.GetId(), ActorId: actor.String(),
			}); err != nil {
				return nil, status.Error(codes.Internal, "could not deactivate that account")
			}
			subject.Status = authpb.UserStatus_USER_STATUS_DEACTIVATED
			if err := s.st.Announce(ctx, tenant, userID, "staff.removed", map[string]any{
				"user_id": userID, "reason": "deactivated",
			}); err != nil {
				slog.Error("announce", "err", err)
			}
		}
	case pb.MemberStatus_MEMBER_STATUS_ACTIVE:
		if current == "deactivated" {
			// Reactivating takes a seat back, so the quota is checked again.
			if s.seatLimit > 0 && r.seats.GetUsed() >= s.seatLimit {
				return nil, status.Errorf(codes.ResourceExhausted,
					"this plan includes %d seats and all of them are in use", s.seatLimit)
			}
			resp, err := s.auth.ReactivateUser(ctx, &authpb.ReactivateUserRequest{
				TenantId: tenant.String(), UserId: req.GetId(), ActorId: actor.String(),
			})
			if err != nil {
				return nil, status.Error(codes.Internal, "could not reactivate that account")
			}
			subject = resp.GetUser()
			if err := s.st.Announce(ctx, tenant, userID, "staff.added", map[string]any{
				"user_id": userID, "email": subject.GetEmail(), "reason": "reactivated",
			}); err != nil {
				slog.Error("announce", "err", err)
			}
		}
	}

	after, err := s.load(ctx, tenant, true)
	if err != nil {
		return nil, err
	}
	colours, _ := s.st.Colours(ctx, tenant)
	colour := colours[userID]
	if colour == "" {
		colour = store.Palette[0]
	}
	return &pb.UpdateMemberResponse{
		Member: s.memberPB(subject, after.roles[req.GetId()], colour),
		Seats:  after.seats,
	}, nil
}

// protectLastOwner refuses the two changes that would leave a tenant with
// nobody who can administer it: demoting the last owner, and deactivating them.
//
// A business that has locked itself out of its own account is a support call
// that cannot be resolved by the merchant, and the refusal costs nothing.
func (s *server) protectLastOwner(ctx context.Context, tenant uuid.UUID, r roster,
	req *pb.UpdateMemberRequest, userID, actor uuid.UUID) error {
	losingOwner := r.roles[req.GetId()] == "owner" &&
		((req.GetRoleKey() != "" && req.GetRoleKey() != "owner") ||
			req.GetStatus() == pb.MemberStatus_MEMBER_STATUS_DEACTIVATED)
	if !losingOwner {
		return nil
	}
	owners := 0
	for _, u := range r.users {
		st := strings.ToLower(strings.TrimPrefix(u.GetStatus().String(), "USER_STATUS_"))
		if r.roles[u.GetId()] == "owner" && st != "deactivated" {
			owners++
		}
	}
	if owners <= 1 {
		return status.Error(codes.FailedPrecondition,
			"this is the only owner. Make someone else an owner first.")
	}
	return nil
}

func (s *server) ReissueInvitation(ctx context.Context, req *pb.ReissueInvitationRequest) (*pb.ReissueInvitationResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := parseID(req.GetId(), "id"); err != nil {
		return nil, err
	}
	resp, err := s.auth.ReissueInvite(ctx, &authpb.ReissueInviteRequest{
		TenantId: tenant.String(), UserId: req.GetId(),
	})
	if err != nil {
		if status.Code(err) == codes.FailedPrecondition {
			return nil, status.Error(codes.FailedPrecondition, "they have already accepted")
		}
		return nil, status.Error(codes.Internal, "could not send that invitation again")
	}
	r, err := s.load(ctx, tenant, false)
	if err != nil {
		return nil, err
	}
	members, err := s.assemble(ctx, tenant, r)
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		if m.GetId() == req.GetId() {
			return &pb.ReissueInvitationResponse{Member: m, InviteToken: resp.GetInviteToken()}, nil
		}
	}
	return nil, status.Error(codes.NotFound, "no such team member")
}

// RemoveMember deletes only an invitation that was never accepted.
//
// Auth refuses anything else, and this reports that refusal in the words a
// merchant needs: the person's name is on orders and documents that have to
// stay resolvable, so the answer is to deactivate them instead.
func (s *server) RemoveMember(ctx context.Context, req *pb.RemoveMemberRequest) (*pb.RemoveMemberResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	if _, err := s.auth.DeleteUser(ctx, &authpb.DeleteUserRequest{
		TenantId: tenant.String(), UserId: req.GetId(), ActorId: tenantctx.User(ctx).String(),
	}); err != nil {
		if status.Code(err) == codes.FailedPrecondition {
			return nil, status.Error(codes.FailedPrecondition,
				"they have signed in before, so their account can only be deactivated")
		}
		return nil, status.Error(codes.Internal, "could not remove that account")
	}
	if err := s.st.Delete(ctx, tenant, userID, map[string]any{
		"user_id": userID, "reason": "invitation withdrawn",
	}); err != nil {
		slog.Error("delete member", "err", err, "user", userID)
	}
	r, err := s.load(ctx, tenant, false)
	if err != nil {
		return nil, err
	}
	slog.Info("invitation withdrawn", "tenant", tenant, "user", userID)
	return &pb.RemoveMemberResponse{Seats: r.seats}, nil
}

func main() {
	addr := flag.String("addr", ":9105", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	authAddr := flag.String("auth", "auth:9102", "Auth service address")
	rbacAddr := flag.String("rbac", "rbac:9101", "RBAC service address")
	// Entitlement does not exist yet. When it does, this reads from there and
	// nothing else changes: the number is already checked in exactly one place.
	seats := flag.Int("seat-limit", 3, "seats included in the tier; 0 means unlimited")
	level := flag.String("log-level", "info", "debug, info, warn or error")
	flag.Parse()

	grpcx.SetupLogging(*level)
	ctx := context.Background()

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

	authConn, err := grpcx.Dial(*authAddr)
	if err != nil {
		slog.Error("dial auth", "err", err)
		os.Exit(1)
	}
	defer authConn.Close()
	rbacConn, err := grpcx.Dial(*rbacAddr)
	if err != nil {
		slog.Error("dial rbac", "err", err)
		os.Exit(1)
	}
	defer rbacConn.Close()

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterStaffServiceServer(srv, &server{
		st:   st,
		auth: authpb.NewAuthServiceClient(authConn),
		rbac: rbacpb.NewRBACServiceClient(rbacConn),
		// Guard against a negative flag turning into "unlimited".
		seatLimit: int32(max(0, *seats)),
	})
	slog.Info("seat limit", "seats", *seats, "note", "from Entitlement once that service exists")

	if err := grpcx.Run(srv, *addr, "staff"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
