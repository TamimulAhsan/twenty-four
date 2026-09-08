// Command posd serves the POS service: registering a sale.
//
// That is all it means, in every trade. A candy shop, a boutique and a salon
// all need a till and none of them has a kitchen. Nothing here is named for one
// trade; the kitchen display is a view over these same orders, switched on by
// the industry profile, and the floor plan is the same.
//
// It is the first service that composes several others: prices from Catalog,
// money through Payments, stock through Inventory. It holds none of their data,
// with one exception that matters: the priced lines are copied onto the order
// and never re-read, because a sale must not change because somebody edited a
// price afterwards.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	catalogpb "github.com/twentyfour/platform/gen/go/twentyfour/catalog/v1"
	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	inventorypb "github.com/twentyfour/platform/gen/go/twentyfour/inventory/v1"
	paymentspb "github.com/twentyfour/platform/gen/go/twentyfour/payments/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/pos/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/services/pos/internal/store"
)

type server struct {
	pb.UnimplementedPosServiceServer
	st        *store.Store
	catalog   catalogpb.CatalogServiceClient
	payments  paymentspb.PaymentsServiceClient
	inventory inventorypb.InventoryServiceClient
	// One environment is one market, so one currency. When Tenant & Business
	// Profile exists this is read from there.
	currency string
}

func parseID(s, what string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, status.Errorf(codes.InvalidArgument, "%s must be a UUID", what)
	}
	return id, nil
}

func optionalID(s string) (*uuid.UUID, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "%q is not a valid id", s)
	}
	return &id, nil
}

func fail(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "no such sale")
	case errors.Is(err, store.ErrNotParked):
		return status.Error(codes.FailedPrecondition, "that sale is not parked")
	case errors.Is(err, store.ErrNotASale):
		return status.Error(codes.FailedPrecondition, "that is a parked sale, not a sale")
	case errors.Is(err, store.ErrTableBusy):
		return status.Error(codes.FailedPrecondition, "that table already has an open tab")
	case errors.Is(err, store.ErrLineClosed):
		return status.Error(codes.FailedPrecondition, "that line has already been refunded")
	}
	slog.Error("pos", "err", err)
	return status.Error(codes.Internal, "could not complete that")
}

// --- pricing ----------------------------------------------------------------

// price asks Catalog what the lines cost.
//
// The figures that come back are copied onto the order and never read again.
// That is the whole reason the order carries them: a receipt reprinted next
// year has to show what was actually charged, not what the item costs now.
func (s *server) price(ctx context.Context, lines []*pb.LineInput) ([]store.Line, *catalogpb.PriceItemsResponse, error) {
	if len(lines) == 0 {
		return nil, nil, status.Error(codes.InvalidArgument, "a sale needs at least one line")
	}
	req := &catalogpb.PriceItemsRequest{}
	for _, l := range lines {
		if l.GetQuantity() <= 0 {
			return nil, nil, status.Error(codes.InvalidArgument, "a line needs a quantity")
		}
		req.Lines = append(req.Lines, &catalogpb.PriceLineRequest{
			ItemId: l.GetItemId(), Quantity: l.GetQuantity(), DiscountMinor: l.GetDiscountMinor(),
		})
	}
	resp, err := s.catalog.PriceItems(ctx, req)
	if err != nil {
		if code := status.Code(err); code == codes.NotFound || code == codes.InvalidArgument {
			return nil, nil, err
		}
		slog.Error("price items", "err", err)
		return nil, nil, status.Error(codes.Unavailable, "the price list is not answering")
	}

	out := make([]store.Line, 0, len(resp.GetLines()))
	for _, l := range resp.GetLines() {
		itemID, err := uuid.Parse(l.GetItemId())
		if err != nil {
			return nil, nil, status.Error(codes.Internal, "the price list returned an unusable item")
		}
		out = append(out, store.Line{
			ID: uuid.New(), ItemID: itemID, Name: l.GetName(), Quantity: l.GetQuantity(),
			UnitPriceMinor: l.GetUnitPrice().GetMinor(),
			TaxBasisPoints: l.GetTaxRate().GetBasisPoints(),
			TaxIncluded:    true,
			DiscountMinor:  l.GetDiscountMinor(),
			GrossMinor:     l.GetGross().GetMinor(),
			NetMinor:       l.GetNet().GetMinor(),
			TaxMinor:       l.GetTax().GetMinor(),
		})
	}
	return out, resp, nil
}

// --- stock ------------------------------------------------------------------

