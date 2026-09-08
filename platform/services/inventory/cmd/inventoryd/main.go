// Command inventoryd serves the Inventory service: what is physically there.
//
// Every change is a move with a reason, and the level is derived from the moves.
// That is what makes "why is this number 3" a question with an answer, and it
// is what lets the stock event be written in the same transaction as the change
// it describes.
//
// Stock moves on cash sales, comps, manual corrections and unpaid bookings, not
// only on a settled card. That is the one thing about this service worth
// remembering: an earlier draft of the architecture decremented on
// payment.succeeded alone, which silently broke every one of those cases.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	catalogpb "github.com/twentyfour/platform/gen/go/twentyfour/catalog/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/inventory/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/inventory/internal/store"
)

type server struct {
	pb.UnimplementedInventoryServiceServer
	st      *store.Store
	catalog catalogpb.CatalogServiceClient
}

func parseID(s, what string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, status.Errorf(codes.InvalidArgument, "%s must be a UUID", what)
	}
	return id, nil
}

func fail(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "that item has no stock record")
	case errors.Is(err, store.ErrOverRelease):
		return status.Error(codes.FailedPrecondition, "that is more than is reserved")
	}
	slog.Error("inventory", "err", err)
	return status.Error(codes.Internal, "could not read or write stock")
}

func levelPB(l store.Level, name string) *pb.Level {
	out := &pb.Level{
		ItemId: l.ItemID.String(), ItemName: name,
		OnHand: l.OnHand, Reserved: l.Reserved,
		UpdatedAt: timestamppb.New(l.UpdatedAt),
	}
	if l.Threshold != nil {
		out.LowStockThreshold = l.Threshold
	}
	return out
}

// names resolves display names from Catalog.
//
// Inventory never stores a name. Two services holding the same string is two
// places for it to be renamed, and a stock report showing an item's old name is
// the sort of thing nobody notices until it matters. The identity forwarded on
// the context is the caller's, so Catalog scopes its answer to the same tenant.
func (s *server) names(ctx context.Context) map[string]string {
	out := map[string]string{}
	resp, err := s.catalog.ListItems(ctx, &catalogpb.ListItemsRequest{
		PageSize: 500, IncludeInactive: true, IncludeArchived: true,
	})
	if err != nil {
		// A name is presentation. Losing it must not fail a stock query: the
		// numbers are what the till needs, and the dashboard can render an ID.
		slog.Warn("could not resolve item names", "err", err)
		return out
	}
	for _, it := range resp.GetItems() {
		out[it.GetId()] = it.GetName()
	}
	return out
}

func (s *server) ListLevels(ctx context.Context, req *pb.ListLevelsRequest) (*pb.ListLevelsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	levels, err := s.st.ListLevels(ctx, tenant, req.GetLowOnly())
	if err != nil {
		return nil, fail(err)
	}
	names := s.names(ctx)
	resp := &pb.ListLevelsResponse{}
	for _, l := range levels {
		resp.Levels = append(resp.Levels, levelPB(l, names[l.ItemID.String()]))
	}
	return resp, nil
}

func (s *server) GetLevel(ctx context.Context, req *pb.GetLevelRequest) (*pb.GetLevelResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetItemId(), "item_id")
	if err != nil {
		return nil, err
	}
	l, err := s.st.Level(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetLevelResponse{Level: levelPB(l, s.itemName(ctx, req.GetItemId()))}, nil
}

func (s *server) itemName(ctx context.Context, itemID string) string {
	resp, err := s.catalog.GetItem(ctx, &catalogpb.GetItemRequest{Id: itemID})
	if err != nil {
		return ""
	}
	return resp.GetItem().GetName()
}

// requireStockedItem refuses stock for something that is not a stocked item.
//
// It asks Catalog rather than trusting the caller, because a typo in an item ID
// would otherwise create a stock record for a product that does not exist, and
// a stock report full of orphan UUIDs is worse than an error.
func (s *server) requireStockedItem(ctx context.Context, itemID string) error {
	resp, err := s.catalog.GetItem(ctx, &catalogpb.GetItemRequest{Id: itemID})
	if status.Code(err) == codes.NotFound {
		return status.Error(codes.NotFound, "no such item")
	}
	if err != nil {
		// Catalog being down must not be reported as "no such item": one is a
		// transient fault and the other is a mistake by the caller.
		slog.Error("catalog lookup", "err", err, "item", itemID)
		return status.Error(codes.Unavailable, "could not check that item right now")
	}
	if !resp.GetItem().GetTrackStock() {
		return status.Error(codes.FailedPrecondition, "that item is not stock tracked")
	}
	return nil
}

