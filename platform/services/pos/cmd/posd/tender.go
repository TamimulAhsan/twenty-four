package main

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	paymentspb "github.com/twentyfour/platform/gen/go/twentyfour/payments/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/pos/v1"
	"github.com/twentyfour/platform/services/pos/internal/store"
)

// Taking the money.
//
// POS asks Payments for a payment and gets a result. It never learns which rail
// this market answered with, and it holds no card data of its own: what it
// keeps is a pointer to the Payments record.
//
// The till still waits for a human, because that is what a card terminal feels
// like and a till that cannot wait is a till the first real terminal breaks.
// What it does not do is wait here, with the request held open. A payment that
// needs a person needs that person to be somewhere, and this call answers with
// where: the till sends them there and asks again once they are done.
//
// Blocking in this function looked simpler and was wrong. The customer has to
// reach a page the service cannot open for them, so a service that only sits
// and polls is waiting on something it never told anyone to do.

// checkoutNS namespaces the derived checkout IDs. Any fixed UUID does; this one
// is arbitrary and must never change, because changing it would give a
// half-finished checkout a different ID on its next attempt.
var checkoutNS = uuid.MustParse("6f1d5b90-3e0a-4f26-9d0b-2c9a4a5f8e11")

// checkoutID derives a sale's ID from the key the till generated for it.
//
// Random would be simpler until the first retry: a checkout asked for twice
// would be two sales, with two sets of payment keys, and the second attempt
// would charge again for what the first already took. Deriving it means every
// attempt at one checkout lands on one ID, so the payments keyed from it are
// found rather than created.
//
// Scoped by tenant so two tenants cannot collide on a key either of them chose.
func checkoutID(tenant uuid.UUID, key string) uuid.UUID {
	return uuid.NewSHA1(checkoutNS, []byte(tenant.String()+"\x00"+key))
}

// takePayments settles every tender on an order, in order.
//
// Three outcomes. Everything settled, and the sale can be written. Something
// needs a person, and the action says where to send them: nothing is unwound,
// because the customer has not failed to pay, they have not finished paying.
// Or it failed, and anything already taken goes straight back: a customer who
// paid half in cash and was then declined on the card must not be left having
// paid half.
func (s *server) takePayments(ctx context.Context, orderID uuid.UUID, currency string,
	inputs []*pb.TenderInput) ([]store.Tender, *pb.PaymentAction, error) {
	if len(inputs) == 0 {
		return nil, nil, status.Error(codes.InvalidArgument, "a sale needs at least one payment")
	}

	var taken []store.Tender
	// Best effort, and loud when it fails. Money taken for a sale that did not
	// happen is the one thing here that must never be silent.
	refundTaken := func() { s.unwind(ctx, orderID, taken) }

	for i, in := range inputs {
		amount := in.GetAmount()
		if amount.GetMinor() <= 0 {
			refundTaken()
			return nil, nil, status.Error(codes.InvalidArgument, "a payment needs an amount")
		}
		if c := amount.GetCurrency(); c != "" && c != currency {
			refundTaken()
			return nil, nil, status.Errorf(codes.InvalidArgument,
				"this sale is in %s, not %s", currency, c)
		}

		tender, action, err := s.takeOne(ctx, orderID, i, currency, in)
		switch {
		case err != nil:
			refundTaken()
			return nil, nil, err
		case action != nil:
			return nil, action, nil
		}
		taken = append(taken, tender)
	}
	return taken, nil, nil
}

