// Command rbacd serves the RBAC service: it decides what an already-
// authenticated subject is permitted to do. It never sees a password.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/twentyfour/platform/gen/go/twentyfour/rbac/v1"
	"github.com/twentyfour/platform/services/rbac/internal/policy"
	"github.com/twentyfour/platform/services/rbac/internal/store"
)

type server struct {
	pb.UnimplementedRBACServiceServer
	st *store.Store
}

func planeFromPB(p pb.Plane) policy.Plane {
	switch p {
	case pb.Plane_PLANE_ADMIN:
		return policy.PlaneAdmin
	case pb.Plane_PLANE_TENANT:
		return policy.PlaneTenant
	}
	return policy.Plane("")
}

func planeToPB(p policy.Plane) pb.Plane {
	switch p {
	case policy.PlaneAdmin:
		return pb.Plane_PLANE_ADMIN
	case policy.PlaneTenant:
		return pb.Plane_PLANE_TENANT
	}
	return pb.Plane_PLANE_UNSPECIFIED
}

func ids(tenant, subject string) (uuid.UUID, uuid.UUID, error) {
	t, err := uuid.Parse(tenant)
	if err != nil {
		return uuid.Nil, uuid.Nil, status.Error(codes.InvalidArgument, "tenant_id must be a UUID")
	}
	s, err := uuid.Parse(subject)
	if err != nil {
		return uuid.Nil, uuid.Nil, status.Error(codes.InvalidArgument, "subject_id must be a UUID")
	}
	return t, s, nil
}

// Check is the gateway's hot path. It fails closed: any error denies.
func (s *server) Check(ctx context.Context, req *pb.CheckRequest) (*pb.CheckResponse, error) {
	tenantID, subjectID, err := ids(req.GetTenantId(), req.GetSubjectId())
	if err != nil {
		return nil, err
	}
	roles, err := s.st.RolesForSubject(ctx, tenantID, subjectID)
	if err != nil {
		slog.Error("check: load roles", "err", err)
		return nil, status.Error(codes.Internal, "could not evaluate permission")
	}
	allowed, by := policy.Decide(roles, planeFromPB(req.GetPlane()), policy.Permission(req.GetPermission()))
	return &pb.CheckResponse{Allowed: allowed, GrantedByRole: by}, nil
}

func (s *server) CheckMany(ctx context.Context, req *pb.CheckManyRequest) (*pb.CheckManyResponse, error) {
	tenantID, subjectID, err := ids(req.GetTenantId(), req.GetSubjectId())
	if err != nil {
		return nil, err
	}
	roles, err := s.st.RolesForSubject(ctx, tenantID, subjectID)
	if err != nil {
		return nil, status.Error(codes.Internal, "could not evaluate permissions")
	}
	plane := planeFromPB(req.GetPlane())
	out := make(map[string]bool, len(req.GetPermissions()))
	for _, p := range req.GetPermissions() {
		allowed, _ := policy.Decide(roles, plane, policy.Permission(p))
		out[p] = allowed
	}
	return &pb.CheckManyResponse{Results: out}, nil
}

func (s *server) AssignRole(ctx context.Context, req *pb.AssignRoleRequest) (*pb.AssignRoleResponse, error) {
	tenantID, subjectID, err := ids(req.GetTenantId(), req.GetSubjectId())
	if err != nil {
		return nil, err
	}
	var actor *uuid.UUID
	if a, err := uuid.Parse(req.GetActorId()); err == nil {
		actor = &a
	}
	b, err := s.st.AssignRole(ctx, tenantID, subjectID, req.GetRoleKey(), actor)
	if errors.Is(err, store.ErrNotFound) {
		return nil, status.Errorf(codes.NotFound, "no such role %q", req.GetRoleKey())
	}
	if err != nil {
		slog.Error("assign role", "err", err)
		return nil, status.Error(codes.Internal, "could not assign role")
	}
	slog.Info("role assigned", "tenant", tenantID, "subject", subjectID, "role", req.GetRoleKey())
	return &pb.AssignRoleResponse{Binding: &pb.RoleBinding{
		Id: b.ID.String(), TenantId: b.TenantID.String(),
		SubjectId: b.SubjectID.String(), RoleKey: b.RoleKey,
		CreatedAt: timestamppb.New(time.Now()),
	}}, nil
}

