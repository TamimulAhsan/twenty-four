// Command paymentsd serves the Payments service.
//
// Payments is SWAPPED PER MARKET. Hungary and Bangladesh each deploy their own
// implementation of the same gRPC contract, and nothing upstream knows which
// one it is talking to. This is the development implementation: a person
// decides, on a page, instead of a processor deciding.
//
// That is not a shortcut. A provider that always approved instantly would let
// callers quietly grow a dependence on synchronous success, and the first real
// card terminal would break them. A till that has been made to wait for a human
// is a till that will cope with a card machine.
//
// Two surfaces, deliberately separate:
//
//	gRPC :9106  PaymentsService, the market-neutral contract. No Approve here,
//	            because no real provider has such a call.
//	HTTP :9107  The provider's own approval desk, exactly where a hosted
//	            payment page would sit. Not part of the contract.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/payments/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/money"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/payments/internal/manual"
	"github.com/twentyfour/platform/services/payments/internal/store"
)

type server struct {
	pb.UnimplementedPaymentsServiceServer
	st *store.Store
	// publicBase is where a browser can reach the approval desk. Configuration
	// rather than something derived from the request, because the caller is a
	// till on a counter and the URL has to be one a back-office browser or a
	// customer's phone can actually open.
	publicBase string
}

func statusPB(s string) pb.PaymentStatus {
	switch s {
	case "pending":
		return pb.PaymentStatus_PAYMENT_STATUS_PENDING
	case "authorized":
		return pb.PaymentStatus_PAYMENT_STATUS_AUTHORIZED
	case "captured":
		return pb.PaymentStatus_PAYMENT_STATUS_CAPTURED
	case "failed":
		return pb.PaymentStatus_PAYMENT_STATUS_FAILED
	case "refunded":
		return pb.PaymentStatus_PAYMENT_STATUS_REFUNDED
	case "partially_refunded":
		return pb.PaymentStatus_PAYMENT_STATUS_PARTIALLY_REFUNDED
	case "cancelled":
		return pb.PaymentStatus_PAYMENT_STATUS_CANCELLED
	}
	return pb.PaymentStatus_PAYMENT_STATUS_UNSPECIFIED
}

func toPB(p store.Payment) *pb.Payment {
	out := &pb.Payment{
		Id: p.ID.String(), IdempotencyKey: p.IdempotencyKey,
		Amount:         &commonpb.Money{Minor: p.AmountMinor, Currency: p.Currency},
		RefundedAmount: &commonpb.Money{Minor: p.RefundedMinor, Currency: p.Currency},
		Status:         statusPB(p.Status), MethodKey: p.MethodKey,
		ReferenceType: p.ReferenceType, ReferenceId: p.ReferenceID,
		ProviderReference: p.ProviderReference, FailureReason: p.FailureReason,
		CreatedAt: timestamppb.New(p.CreatedAt),
	}
	if p.CapturedAt != nil {
		out.CapturedAt = timestamppb.New(*p.CapturedAt)
	}
	return out
}

func fail(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "no such payment")
	case errors.Is(err, store.ErrWrongState):
		return status.Error(codes.FailedPrecondition, "the payment is not in a state for that")
	case errors.Is(err, store.ErrTooMuch):
		return status.Error(codes.FailedPrecondition, "that is more than is left to refund")
	}
	slog.Error("payments", "err", err)
	return status.Error(codes.Internal, "could not complete that payment operation")
}