func (s *server) Adjust(ctx context.Context, req *pb.AdjustRequest) (*pb.AdjustResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	itemID, err := parseID(req.GetItemId(), "item_id")
	if err != nil {
		return nil, err
	}
	if req.GetDelta() == 0 {
		return nil, status.Error(codes.InvalidArgument, "an adjustment of zero changes nothing")
	}
	// Required, and not merely by convention. The ledger needs it, and a number
	// that changed for no recorded reason is a number nobody trusts afterwards.
	if strings.TrimSpace(req.GetReason()) == "" {
		return nil, status.Error(codes.InvalidArgument, "an adjustment needs a reason")
	}
	if err := s.requireStockedItem(ctx, req.GetItemId()); err != nil {
		return nil, err
	}

	actor := tenantctx.User(ctx)
	m := store.Move{
		TenantID: tenant, ItemID: itemID, Delta: req.GetDelta(),
		Kind: "adjustment", Reason: strings.TrimSpace(req.GetReason()),
		ReferenceType: "adjustment", IdempotencyKey: req.GetIdempotencyKey(),
	}
	if actor != uuid.Nil {
		m.ActorID = &actor
	}
	l, repeat, err := s.st.Apply(ctx, m)
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("stock adjusted", "tenant", tenant, "item", itemID,
		"delta", req.GetDelta(), "on_hand", l.OnHand, "repeat", repeat)
	return &pb.AdjustResponse{Level: levelPB(l, s.itemName(ctx, req.GetItemId()))}, nil
}

func (s *server) SetThreshold(ctx context.Context, req *pb.SetThresholdRequest) (*pb.SetThresholdResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	itemID, err := parseID(req.GetItemId(), "item_id")
	if err != nil {
		return nil, err
	}
	if req.LowStockThreshold != nil && req.GetLowStockThreshold() < 0 {
		return nil, status.Error(codes.InvalidArgument, "a threshold cannot be negative")
	}
	if err := s.requireStockedItem(ctx, req.GetItemId()); err != nil {
		return nil, err
	}
	l, err := s.st.SetThreshold(ctx, tenant, itemID, req.LowStockThreshold)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.SetThresholdResponse{Level: levelPB(l, s.itemName(ctx, req.GetItemId()))}, nil
}

// move is the shared path for reserve, release and consume: they differ only in
// which counters they touch, which the store already knows.
func (s *server) move(ctx context.Context, kind, itemID string, qty int32,
	refType, refID, idem string) (*pb.Level, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(itemID, "item_id")
	if err != nil {
		return nil, err
	}
	if qty <= 0 {
		return nil, status.Error(codes.InvalidArgument, "quantity must be positive")
	}
	actor := tenantctx.User(ctx)
	m := store.Move{
		TenantID: tenant, ItemID: id, Delta: qty, Kind: kind,
		ReferenceType: refType, ReferenceID: refID, IdempotencyKey: idem,
	}
	if actor != uuid.Nil {
		m.ActorID = &actor
	}
	l, _, err := s.st.Apply(ctx, m)
	if err != nil {
		return nil, fail(err)
	}
	return levelPB(l, ""), nil
}

func (s *server) Reserve(ctx context.Context, req *pb.ReserveRequest) (*pb.ReserveResponse, error) {
	l, err := s.move(ctx, "reserve", req.GetItemId(), req.GetQuantity(),
		req.GetReferenceType(), req.GetReferenceId(), req.GetIdempotencyKey())
	if err != nil {
		return nil, err
	}
	return &pb.ReserveResponse{Level: l}, nil
}

func (s *server) Release(ctx context.Context, req *pb.ReleaseRequest) (*pb.ReleaseResponse, error) {
	l, err := s.move(ctx, "release", req.GetItemId(), req.GetQuantity(),
		req.GetReferenceType(), req.GetReferenceId(), req.GetIdempotencyKey())
	if err != nil {
		return nil, err
	}
	return &pb.ReleaseResponse{Level: l}, nil
}

func (s *server) Consume(ctx context.Context, req *pb.ConsumeRequest) (*pb.ConsumeResponse, error) {
	// A walk-in sale was never held, so only the shelf falls. Treating it as a
	// consume of a reservation that does not exist would drive reserved
	// negative and make promised stock look available.
	kind := "consume"
	if req.GetUnreserved() {
		kind = "consume_unreserved"
	}
	l, err := s.move(ctx, kind, req.GetItemId(), req.GetQuantity(),
		req.GetReferenceType(), req.GetReferenceId(), req.GetIdempotencyKey())
	if err != nil {
		return nil, err
	}
	return &pb.ConsumeResponse{Level: l}, nil
}

func main() {
	addr := flag.String("addr", ":9104", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	catalogAddr := flag.String("catalog", "catalog:9103", "Catalog service address")
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

	conn, err := grpcx.Dial(*catalogAddr)
	if err != nil {
		slog.Error("dial catalog", "err", err)
		os.Exit(1)
	}
	defer conn.Close()

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterInventoryServiceServer(srv, &server{
		st: st, catalog: catalogpb.NewCatalogServiceClient(conn),
	})
	if err := grpcx.Run(srv, *addr, "inventory"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