func (s *server) RevokeRole(ctx context.Context, req *pb.RevokeRoleRequest) (*pb.RevokeRoleResponse, error) {
	tenantID, subjectID, err := ids(req.GetTenantId(), req.GetSubjectId())
	if err != nil {
		return nil, err
	}
	ok, err := s.st.RevokeRole(ctx, tenantID, subjectID, req.GetRoleKey())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not revoke role")
	}
	return &pb.RevokeRoleResponse{Revoked: ok}, nil
}

func (s *server) GetSubjectRoles(ctx context.Context, req *pb.GetSubjectRolesRequest) (*pb.GetSubjectRolesResponse, error) {
	tenantID, subjectID, err := ids(req.GetTenantId(), req.GetSubjectId())
	if err != nil {
		return nil, err
	}
	roles, err := s.st.RolesForSubject(ctx, tenantID, subjectID)
	if err != nil {
		return nil, status.Error(codes.Internal, "could not load roles")
	}
	resp := &pb.GetSubjectRolesResponse{}
	for _, r := range roles {
		resp.Roles = append(resp.Roles, toPBRole(r))
	}
	// Flatten within each plane the subject actually holds roles in.
	for _, pl := range []policy.Plane{policy.PlaneTenant, policy.PlaneAdmin} {
		for _, p := range policy.Flatten(roles, pl) {
			resp.Permissions = append(resp.Permissions, string(p))
		}
	}
	return resp, nil
}

func (s *server) ListRoles(ctx context.Context, req *pb.ListRolesRequest) (*pb.ListRolesResponse, error) {
	tenantID, err := uuid.Parse(req.GetTenantId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "tenant_id must be a UUID")
	}
	plane := ""
	if p := planeFromPB(req.GetPlane()); p.Valid() {
		plane = string(p)
	}
	roles, err := s.st.ListRoles(ctx, tenantID, plane, req.GetIncludeSystem())
	if err != nil {
		return nil, status.Error(codes.Internal, "could not list roles")
	}
	resp := &pb.ListRolesResponse{}
	for _, r := range roles {
		resp.Roles = append(resp.Roles, toPBRole(r))
	}
	return resp, nil
}

func (s *server) ListPermissions(_ context.Context, req *pb.ListPermissionsRequest) (*pb.ListPermissionsResponse, error) {
	resp := &pb.ListPermissionsResponse{}
	for _, p := range policy.KnownPermissions {
		if d := req.GetDomain(); d != "" && p.Domain() != d {
			continue
		}
		resp.Permissions = append(resp.Permissions, &pb.Permission{Key: string(p), Domain: p.Domain()})
	}
	return resp, nil
}

func toPBRole(r policy.Role) *pb.Role {
	out := &pb.Role{
		Key: r.Key, Name: r.Name, Description: r.Description,
		Plane: planeToPB(r.Plane), System: r.System,
	}
	for _, p := range r.Permissions {
		out.Permissions = append(out.Permissions, string(p))
	}
	return out
}

func main() {
	addr := flag.String("addr", ":9101", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx := context.Background()

	st, err := store.Open(ctx, *dsn)
	if err != nil {
		slog.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	if err := st.Migrate(ctx, *dsn); err != nil {
		slog.Error("migrate", "err", err)
		os.Exit(1)
	}
	if err := st.SeedSystemRoles(ctx); err != nil {
		slog.Error("seed system roles", "err", err)
		os.Exit(1)
	}
	slog.Info("schema ready", "system_roles", len(policy.SystemRoles))

	lis, err := net.Listen("tcp", *addr)
	if err != nil {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
	srv := grpc.NewServer()
	pb.RegisterRBACServiceServer(srv, &server{st: st})
	hs := health.NewServer()
	hs.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	grpc_health_v1.RegisterHealthServer(srv, hs)
	reflection.Register(srv) // so grpcurl works against it in dev

	go func() {
		slog.Info("rbac listening", "addr", *addr)
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
