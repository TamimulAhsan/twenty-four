package main

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/twentyfour/platform/gen/go/twentyfour/pos/v1"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/pos/internal/store"
)

func statusPB(s string) pb.OrderStatus {
	switch s {
	case "open":
		return pb.OrderStatus_ORDER_STATUS_OPEN
	case "paid":
		return pb.OrderStatus_ORDER_STATUS_PAID
	case "refunded":
		return pb.OrderStatus_ORDER_STATUS_REFUNDED
	case "partly_refunded":
		return pb.OrderStatus_ORDER_STATUS_PARTLY_REFUNDED
	case "voided":
		return pb.OrderStatus_ORDER_STATUS_VOIDED
	}
	return pb.OrderStatus_ORDER_STATUS_UNSPECIFIED
}

func statusStr(s pb.OrderStatus) string {
	switch s {
	case pb.OrderStatus_ORDER_STATUS_OPEN:
		return "open"
	case pb.OrderStatus_ORDER_STATUS_PAID:
		return "paid"
	case pb.OrderStatus_ORDER_STATUS_REFUNDED:
		return "refunded"
	case pb.OrderStatus_ORDER_STATUS_PARTLY_REFUNDED:
		return "partly_refunded"
	case pb.OrderStatus_ORDER_STATUS_VOIDED:
		return "voided"
	}
	return ""
}

func orderPB(o store.Order) *pb.Order {
	out := &pb.Order{
		Id: o.ID.String(), Number: o.Number, PlacedAt: ts(o.PlacedAt),
		Status: statusPB(o.Status), CustomerName: o.CustomerName,
		DiscountCode: o.DiscountCode,
		Discount:     money(o.DiscountMinor, o.Currency),
		Gross:        money(o.GrossMinor, o.Currency),
		Net:          money(o.NetMinor, o.Currency),
		Tax:          money(o.TaxMinor, o.Currency),
		Note:         o.Note,
		Refunded:     money(o.RefundedMinor, o.Currency),
	}
	if o.CustomerID != nil {
		out.CustomerId = o.CustomerID.String()
	}
	if o.StaffID != nil {
		out.StaffId = o.StaffID.String()
	}
	if o.TableID != nil {
		out.TableId = o.TableID.String()
	}
	for _, l := range o.Lines {
		out.Lines = append(out.Lines, &pb.OrderLine{
			Id: l.ID.String(), ItemId: l.ItemID.String(), Name: l.Name,
			Quantity: l.Quantity, UnitPrice: money(l.UnitPriceMinor, o.Currency),
			TaxRate:     taxRate(l.TaxBasisPoints),
			TaxIncluded: l.TaxIncluded,
			Discount:    money(l.DiscountMinor, o.Currency),
			Gross:       money(l.GrossMinor, o.Currency),
			Net:         money(l.NetMinor, o.Currency),
			Tax:         money(l.TaxMinor, o.Currency),
			Refunded:    l.RefundedAt != nil,
		})
	}
	for _, t := range o.Tenders {
		tender := &pb.Tender{
			Id: t.ID.String(), Method: t.Method,
			Amount:    money(t.AmountMinor, o.Currency),
			Reference: t.Reference,
		}
		if t.PaymentID != nil {
			tender.PaymentId = t.PaymentID.String()
		}
		if t.TenderedMinor != nil {
			tender.Tendered = money(*t.TenderedMinor, o.Currency)
		}
		if t.ChangeMinor != nil {
			tender.Change = money(*t.ChangeMinor, o.Currency)
		}
		out.Tenders = append(out.Tenders, tender)
	}
	return out
}

// totals sums already-rounded lines rather than re-deriving tax from the order
// total. That is what keeps a receipt's lines adding up to its total.
func totals(lines []store.Line) (gross, net, tax int64) {
	for _, l := range lines {
		gross += l.GrossMinor
		net += l.NetMinor
		tax += l.TaxMinor
	}
	return
}

// --- selling ----------------------------------------------------------------