// CreateIntent is idempotent on the caller's key: the same key always returns
// the same payment, never a second charge.
func (s *server) CreateIntent(ctx context.Context, req *pb.CreateIntentRequest) (*pb.CreateIntentResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(req.GetIdempotencyKey())
	if key == "" {
		// Required, and refused rather than generated. A key this service
		// invented is a key the caller cannot repeat, which defeats the point.
		return nil, status.Error(codes.InvalidArgument,
			"an idempotency key is required, so a retry cannot charge twice")
	}
	amount := req.GetAmount()
	if amount.GetMinor() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "an amount is required")
	}
	if _, known := money.Exponent(amount.GetCurrency()); !known {
		return nil, status.Errorf(codes.InvalidArgument, "unknown currency %q", amount.GetCurrency())
	}
	method, ok := manual.MethodByKey(req.GetMethodKey())
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument,
			"this deployment cannot accept %q; ask ListMethods", req.GetMethodKey())
	}

	id := uuid.New()
	// Cash needs nothing outside the software: the money is in the drawer by
	// the time the button is pressed. Everything else waits for a person.
	initial := "captured"
	if method.RequiresExternalAction {
		initial = "pending"
	}

	p, existed, err := s.st.Create(ctx, store.Payment{
		ID: id, TenantID: tenant, IdempotencyKey: key,
		AmountMinor: amount.GetMinor(), Currency: strings.ToUpper(amount.GetCurrency()),
		Status: initial, MethodKey: method.Key,
		ReferenceType: req.GetReferenceType(), ReferenceID: req.GetReferenceId(),
		ProviderReference: manual.Reference(id.String()),
		Metadata:          req.GetMetadata(),
	})
	if err != nil {
		return nil, fail(err)
	}

	// Cash was created already captured, so its event has to be announced
	// separately: Create writes the row, Settle is what writes the event.
	if !existed && p.Status == "captured" {
		if settled, err := s.st.Settle(ctx, p.ID, "captured", "", "", "captured"); err == nil {
			p = settled
		} else {
			slog.Error("announce cash capture", "err", err, "payment", p.ID)
		}
	}

	resp := &pb.CreateIntentResponse{Payment: toPB(p)}
	if p.Status == "pending" {
		resp.ExternalActionUrl = fmt.Sprintf("%s/%s", s.publicBase, p.ID)
	}
	if existed {
		slog.Info("intent replayed", "tenant", tenant, "payment", p.ID, "key", key)
	} else {
		slog.Info("intent created", "tenant", tenant, "payment", p.ID,
			"method", method.Key, "minor", p.AmountMinor, "currency", p.Currency,
			"awaiting_person", p.Status == "pending")
	}
	return resp, nil
}

// Capture takes money that was authorised.
//
// This provider approves straight to captured, because most markets do and a
// two-step flow nobody exercises is a two-step flow that will be wrong when
// somebody finally does. Capture therefore exists, is idempotent on an already
// captured payment, and is here so a market that does separate the two has the
// call it needs.
func (s *server) Capture(ctx context.Context, req *pb.CaptureRequest) (*pb.CaptureResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetPaymentId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "payment_id must be a UUID")
	}
	p, err := s.st.ByID(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	if p.Status == "captured" {
		return &pb.CaptureResponse{Payment: toPB(p)}, nil
	}
	out, err := s.st.Settle(ctx, id, "captured", "", "", "authorized")
	if err != nil {
		return nil, fail(err)
	}
	return &pb.CaptureResponse{Payment: toPB(out)}, nil
}

// Cancel gives up on a payment nobody completed.
//
// Only a pending payment can be cancelled, and that is the whole point of the
// state: money that was never taken is released by calling it off, not by
// refunding it. Refunding money that never moved would put a credit on the
// books against a debit that does not exist.
//
// Idempotent on an already cancelled payment, because the till that gave up on
// a checkout may well give up on it twice.
func (s *server) Cancel(ctx context.Context, req *pb.CancelRequest) (*pb.CancelResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetPaymentId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "payment_id must be a UUID")
	}
	p, err := s.st.ByID(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	if p.Status == "cancelled" {
		return &pb.CancelResponse{Payment: toPB(p)}, nil
	}
	reason := req.GetReason()
	if reason == "" {
		reason = "cancelled before it was completed"
	}
	out, err := s.st.Settle(ctx, id, "cancelled", reason, "", "pending")
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("payment cancelled", "payment", id, "reason", reason)
	return &pb.CancelResponse{Payment: toPB(out)}, nil
}