// moveStock tells Inventory what left the shelf, or came back to it.
//
// Deliberately after the sale is committed, and deliberately not fatal. Stock
// moves on cash sales, comps, manual corrections and unpaid bookings, not only
// on a settled card, which is why this is called from placing and parking
// rather than from a payment. If Inventory is down the sale still happened; the
// count is corrected afterwards, and the log says so loudly.
//
// The durable answer is Inventory consuming order.placed, which the event
// already carries everything for. This call is what makes the number right now.
func (s *server) moveStock(ctx context.Context, o store.Order, kind, reason string) {
	for _, l := range o.Lines {
		key := kind + "-" + o.ID.String() + "-" + l.ID.String()
		var err error
		switch kind {
		case "reserve":
			_, err = s.inventory.Reserve(ctx, &inventorypb.ReserveRequest{
				ItemId: l.ItemID.String(), Quantity: l.Quantity,
				ReferenceType: "order", ReferenceId: o.ID.String(), IdempotencyKey: key,
			})
		case "release":
			_, err = s.inventory.Release(ctx, &inventorypb.ReleaseRequest{
				ItemId: l.ItemID.String(), Quantity: l.Quantity,
				ReferenceType: "order", ReferenceId: o.ID.String(), IdempotencyKey: key,
			})
		case "consume", "consume_reserved":
			_, err = s.inventory.Consume(ctx, &inventorypb.ConsumeRequest{
				ItemId: l.ItemID.String(), Quantity: l.Quantity,
				ReferenceType: "order", ReferenceId: o.ID.String(), IdempotencyKey: key,
				Unreserved: kind == "consume",
			})
		case "return":
			// A void or a refund puts stock back. An adjustment rather than a
			// release, because nothing was reserved: it was sold and has come
			// back, and the movement history should say exactly that.
			_, err = s.inventory.Adjust(ctx, &inventorypb.AdjustRequest{
				ItemId: l.ItemID.String(), Delta: l.Quantity,
				Reason: reason, IdempotencyKey: key,
			})
		}
		if err != nil && status.Code(err) != codes.FailedPrecondition {
			// FailedPrecondition is "that item is not stock tracked", which is
			// the normal case for a service and not worth a line in the log.
			slog.Error("stock did not move with the sale",
				"order", o.ID, "item", l.ItemID, "kind", kind, "err", err,
				"action", "the count for this item needs correcting")
		}
	}
}

func (s *server) eventPayload(o store.Order) map[string]any {
	lines := make([]map[string]any, 0, len(o.Lines))
	for _, l := range o.Lines {
		lines = append(lines, map[string]any{
			"line_id": l.ID, "item_id": l.ItemID, "name": l.Name,
			"quantity":         l.Quantity,
			"gross":            map[string]any{"minor": l.GrossMinor, "currency": o.Currency},
			"tax_basis_points": l.TaxBasisPoints,
		})
	}
	tenders := make([]map[string]any, 0, len(o.Tenders))
	for _, t := range o.Tenders {
		tenders = append(tenders, map[string]any{
			"method": t.Method, "payment_id": t.PaymentID,
			"amount": map[string]any{"minor": t.AmountMinor, "currency": o.Currency},
		})
	}
	return map[string]any{
		"order_id": o.ID, "number": o.Number, "status": o.Status,
		"placed_at": o.PlacedAt,
		"gross":     map[string]any{"minor": o.GrossMinor, "currency": o.Currency},
		"net":       map[string]any{"minor": o.NetMinor, "currency": o.Currency},
		"tax":       map[string]any{"minor": o.TaxMinor, "currency": o.Currency},
		"lines":     lines, "tenders": tenders,
		"staff_id": o.StaffID, "customer_id": o.CustomerID,
		"table_id": o.TableID, "note": o.Note,
	}
}

func main() {
	addr := flag.String("addr", ":9108", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	catalogAddr := flag.String("catalog", "catalog:9103", "Catalog service address")
	inventoryAddr := flag.String("inventory", "inventory:9104", "Inventory service address")
	paymentsAddr := flag.String("payments", "payments:9106", "Payments service address")
	currency := flag.String("currency", "HUF", "this market's currency")
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

	dial := func(target string) *grpc.ClientConn {
		conn, err := grpcx.Dial(target)
		if err != nil {
			slog.Error("dial", "target", target, "err", err)
			os.Exit(1)
		}
		return conn
	}
	catalogConn := dial(*catalogAddr)
	defer catalogConn.Close()
	inventoryConn := dial(*inventoryAddr)
	defer inventoryConn.Close()
	paymentsConn := dial(*paymentsAddr)
	defer paymentsConn.Close()

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterPosServiceServer(srv, &server{
		st:        st,
		catalog:   catalogpb.NewCatalogServiceClient(catalogConn),
		inventory: inventorypb.NewInventoryServiceClient(inventoryConn),
		payments:  paymentspb.NewPaymentsServiceClient(paymentsConn),
		currency:  *currency,
	})
	slog.Info("till", "currency", *currency)

	if err := grpcx.Run(srv, *addr, "pos"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}

// money is the wire shape. Integer minor units and an explicit currency code,
// always, including inside events.
func money(minor int64, currency string) *commonpb.Money {
	return &commonpb.Money{Minor: minor, Currency: currency}
}

func ts(t time.Time) *timestamppb.Timestamp { return timestamppb.New(t) }

// taxRate as basis points, so 27% is 2700. Integers avoid the float problem in
// the multiplier as well as in the amount.
func taxRate(bp int32) *commonpb.TaxRate { return &commonpb.TaxRate{BasisPoints: bp} }