// PlaceOrder rings up a sale and takes the money for it.
//
// The order matters: price, then take payment, then write the sale. Writing the
// order first would leave a sale on the books for money that was never taken if
// the terminal was declined; taking the money last would mean a crash between
// the two leaves a sale nobody paid for. Money first is recoverable, because
// the idempotency key finds the payment on a retry.
func (s *server) PlaceOrder(ctx context.Context, req *pb.PlaceOrderRequest) (*pb.PlaceOrderResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.GetIdempotencyKey()) == "" {
		return nil, status.Error(codes.InvalidArgument,
			"an idempotency key is required, so a retried checkout cannot charge twice")
	}

	// A replay of a completed checkout must not price again, take money again,
	// or move stock again. It returns the sale it already made.
	if existing, err := s.st.ByKey(ctx, tenant, req.GetIdempotencyKey()); err == nil {
		return &pb.PlaceOrderResponse{Order: orderPB(existing)}, nil
	}

	lines, _, err := s.price(ctx, req.GetLines())
	if err != nil {
		return nil, err
	}
	gross, net, tax := totals(lines)

	// Derived, not random: an attempt at this same checkout must land on this
	// same sale, or its payments are taken twice. See checkoutID.
	orderID := checkoutID(tenant, req.GetIdempotencyKey())
	tenders, awaiting, err := s.takePayments(ctx, orderID, s.currency, req.GetTenders())
	if err != nil {
		return nil, err
	}
	if awaiting != nil {
		// Nothing is written and nothing is unwound. The customer is partway
		// through paying, not finished failing, and the till will ask again
		// under the same key once they are done.
		return &pb.PlaceOrderResponse{Awaiting: awaiting}, nil
	}
	// The money is already taken by this point, so a short payment is caught
	// before it: takePayments unwinds what it took when this fails.
	if tenderTotal(tenders) < gross {
		s.unwind(ctx, orderID, tenders)
		return nil, status.Error(codes.InvalidArgument, "the payments come to less than the sale")
	}

	customerID, err := optionalID(req.GetCustomerId())
	if err != nil {
		return nil, err
	}
	staffID, err := optionalID(req.GetStaffId())
	if err != nil {
		return nil, err
	}

	o := store.Order{
		ID: orderID, TenantID: tenant, Status: "paid", PlacedAt: time.Now(),
		CustomerID: customerID, DiscountCode: req.GetDiscountCode(),
		Currency: s.currency, GrossMinor: gross, NetMinor: net, TaxMinor: tax,
		StaffID: staffID, Note: req.GetNote(),
		IdempotencyKey: req.GetIdempotencyKey(),
		Lines:          lines, Tenders: tenders,
	}
	out, repeat, err := s.st.Insert(ctx, o, "order.placed", s.eventPayload)
	if err != nil {
		return nil, fail(err)
	}
	if !repeat {
		// Never reserved, so the shelf falls and no reservation is given back.
		s.moveStock(ctx, out, "consume", "")
		slog.Info("sale", "tenant", tenant, "order", out.ID, "number", out.Number,
			"gross", gross, "currency", s.currency)
	}
	return &pb.PlaceOrderResponse{Order: orderPB(out)}, nil
}

func tenderTotal(tenders []store.Tender) int64 {
	var sum int64
	for _, t := range tenders {
		sum += t.AmountMinor
	}
	return sum
}

// AbandonCheckout releases the payments of a sale that was never completed.
//
// The customer walked away from the terminal, or the cashier gave up waiting.
// There is no order to void, because a sale is only written once its money is
// in; what exists is one or more payments against a checkout ID that will now
// never become a sale, and they have to be given back.
//
// Safe to call on a checkout that took nothing, and safe to call twice.
func (s *server) AbandonCheckout(ctx context.Context, req *pb.AbandonCheckoutRequest) (*pb.AbandonCheckoutResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetCheckoutId(), "checkout_id")
	if err != nil {
		return nil, err
	}
	// A checkout that did become a sale is not abandoned, it is voided, and the
	// difference matters: voiding puts stock back, and this does not.
	if _, err := s.st.Order(ctx, tenant, id); err == nil {
		return nil, status.Error(codes.FailedPrecondition,
			"that sale went through. Void or refund it instead")
	}
	reason := req.GetReason()
	if reason == "" {
		reason = "the sale was abandoned before the payment completed"
	}
	released, err := s.release(ctx, id, reason)
	if err != nil {
		return nil, err
	}
	slog.Info("checkout abandoned", "tenant", tenant, "checkout", id, "released", released)
	return &pb.AbandonCheckoutResponse{Released: int32(released)}, nil
}