func (s *server) Refund(ctx context.Context, req *pb.RefundRequest) (*pb.RefundResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetPaymentId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "payment_id must be a UUID")
	}
	p, err := s.st.ByID(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}

	// Omitting the amount refunds everything still refundable, which is what a
	// "refund this sale" button means.
	amount := p.AmountMinor - p.RefundedMinor
	if req.GetAmount() != nil && req.GetAmount().GetMinor() > 0 {
		amount = req.GetAmount().GetMinor()
		if c := strings.ToUpper(req.GetAmount().GetCurrency()); c != "" && c != p.Currency {
			return nil, status.Errorf(codes.InvalidArgument,
				"that payment was taken in %s, not %s", p.Currency, c)
		}
	}
	if amount <= 0 {
		return nil, status.Error(codes.FailedPrecondition, "there is nothing left to refund")
	}

	out, repeat, err := s.st.Refund(ctx, store.Refund{
		ID: uuid.New(), PaymentID: id, TenantID: tenant,
		AmountMinor: amount, Currency: p.Currency,
		Reason: req.GetReason(), IdempotencyKey: req.GetIdempotencyKey(),
	})
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("refunded", "tenant", tenant, "payment", id, "minor", amount, "repeat", repeat)
	return &pb.RefundResponse{Payment: toPB(out)}, nil
}

// GetPayment looks up by ID or by idempotency key. The key is how a caller
// recovers after a crash without knowing whether its request ever landed.
func (s *server) GetPayment(ctx context.Context, req *pb.GetPaymentRequest) (*pb.GetPaymentResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	var p store.Payment
	switch {
	case req.GetPaymentId() != "":
		id, err := uuid.Parse(req.GetPaymentId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "payment_id must be a UUID")
		}
		p, err = s.st.ByID(ctx, tenant, id)
		if err != nil {
			return nil, fail(err)
		}
	case req.GetIdempotencyKey() != "":
		p, err = s.st.ByKey(ctx, tenant, req.GetIdempotencyKey())
		if err != nil {
			return nil, fail(err)
		}
	default:
		return nil, status.Error(codes.InvalidArgument, "supply a payment_id or an idempotency_key")
	}
	return &pb.GetPaymentResponse{Payment: toPB(p)}, nil
}

// ListMethods is what the till renders its buttons from, rather than hardcoding
// "cash or card". A market that accepts a mobile wallet returns one here and
// the till shows it without being changed.
func (s *server) ListMethods(ctx context.Context, _ *pb.ListMethodsRequest) (*pb.ListMethodsResponse, error) {
	if _, err := tenantctx.Tenant(ctx); err != nil {
		return nil, err
	}
	resp := &pb.ListMethodsResponse{}
	for _, m := range manual.Methods {
		resp.Methods = append(resp.Methods, &pb.PaymentMethod{
			Key: m.Key, Label: m.Label,
			RequiresExternalAction: m.RequiresExternalAction,
			Electronic:             m.Electronic,
		})
	}
	return resp, nil
}

func (s *server) ListPayments(ctx context.Context, req *pb.ListPaymentsRequest) (*pb.ListPaymentsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	f := store.Filter{
		ReferenceType: req.GetReferenceType(),
		ReferenceID:   req.GetReferenceId(),
		Limit:         int(req.GetPageSize()),
	}
	if st := req.GetStatus(); st != pb.PaymentStatus_PAYMENT_STATUS_UNSPECIFIED {
		f.Status = strings.ToLower(strings.TrimPrefix(st.String(), "PAYMENT_STATUS_"))
	}
	list, err := s.st.List(ctx, tenant, f)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListPaymentsResponse{}
	for _, p := range list {
		resp.Payments = append(resp.Payments, toPB(p))
	}
	return resp, nil
}

func main() {
	addr := flag.String("addr", ":9106", "gRPC listen address")
	deskAddr := flag.String("desk-addr", ":9107", "HTTP address for the approval desk")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	publicBase := flag.String("public-base", "http://app.twentyfour.localhost/pay",
		"where a browser reaches the approval desk; goes into external_action_url")
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

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterPaymentsServiceServer(srv, &server{st: st, publicBase: strings.TrimRight(*publicBase, "/")})

	desk := &http.Server{
		Addr:              *deskAddr,
		Handler:           (&deskHandler{st: st}).routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		slog.Warn("the development payment provider is running: every card payment "+
			"waits for a person to approve it", "desk", *publicBase)
		if err := desk.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("desk", "err", err)
			os.Exit(1)
		}
	}()

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = desk.Shutdown(shutdown)
	}()

	if err := grpcx.Run(srv, *addr, "payments"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
