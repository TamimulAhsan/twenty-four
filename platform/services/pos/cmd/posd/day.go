package main

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	paymentspb "github.com/twentyfour/platform/gen/go/twentyfour/payments/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/pos/v1"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/pos/internal/store"
)

// refundTenders puts money back through the payments that took it.
//
// Proportionally, so a sale paid half in cash and half by card gives half back
// each way. Money goes back the way it came: refunding it all to the card
// because that is easier would leave the drawer over and the card statement
// short, and somebody would spend an afternoon on it at the end of the month.
func (s *server) refundTenders(ctx context.Context, o store.Order, amount int64, reason, key string) error {
	total := tenderTotal(o.Tenders)
	if total <= 0 {
		return status.Error(codes.FailedPrecondition, "that sale has no payments to refund")
	}

	var given int64
	for i, t := range o.Tenders {
		if t.PaymentID == nil {
			continue
		}
		share := amount * t.AmountMinor / total
		if i == len(o.Tenders)-1 {
			// The last one absorbs the rounding, so the parts add up to the
			// whole rather than leaving a forint behind.
			share = amount - given
		}
		if share <= 0 {
			continue
		}
		given += share

		idem := key
		if idem != "" {
			idem = fmt.Sprintf("%s-%d", idem, i)
		}
		if _, err := s.payments.Refund(ctx, &paymentspb.RefundRequest{
			PaymentId:      t.PaymentID.String(),
			Amount:         &commonpb.Money{Minor: share, Currency: o.Currency},
			Reason:         reason,
			IdempotencyKey: idem,
		}); err != nil {
			slog.Error("refund", "order", o.ID, "payment", t.PaymentID, "err", err)
			return status.Error(codes.FailedPrecondition,
				"the money could not be given back, so nothing was changed")
		}
	}
	return nil
}

// --- the day ----------------------------------------------------------------

// day turns a date into the half-open range that is that day.
//
// Local midnight to local midnight, in the service's own zone. One environment
// is one market, so there is one answer to "when does the day start", and no
// per-tenant timezone logic is needed here yet.
func day(date string) (time.Time, time.Time, error) {
	if date == "" {
		now := time.Now()
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		return start, start.AddDate(0, 0, 1), nil
	}
	d, err := time.ParseInLocation("2006-01-02", date, time.Local)
	if err != nil {
		return time.Time{}, time.Time{}, status.Error(codes.InvalidArgument, "date must be YYYY-MM-DD")
	}
	return d, d.AddDate(0, 0, 1), nil
}

func (s *server) GetTakings(ctx context.Context, req *pb.GetTakingsRequest) (*pb.GetTakingsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	from, to, err := day(req.GetDate())
	if err != nil {
		return nil, err
	}
	t, err := s.st.Takings(ctx, tenant, from, to, s.currency)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.GetTakingsResponse{
		Date: from.Format("2006-01-02"), OrderCount: t.OrderCount,
		Gross:    money(t.GrossMinor, t.Currency),
		Net:      money(t.NetMinor, t.Currency),
		Tax:      money(t.TaxMinor, t.Currency),
		Refunded: money(t.RefundedMinor, t.Currency),
	}
	for _, m := range t.ByMethod {
		resp.ByMethod = append(resp.ByMethod, &pb.MethodTotal{
			Method: m.Method, Amount: money(m.AmountMinor, t.Currency), Count: m.Count,
		})
	}
	for _, b := range t.ByTaxBand {
		resp.ByTaxBand = append(resp.ByTaxBand, &pb.TaxBand{
			BasisPoints: b.BasisPoints,
			Net:         money(b.NetMinor, t.Currency),
			Tax:         money(b.TaxMinor, t.Currency),
			Gross:       money(b.GrossMinor, t.Currency),
		})
	}
	return resp, nil
}

func dayClosePB(d store.DayClose) *pb.DayClose {
	expected := d.OpeningFloatMinor + d.CashTakenMinor - d.CashRefundedMinor
	out := &pb.DayClose{
		Date:         d.Date.Format("2006-01-02"),
		OpeningFloat: money(d.OpeningFloatMinor, d.Currency),
		CashTaken:    money(d.CashTakenMinor, d.Currency),
		CashRefunded: money(d.CashRefundedMinor, d.Currency),
		ExpectedCash: money(expected, d.Currency),
		Note:         d.Note, Closed: d.Closed,
	}
	if d.CountedMinor != nil {
		out.CountedCash = money(*d.CountedMinor, d.Currency)
		// Negative is short. Reported rather than hidden, because a drawer that
		// is repeatedly short is the number somebody needs to see.
		out.Variance = money(*d.CountedMinor-expected, d.Currency)
	}
	if d.CountedBy != nil {
		out.CountedBy = d.CountedBy.String()
	}
	if d.CountedAt != nil {
		out.CountedAt = ts(*d.CountedAt)
	}
	return out
}