func (s *server) GetOrder(ctx context.Context, req *pb.GetOrderRequest) (*pb.GetOrderResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	o, err := s.st.Order(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetOrderResponse{Order: orderPB(o)}, nil
}

func (s *server) ListOrders(ctx context.Context, req *pb.ListOrdersRequest) (*pb.ListOrdersResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	f := store.Filter{Status: statusStr(req.GetStatus()), Limit: int(req.GetPageSize())}
	if v := req.GetFrom(); v != "" {
		d, err := time.Parse("2006-01-02", v)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "from must be YYYY-MM-DD")
		}
		f.From = d
	}
	if v := req.GetTo(); v != "" {
		d, err := time.Parse("2006-01-02", v)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "to must be YYYY-MM-DD")
		}
		// Inclusive of the whole day the caller named.
		f.To = d.AddDate(0, 0, 1)
	}
	list, err := s.st.List(ctx, tenant, f)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListOrdersResponse{}
	for _, o := range list {
		resp.Orders = append(resp.Orders, orderPB(o))
	}
	return resp, nil
}

// VoidOrder cancels a sale and puts its stock back.
//
// It does not refund the money: a void is for a sale that should not have been
// rung up at all, and whoever voids it is expected to give the money back the
// way it came. Refunding here would double up with the refund path.
func (s *server) VoidOrder(ctx context.Context, req *pb.VoidOrderRequest) (*pb.VoidOrderResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.GetReason()) == "" {
		return nil, status.Error(codes.InvalidArgument, "a void needs a reason")
	}
	out, err := s.st.Void(ctx, tenant, id, req.GetReason(), s.eventPayload)
	if err != nil {
		return nil, fail(err)
	}
	s.moveStock(ctx, out, "return", "sale voided: "+req.GetReason())
	slog.Info("sale voided", "tenant", tenant, "order", id, "reason", req.GetReason())
	return &pb.VoidOrderResponse{Order: orderPB(out)}, nil
}