func (s *server) takeOne(ctx context.Context, orderID uuid.UUID, index int,
	currency string, in *pb.TenderInput) (store.Tender, *pb.PaymentAction, error) {
	// Derived from the order and the position, and the order is itself derived
	// from the till's idempotency key, so a checkout asked for again reuses
	// these keys and Payments returns the payments it already made rather than
	// charging a second time.
	key := fmt.Sprintf("order-%s-tender-%d", orderID, index)

	resp, err := s.payments.CreateIntent(ctx, &paymentspb.CreateIntentRequest{
		IdempotencyKey: key,
		Amount:         &commonpb.Money{Minor: in.GetAmount().GetMinor(), Currency: currency},
		MethodKey:      in.GetMethod(),
		ReferenceType:  "order", ReferenceId: orderID.String(),
	})
	if err != nil {
		if status.Code(err) == codes.InvalidArgument {
			return store.Tender{}, nil, err
		}
		slog.Error("create intent", "err", err, "order", orderID)
		return store.Tender{}, nil, status.Error(codes.Unavailable,
			"payments is not answering, so this sale was not taken")
	}

	p := resp.GetPayment()
	if p.GetStatus() == paymentspb.PaymentStatus_PAYMENT_STATUS_PENDING {
		// Something outside the software has to happen: a terminal tapped, a
		// customer sent somewhere. Say where, and let the till take them.
		url := resp.GetExternalActionUrl()
		if url == "" {
			// A method that needs a person but names nowhere to send them is
			// unfinishable, and pretending otherwise strands the sale.
			return store.Tender{}, nil, status.Error(codes.FailedPrecondition,
				"that payment is waiting on something, but payments did not say where")
		}
		slog.Info("a payment needs completing",
			"order", orderID, "payment", p.GetId(), "at", url)
		return store.Tender{}, &pb.PaymentAction{
			CheckoutId: orderID.String(),
			PaymentId:  p.GetId(),
			MethodKey:  in.GetMethod(),
			Url:        url,
			Amount:     &commonpb.Money{Minor: in.GetAmount().GetMinor(), Currency: currency},
		}, nil
	}

	switch p.GetStatus() {
	case paymentspb.PaymentStatus_PAYMENT_STATUS_CAPTURED,
		paymentspb.PaymentStatus_PAYMENT_STATUS_AUTHORIZED:
	case paymentspb.PaymentStatus_PAYMENT_STATUS_FAILED:
		reason := p.GetFailureReason()
		if reason == "" {
			reason = "the payment was declined"
		}
		return store.Tender{}, nil, status.Errorf(codes.FailedPrecondition, "%s", reason)
	case paymentspb.PaymentStatus_PAYMENT_STATUS_CANCELLED:
		// The till gave up on this checkout and then asked for it again. Say so
		// plainly rather than reporting a decline, which would send a cashier
		// looking at the customer's card.
		return store.Tender{}, nil, status.Error(codes.FailedPrecondition,
			"that payment was called off. Start the sale again")
	default:
		return store.Tender{}, nil, status.Error(codes.FailedPrecondition,
			"that payment did not complete")
	}

	paymentID, err := uuid.Parse(p.GetId())
	if err != nil {
		return store.Tender{}, nil, status.Error(codes.Internal, "payments returned an unusable id")
	}
	t := store.Tender{
		ID: uuid.New(), Method: in.GetMethod(), AmountMinor: in.GetAmount().GetMinor(),
		PaymentID: &paymentID, Reference: p.GetProviderReference(),
	}
	// Change exists in a drawer, not in a payment provider, which is why only
	// cash carries these.
	if in.GetTendered() != nil && in.GetTendered().GetMinor() > 0 {
		handed := in.GetTendered().GetMinor()
		change := handed - t.AmountMinor
		if change < 0 {
			return store.Tender{}, nil, status.Error(codes.InvalidArgument,
				"less was handed over than the payment is for")
		}
		t.TenderedMinor, t.ChangeMinor = &handed, &change
	}
	return t, nil, nil
}

// release gives back everything taken under one checkout.
//
// It works from what Payments holds rather than from what this service wrote,
// because the case it exists for is a checkout that was never written down: the
// customer walked away from the terminal, and the only record that anything
// happened is the payment itself.
//
// Pending payments are cancelled and captured ones refunded. They are not the
// same act: money that never moved is called off, and putting a refund against
// it would credit a debit that does not exist.
func (s *server) release(ctx context.Context, checkoutID uuid.UUID, reason string) (int, error) {
	resp, err := s.payments.ListPayments(ctx, &paymentspb.ListPaymentsRequest{
		ReferenceType: "order", ReferenceId: checkoutID.String(),
	})
	if err != nil {
		slog.Error("listing payments to release", "checkout", checkoutID, "err", err)
		return 0, status.Error(codes.Unavailable, "payments is not answering")
	}

	released := 0
	for _, p := range resp.GetPayments() {
		var err error
		switch p.GetStatus() {
		case paymentspb.PaymentStatus_PAYMENT_STATUS_PENDING:
			_, err = s.payments.Cancel(ctx, &paymentspb.CancelRequest{
				PaymentId: p.GetId(), Reason: reason,
			})
		case paymentspb.PaymentStatus_PAYMENT_STATUS_CAPTURED,
			paymentspb.PaymentStatus_PAYMENT_STATUS_AUTHORIZED:
			_, err = s.payments.Refund(ctx, &paymentspb.RefundRequest{
				PaymentId:      p.GetId(),
				IdempotencyKey: fmt.Sprintf("release-%s-%s", checkoutID, p.GetId()),
				Reason:         reason,
			})
		default:
			// Already failed, cancelled or refunded. Nothing owed.
			continue
		}
		if err != nil {
			slog.Error("could not release a payment for an abandoned checkout",
				"checkout", checkoutID, "payment", p.GetId(), "err", err,
				"action", "give this back by hand")
			continue
		}
		released++
	}
	return released, nil
}

// unwind gives back money taken for a sale that then failed to complete. It is
// the same path takePayments uses internally, exposed for the checks that run
// after the money is already in.
func (s *server) unwind(ctx context.Context, orderID uuid.UUID, tenders []store.Tender) {
	for _, t := range tenders {
		if t.PaymentID == nil {
			continue
		}
		if _, err := s.payments.Refund(ctx, &paymentspb.RefundRequest{
			PaymentId:      t.PaymentID.String(),
			IdempotencyKey: fmt.Sprintf("unwind-%s-%s", orderID, t.ID),
			Reason:         "the sale was not completed",
		}); err != nil {
			slog.Error("could not unwind a payment for an abandoned sale",
				"order", orderID, "payment", t.PaymentID, "err", err,
				"action", "refund this by hand")
		}
	}
}