func (s *server) GetDayClose(ctx context.Context, req *pb.GetDayCloseRequest) (*pb.GetDayCloseResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	from, to, err := day(req.GetDate())
	if err != nil {
		return nil, err
	}
	d, err := s.st.DayClose(ctx, tenant, from, to, s.currency)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetDayCloseResponse{DayClose: dayClosePB(d)}, nil
}

func (s *server) CloseDay(ctx context.Context, req *pb.CloseDayRequest) (*pb.CloseDayResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	from, to, err := day(req.GetDate())
	if err != nil {
		return nil, err
	}
	counted := req.GetCountedCash()
	if counted == nil {
		return nil, status.Error(codes.InvalidArgument, "a count is required to close the day")
	}
	var by *uuid.UUID
	if u := tenantctx.User(ctx); u != uuid.Nil {
		by = &u
	}
	if err := s.st.CloseDay(ctx, tenant, from,
		req.GetOpeningFloat().GetMinor(), counted.GetMinor(),
		s.currency, req.GetNote(), by); err != nil {
		return nil, fail(err)
	}
	d, err := s.st.DayClose(ctx, tenant, from, to, s.currency)
	if err != nil {
		return nil, fail(err)
	}
	out := dayClosePB(d)
	slog.Info("day closed", "tenant", tenant, "date", out.GetDate(),
		"expected", out.GetExpectedCash().GetMinor(),
		"counted", counted.GetMinor(),
		"variance", out.GetVariance().GetMinor())
	return &pb.CloseDayResponse{DayClose: out}, nil
}

// --- the floor --------------------------------------------------------------

func tableStatusPB(s string) pb.TableStatus {
	switch s {
	case "free":
		return pb.TableStatus_TABLE_STATUS_FREE
	case "seated":
		return pb.TableStatus_TABLE_STATUS_SEATED
	case "ordered":
		return pb.TableStatus_TABLE_STATUS_ORDERED
	case "bill_requested":
		return pb.TableStatus_TABLE_STATUS_BILL_REQUESTED
	}
	return pb.TableStatus_TABLE_STATUS_UNSPECIFIED
}

func tableStatusStr(s pb.TableStatus) string {
	switch s {
	case pb.TableStatus_TABLE_STATUS_FREE:
		return "free"
	case pb.TableStatus_TABLE_STATUS_SEATED:
		return "seated"
	case pb.TableStatus_TABLE_STATUS_ORDERED:
		return "ordered"
	case pb.TableStatus_TABLE_STATUS_BILL_REQUESTED:
		return "bill_requested"
	}
	return ""
}

func tablePB(t store.Table) *pb.Table {
	out := &pb.Table{
		Id: t.ID.String(), Label: t.Label, Seats: t.Seats, Area: t.Area,
		Status: tableStatusPB(t.Status),
	}
	if t.PartySize != nil {
		out.PartySize = *t.PartySize
	}
	if t.SeatedAt != nil {
		out.SeatedAt = ts(*t.SeatedAt)
	}
	if t.StaffID != nil {
		out.StaffId = t.StaffID.String()
	}
	if t.OrderID != nil {
		out.OrderId = t.OrderID.String()
	}
	return out
}

func (s *server) ListTables(ctx context.Context, _ *pb.ListTablesRequest) (*pb.ListTablesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.st.Tables(ctx, tenant)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListTablesResponse{}
	for _, t := range list {
		resp.Tables = append(resp.Tables, tablePB(t))
	}
	return resp, nil
}

func (s *server) CreateTable(ctx context.Context, req *pb.CreateTableRequest) (*pb.CreateTableResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if req.GetLabel() == "" {
		return nil, status.Error(codes.InvalidArgument, "a table needs a label")
	}
	seats := req.GetSeats()
	if seats <= 0 {
		seats = 2
	}
	t, err := s.st.CreateTable(ctx, tenant, store.Table{
		ID: uuid.New(), Label: req.GetLabel(), Seats: seats, Area: req.GetArea(),
	})
	if err != nil {
		return nil, fail(err)
	}
	return &pb.CreateTableResponse{Table: tablePB(t)}, nil
}

func (s *server) UpdateTable(ctx context.Context, req *pb.UpdateTableRequest) (*pb.UpdateTableResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	var partySize *int32
	if v := req.GetPartySize(); v > 0 {
		partySize = &v
	}
	staffID, err := optionalID(req.GetStaffId())
	if err != nil {
		return nil, err
	}
	t, err := s.st.UpdateTable(ctx, tenant, id, tableStatusStr(req.GetStatus()),
		partySize, req.GetClearPartySize(), staffID, req.GetClearStaff())
	if err != nil {
		return nil, fail(err)
	}
	return &pb.UpdateTableResponse{Table: tablePB(t)}, nil
}