// RefundOrder gives money back for the whole sale or for named lines.
//
// The money goes back through Payments, against the payments that took it, so
// it returns the way it came. Stock comes back at the same time, because a
// returned item is on the shelf again.
func (s *server) RefundOrder(ctx context.Context, req *pb.RefundOrderRequest) (*pb.RefundOrderResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	o, err := s.st.Order(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	if o.Status == "open" {
		return nil, status.Error(codes.FailedPrecondition, "that is a parked sale, not a sale")
	}
	if o.Status == "voided" {
		return nil, status.Error(codes.FailedPrecondition, "that sale was voided")
	}

	// Which lines, and what they are worth. Naming none means the whole sale,
	// which is every line not already returned.
	want := map[string]bool{}
	for _, lid := range req.GetLineIds() {
		want[lid] = true
	}
	var amount int64
	var lineIDs []uuid.UUID
	var returning []store.Line
	for _, l := range o.Lines {
		if len(want) > 0 && !want[l.ID.String()] {
			continue
		}
		if l.RefundedAt != nil {
			if len(want) > 0 {
				return nil, status.Error(codes.FailedPrecondition,
					"that line has already been refunded")
			}
			continue
		}
		amount += l.GrossMinor
		lineIDs = append(lineIDs, l.ID)
		returning = append(returning, l)
	}
	if amount <= 0 {
		return nil, status.Error(codes.FailedPrecondition, "there is nothing left to refund")
	}

	// Money first, then the record, for the same reason as placing a sale: a
	// refund recorded but not paid is worse than one paid but not recorded,
	// because only the second is visible to the person expecting the money.
	if err := s.refundTenders(ctx, o, amount, req.GetReason(), req.GetIdempotencyKey()); err != nil {
		return nil, err
	}
	out, err := s.st.MarkRefunded(ctx, tenant, id, lineIDs, amount)
	if err != nil {
		return nil, fail(err)
	}
	s.moveStock(ctx, store.Order{ID: o.ID, Lines: returning}, "return",
		"refunded: "+req.GetReason())
	slog.Info("refunded", "tenant", tenant, "order", id, "minor", amount, "lines", len(lineIDs))
	return &pb.RefundOrderResponse{Order: orderPB(out)}, nil
}

// --- parking ----------------------------------------------------------------

func (s *server) ParkOrder(ctx context.Context, req *pb.ParkOrderRequest) (*pb.ParkOrderResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	lines, _, err := s.price(ctx, req.GetLines())
	if err != nil {
		return nil, err
	}
	gross, net, tax := totals(lines)

	customerID, err := optionalID(req.GetCustomerId())
	if err != nil {
		return nil, err
	}
	staffID, err := optionalID(req.GetStaffId())
	if err != nil {
		return nil, err
	}
	tableID, err := optionalID(req.GetTableId())
	if err != nil {
		return nil, err
	}

	o := store.Order{
		ID: uuid.New(), TenantID: tenant, Status: "open", PlacedAt: time.Now(),
		CustomerID: customerID, Currency: s.currency,
		GrossMinor: gross, NetMinor: net, TaxMinor: tax,
		StaffID: staffID, Note: req.GetNote(), TableID: tableID,
		IdempotencyKey: req.GetIdempotencyKey(), Lines: lines,
	}
	// No event: nothing was sold. A parked sale is in nobody's takings and
	// nothing downstream should react to one.
	out, repeat, err := s.st.Insert(ctx, o, "", nil)
	if err != nil {
		return nil, fail(err)
	}
	if !repeat {
		// Held, not sold. The stock is still on the shelf and is not available
		// to promise to anyone else.
		s.moveStock(ctx, out, "reserve", "")
	}
	return &pb.ParkOrderResponse{Order: orderPB(out)}, nil
}

func (s *server) ListParked(ctx context.Context, _ *pb.ListParkedRequest) (*pb.ListParkedResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.st.List(ctx, tenant, store.Filter{Parked: true})
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListParkedResponse{}
	for _, o := range list {
		resp.Orders = append(resp.Orders, orderPB(o))
	}
	return resp, nil
}

func (s *server) UpdateParked(ctx context.Context, req *pb.UpdateParkedRequest) (*pb.UpdateParkedResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	before, err := s.st.Order(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	lines, _, err := s.price(ctx, req.GetLines())
	if err != nil {
		return nil, err
	}
	gross, net, tax := totals(lines)

	customerID, err := optionalID(req.GetCustomerId())
	if err != nil {
		return nil, err
	}
	staffID, err := optionalID(req.GetStaffId())
	if err != nil {
		return nil, err
	}
	tableID, err := optionalID(req.GetTableId())
	if err != nil {
		return nil, err
	}
	if req.GetClearTable() {
		tableID = nil
	} else if tableID == nil {
		tableID = before.TableID
	}

	out, err := s.st.ReplaceLines(ctx, tenant, id, store.Order{
		GrossMinor: gross, NetMinor: net, TaxMinor: tax,
		Note: req.GetNote(), StaffID: staffID, CustomerID: customerID,
		TableID: tableID, Lines: lines,
	})
	if err != nil {
		return nil, fail(err)
	}
	// The reservation is rebuilt rather than diffed: giving everything back and
	// taking what is now on the tab is one obvious thing, where a diff is three
	// cases and a bug in the third.
	s.moveStock(ctx, before, "release", "")
	s.moveStock(ctx, out, "reserve", "")
	return &pb.UpdateParkedResponse{Order: orderPB(out)}, nil
}

func (s *server) DiscardParked(ctx context.Context, req *pb.DiscardParkedRequest) (*pb.DiscardParkedResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	out, err := s.st.Discard(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	s.moveStock(ctx, out, "release", "")
	slog.Info("parked sale discarded", "tenant", tenant, "order", id)
	return &pb.DiscardParkedResponse{Discarded: true}, nil
}

// SettleParked takes the money on a tab.
//
// It becomes the sale it always was: same id, same number. Placing it afresh
// would leave the parked one behind holding its stock forever.
func (s *server) SettleParked(ctx context.Context, req *pb.SettleParkedRequest) (*pb.SettleParkedResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	o, err := s.st.Order(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	if o.Status != "open" {
		return nil, status.Error(codes.FailedPrecondition, "that sale is not parked")
	}

	// A parked sale already has an ID of its own, so its payment keys are
	// stable across attempts without deriving anything.
	tenders, awaiting, err := s.takePayments(ctx, id, o.Currency, req.GetTenders())
	if err != nil {
		return nil, err
	}
	if awaiting != nil {
		return &pb.SettleParkedResponse{Awaiting: awaiting}, nil
	}
	if tenderTotal(tenders) < o.GrossMinor {
		// The money is already taken by this point, exactly as on a new sale,
		// so it goes back before the refusal.
		s.unwind(ctx, id, tenders)
		return nil, status.Error(codes.InvalidArgument, "the payments come to less than the sale")
	}

	out, err := s.st.Settle(ctx, tenant, id, tenders, s.eventPayload)
	if err != nil {
		return nil, fail(err)
	}
	// From reserved to gone: the stock was already held for this tab.
	s.moveStock(ctx, out, "consume_reserved", "")
	slog.Info("tab settled", "tenant", tenant, "order", id, "number", out.Number)
	return &pb.SettleParkedResponse{Order: orderPB(out)}, nil
}
