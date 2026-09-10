// Command invoicingd serves Invoicing & Billing: fiscal documents for the
// merchant's customers, and the merchant's own subscription charges.
//
// One service, not two. Both issue a document under a market's rules; both need
// numbering, layout, mandatory fields and local tax treatment; the only real
// difference is who the document is addressed to. Two services would have meant
// two implementations of the same numbering machinery in every market.
//
// This pod is swapped per market, and it is the only place in the codebase
// where a rule about one country may live. Nothing upstream can tell which
// implementation is behind it: POS asks for a document and gets one.
//
// The two constraints that shape everything here. A number is gapless, which
// means it is allocated inside the transaction that commits the document. And
// an issued document is immutable, so a correction is a credit note referencing
// the original, never an edit.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	authpb "github.com/twentyfour/platform/gen/go/twentyfour/auth/v1"
	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/invoicing/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/invoicing/internal/numbering"
	"github.com/twentyfour/platform/services/invoicing/internal/render"
	"github.com/twentyfour/platform/services/invoicing/internal/store"
)

type server struct {
	pb.UnimplementedInvoicingServiceServer
	st       *store.Store
	auth     authpb.AuthServiceClient
	tenant   tenantpb.TenantServiceClient
	currency string
	// What each tier costs in this market, in minor units. Prices are a
	// Registry value and not yet set, so these are placeholders carried in one
	// flag rather than scattered through the code.
	prices map[string]int64
}

func fail(err error) error {
	// An error that already carries a status came from a check that wrote its
	// own sentence for a merchant. Wrapping it here would replace "this
	// business has no profile yet" with "something went wrong", which is the
	// difference between a person knowing what to do and filing a ticket.
	if _, ok := status.FromError(err); ok && status.Code(err) != codes.Unknown {
		return err
	}
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "no such document")
	case errors.Is(err, store.ErrAlreadyCorrected):
		return status.Error(codes.FailedPrecondition,
			"that document has already been corrected")
	}
	slog.Error("invoicing", "err", err)
	return status.Error(codes.Internal, "could not read or write documents")
}

func kindName(k pb.DocumentKind) string {
	switch k {
	case pb.DocumentKind_DOCUMENT_KIND_INVOICE:
		return "invoice"
	case pb.DocumentKind_DOCUMENT_KIND_RECEIPT:
		return "receipt"
	case pb.DocumentKind_DOCUMENT_KIND_CREDIT_NOTE:
		return "credit_note"
	case pb.DocumentKind_DOCUMENT_KIND_SUBSCRIPTION_INVOICE:
		return "subscription_invoice"
	}
	return ""
}

func kindPB(s string) pb.DocumentKind {
	switch s {
	case "invoice":
		return pb.DocumentKind_DOCUMENT_KIND_INVOICE
	case "receipt":
		return pb.DocumentKind_DOCUMENT_KIND_RECEIPT
	case "credit_note":
		return pb.DocumentKind_DOCUMENT_KIND_CREDIT_NOTE
	case "subscription_invoice":
		return pb.DocumentKind_DOCUMENT_KIND_SUBSCRIPTION_INVOICE
	}
	return pb.DocumentKind_DOCUMENT_KIND_UNSPECIFIED
}

func reportingPB(s string) pb.ReportingStatus {
	switch s {
	case "not_required":
		return pb.ReportingStatus_REPORTING_STATUS_NOT_REQUIRED
	case "queued":
		return pb.ReportingStatus_REPORTING_STATUS_QUEUED
	case "reported":
		return pb.ReportingStatus_REPORTING_STATUS_REPORTED
	case "retrying":
		return pb.ReportingStatus_REPORTING_STATUS_RETRYING
	case "failed":
		return pb.ReportingStatus_REPORTING_STATUS_FAILED
	}
	return pb.ReportingStatus_REPORTING_STATUS_UNSPECIFIED
}

func (s *server) money(minor int64) *commonpb.Money {
	return &commonpb.Money{Minor: minor, Currency: s.currency}
}

func documentPB(d store.Document) *pb.Document {
	money := func(minor int64) *commonpb.Money {
		return &commonpb.Money{Minor: minor, Currency: d.Currency}
	}
	out := &pb.Document{
		Id: d.ID.String(), Number: d.Number, Kind: kindPB(d.Kind),
		OrderId: d.OrderID, CustomerName: d.CustomerName,
		CustomerAddress: d.CustomerAddress, CustomerTaxId: d.CustomerTaxID,
		Net: money(d.NetMinor), Tax: money(d.TaxMinor), Gross: money(d.GrossMinor),
		ReportingStatus:    reportingPB(d.ReportingStatus),
		ReportingReference: d.ReportingRef,
		IssuedAt:           timestamppb.New(d.IssuedAt),
	}
	if d.CorrectsID != nil {
		out.CorrectsId = d.CorrectsID.String()
	}
	if d.CorrectedByID != nil {
		out.CorrectedById = d.CorrectedByID.String()
	}
	if d.DueAt != nil {
		out.DueAt = timestamppb.New(*d.DueAt)
	}
	for _, l := range d.Lines {
		out.Lines = append(out.Lines, &pb.DocumentLine{
			Description: l.Description, Quantity: l.Quantity,
			UnitPrice: money(l.UnitPriceMinor), Net: money(l.NetMinor),
			Tax: money(l.TaxMinor), Gross: money(l.GrossMinor),
			TaxRate: &commonpb.TaxRate{BasisPoints: l.TaxBasisPoints},
		})
	}
	return out
}

// merchantCode asks Auth, which owns it.
//
// Through the RPC rather than the column, deliberately: Tenant & Business
// Profile will own this eventually, and a caller reading Auth's table would be
// a caller that breaks on the day it moves. This is the same call it will make
// afterwards.
func (s *server) merchantCode(ctx context.Context, tenantID uuid.UUID) (string, error) {
	resp, err := s.auth.GetMerchantCode(ctx, &authpb.GetMerchantCodeRequest{
		TenantId: tenantID.String(),
	})
	if err != nil {
		return "", err
	}
	return resp.GetMerchantCode(), nil
}

// business is the "from" block on the document.
//
// Read at issue and stored in the artifact, because a business that renames
// itself has not renamed the documents it already issued.
//
// The two failures are told apart, and they are genuinely different. Tenant
// being unreachable is a third party being down, and the rule is that a third
// party being down must never block a sale: the document is issued with what is
// known and the gap is logged. A profile that does not exist is not an outage,
// it is a business that was never set up, and a document with no issuer on the
// face of it is not a document. That one is refused, because an issued document
// is immutable and cannot be withdrawn once a customer has it.
func (s *server) business(ctx context.Context) (name, address string, err error) {
	resp, gerr := s.tenant.GetProfile(ctx, &tenantpb.GetProfileRequest{})
	if gerr == nil {
		p := resp.GetProfile()
		return p.GetName(), p.GetAddress(), nil
	}
	if status.Code(gerr) == codes.NotFound {
		return "", "", status.Error(codes.FailedPrecondition,
			"this business has no profile yet, so nothing can say who issued the document")
	}
	slog.Error("could not read the business profile for a document", "err", gerr)
	return "", "", nil
}

func (s *server) Issue(ctx context.Context, req *pb.IssueRequest) (*pb.IssueResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	kind := kindName(req.GetKind())
	if kind == "" {
		return nil, status.Error(codes.InvalidArgument, "say what kind of document this is")
	}
	if kind == "credit_note" {
		// A credit note is issued by Correct, which knows what it is
		// correcting. One issued here would be a credit note against nothing.
		return nil, status.Error(codes.InvalidArgument,
			"a credit note corrects a document; issue it through Correct")
	}
	if len(req.GetLines()) == 0 {
		return nil, status.Error(codes.InvalidArgument, "a document with no lines records nothing")
	}

	code, err := s.merchantCode(ctx, tenant)
	if err != nil {
		slog.Error("merchant code", "err", err, "tenant", tenant)
		return nil, status.Error(codes.Unavailable,
			"we could not reach the service that assigns document numbers")
	}

	doc, err := s.build(ctx, tenant, kind, code, req.GetLines(), documentParty{
		OrderID: req.GetOrderId(), Name: req.GetCustomerName(),
		Address: req.GetCustomerAddress(), TaxID: req.GetCustomerTaxId(),
	}, req.GetIdempotencyKey(), req.GetDueAt())
	if err != nil {
		return nil, err
	}
	out, repeat, err := s.issue(ctx, doc, code, nil, "")
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("document issued", "tenant", tenant, "number", out.Number,
		"kind", out.Kind, "repeat", repeat)
	return &pb.IssueResponse{Document: documentPB(out)}, nil
}

type documentParty struct {
	OrderID string
	Name    string
	Address string
	TaxID   string
}

// build turns request lines into a document, checking the arithmetic.
//
// The totals are recomputed from the lines rather than taken from the caller.
// A document whose total does not match its lines is a document an auditor
// will ask about, and the caller is not the place to catch that.
func (s *server) build(ctx context.Context, tenant uuid.UUID, kind, code string,
	lines []*pb.DocumentLine, party documentParty, idem string,
	due *timestamppb.Timestamp) (store.Document, error) {
	d := store.Document{
		TenantID: tenant, Kind: kind, Currency: s.currency,
		OrderID: party.OrderID, CustomerName: party.Name,
		CustomerAddress: party.Address, CustomerTaxID: party.TaxID,
		ArtifactType: "text/plain; charset=utf-8",
		// Nothing to report anywhere yet. When a market's implementation grows
		// a reporting integration, this is the field it moves through, and the
		// merchant plane still never learns which authority it talks to.
		ReportingStatus: "not_required",
		IdempotencyKey:  idem,
	}
	if due.IsValid() {
		at := due.AsTime()
		d.DueAt = &at
	}
	for _, l := range lines {
		if l.GetQuantity() == 0 {
			return store.Document{}, status.Error(codes.InvalidArgument,
				"a line for nothing is not a line")
		}
		for _, m := range []*commonpb.Money{l.GetNet(), l.GetTax(), l.GetGross()} {
			if m.GetCurrency() != "" && m.GetCurrency() != s.currency {
				return store.Document{}, status.Errorf(codes.InvalidArgument,
					"documents in this market are issued in %s", s.currency)
			}
		}
		net, tax, gross := l.GetNet().GetMinor(), l.GetTax().GetMinor(), l.GetGross().GetMinor()
		if gross == 0 {
			gross = net + tax
		}
		if net+tax != gross {
			return store.Document{}, status.Errorf(codes.InvalidArgument,
				"the line %q does not add up: %d and %d are not %d",
				l.GetDescription(), net, tax, gross)
		}
		d.Lines = append(d.Lines, store.Line{
			Description: l.GetDescription(), Quantity: l.GetQuantity(),
			UnitPriceMinor: l.GetUnitPrice().GetMinor(),
			NetMinor:       net, TaxMinor: tax, GrossMinor: gross,
			TaxBasisPoints: l.GetTaxRate().GetBasisPoints(),
		})
		d.NetMinor += net
		d.TaxMinor += tax
		d.GrossMinor += gross
	}
	return d, nil
}

// issue allocates the number, renders the artifact with the number on it, and
// commits all of it together.
func (s *server) issue(ctx context.Context, d store.Document, code string,
	corrects *store.Document, reason string) (store.Document, bool, error) {
	name, address, err := s.business(ctx)
	if err != nil {
		return store.Document{}, false, err
	}
	if corrects != nil {
		d.CorrectsID = &corrects.ID
	}
	return s.st.Issue(ctx, d, func(year int, sequence int64) (string, []byte, error) {
		number, err := numbering.Format(year, code, sequence)
		if err != nil {
			return "", nil, status.Error(codes.FailedPrecondition, err.Error())
		}
		doc := render.Document{
			Number: number, Kind: d.Kind, IssuedAt: time.Now(), DueAt: d.DueAt,
			BusinessName: name, BusinessAddress: address, MerchantCode: code,
			CustomerName: d.CustomerName, CustomerAddress: d.CustomerAddress,
			CustomerTaxID: d.CustomerTaxID,
			Net:           render.Money{Minor: d.NetMinor, Currency: d.Currency},
			Tax:           render.Money{Minor: d.TaxMinor, Currency: d.Currency},
			Gross:         render.Money{Minor: d.GrossMinor, Currency: d.Currency},
			Reason:        reason,
		}
		if corrects != nil {
			doc.Corrects = corrects.Number
		}
		for _, l := range d.Lines {
			doc.Lines = append(doc.Lines, render.Line{
				Description: l.Description, Quantity: l.Quantity,
				UnitPrice: render.Money{Minor: l.UnitPriceMinor, Currency: d.Currency},
				Net:       render.Money{Minor: l.NetMinor, Currency: d.Currency},
				Tax:       render.Money{Minor: l.TaxMinor, Currency: d.Currency},
				Gross:     render.Money{Minor: l.GrossMinor, Currency: d.Currency},
				TaxBasis:  l.TaxBasisPoints,
			})
		}
		return number, render.Text(doc), nil
	})
}

func (s *server) Correct(ctx context.Context, req *pb.CorrectRequest) (*pb.CorrectResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	original, err := s.st.Correcting(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	if original.Kind == "credit_note" {
		return nil, status.Error(codes.FailedPrecondition,
			"a credit note is itself a correction; issue a new invoice instead")
	}
	reason := strings.TrimSpace(req.GetReason())
	if reason == "" {
		return nil, status.Error(codes.InvalidArgument,
			"a correction has to say what it is correcting and why")
	}

	code, err := s.merchantCode(ctx, tenant)
	if err != nil {
		return nil, status.Error(codes.Unavailable,
			"we could not reach the service that assigns document numbers")
	}

	// A whole-document credit note is the original's lines with the sign
	// flipped. A partial one is whatever the caller supplied, which is what a
	// partial return needs.
	note := store.Document{
		TenantID: tenant, Kind: "credit_note", Currency: original.Currency,
		OrderID: original.OrderID, CustomerName: original.CustomerName,
		CustomerAddress: original.CustomerAddress, CustomerTaxID: original.CustomerTaxID,
		ArtifactType: "text/plain; charset=utf-8", ReportingStatus: "not_required",
	}
	if len(req.GetLines()) > 0 {
		built, err := s.build(ctx, tenant, "credit_note", code, req.GetLines(),
			documentParty{
				OrderID: original.OrderID, Name: original.CustomerName,
				Address: original.CustomerAddress, TaxID: original.CustomerTaxID,
			}, "", nil)
		if err != nil {
			return nil, err
		}
		note.Lines, note.NetMinor, note.TaxMinor, note.GrossMinor =
			built.Lines, built.NetMinor, built.TaxMinor, built.GrossMinor
		// A credit for more than the document credits money that was never
		// taken.
		if note.GrossMinor > original.GrossMinor {
			return nil, status.Error(codes.InvalidArgument,
				"a credit note cannot be for more than the document it corrects")
		}
	} else {
		for _, l := range original.Lines {
			note.Lines = append(note.Lines, store.Line{
				Description: l.Description, Quantity: -l.Quantity,
				UnitPriceMinor: l.UnitPriceMinor,
				NetMinor:       -l.NetMinor, TaxMinor: -l.TaxMinor, GrossMinor: -l.GrossMinor,
				TaxBasisPoints: l.TaxBasisPoints,
			})
		}
		note.NetMinor = -original.NetMinor
		note.TaxMinor = -original.TaxMinor
		note.GrossMinor = -original.GrossMinor
	}

	out, _, err := s.issue(ctx, note, code, &original, reason)
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("document corrected", "tenant", tenant,
		"original", original.Number, "credit_note", out.Number)
	return &pb.CorrectResponse{CreditNote: documentPB(out)}, nil
}

func (s *server) GetDocument(ctx context.Context, req *pb.GetDocumentRequest) (*pb.GetDocumentResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	d, err := s.st.Document(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetDocumentResponse{Document: documentPB(d)}, nil
}

func (s *server) ListDocuments(ctx context.Context, req *pb.ListDocumentsRequest) (*pb.ListDocumentsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 200 {
		size = 50
	}
	f := store.Filter{Kind: kindName(req.GetKind()), OrderID: req.GetOrderId(), Limit: size + 1}
	if t := req.GetFrom(); t.IsValid() {
		at := t.AsTime()
		f.From = &at
	}
	if t := req.GetTo(); t.IsValid() {
		at := t.AsTime()
		f.To = &at
	}
	if tok := req.GetPageToken(); tok != "" {
		at, id, err := decodeToken(tok)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "that page token is not one of ours")
		}
		f.BeforeAt, f.BeforeID = &at, &id
	}
	list, err := s.st.List(ctx, tenant, f)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListDocumentsResponse{}
	if len(list) > size {
		last := list[size-1]
		resp.NextPageToken = encodeToken(last.IssuedAt, last.ID)
		list = list[:size]
	}
	for _, d := range list {
		resp.Documents = append(resp.Documents, documentPB(d))
	}
	return resp, nil
}

func (s *server) RenderDocument(ctx context.Context, req *pb.RenderDocumentRequest) (*pb.RenderDocumentResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	body, contentType, number, err := s.st.Artifact(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.RenderDocumentResponse{
		Body: body, ContentType: contentType, Filename: number + ".txt",
	}, nil
}

func periodName(p pb.BillingPeriod) string {
	if p == pb.BillingPeriod_BILLING_PERIOD_ANNUAL {
		return "annual"
	}
	return "monthly"
}

func periodPB(s string) pb.BillingPeriod {
	if s == "annual" {
		return pb.BillingPeriod_BILLING_PERIOD_ANNUAL
	}
	return pb.BillingPeriod_BILLING_PERIOD_MONTHLY
}

func subStatusPB(s string) pb.SubscriptionStatus {
	switch s {
	case "active":
		return pb.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE
	case "past_due":
		return pb.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE
	case "cancelled":
		return pb.SubscriptionStatus_SUBSCRIPTION_STATUS_CANCELLED
	}
	return pb.SubscriptionStatus_SUBSCRIPTION_STATUS_UNSPECIFIED
}

func subscriptionPB(s store.Subscription) *pb.Subscription {
	out := &pb.Subscription{
		Tier: s.Tier, Status: subStatusPB(s.Status), Period: periodPB(s.Period),
		Amount:             &commonpb.Money{Minor: s.AmountMinor, Currency: s.Currency},
		CurrentPeriodStart: timestamppb.New(s.PeriodStart),
		RenewsAt:           timestamppb.New(s.RenewsAt),
	}
	if s.CancelsAt != nil {
		out.CancelsAt = timestamppb.New(*s.CancelsAt)
	}
	return out
}

// price is what a tier costs in this market.
//
// Prices are a Registry value and are not set: these are placeholders, carried
// in one flag rather than scattered through the code, so the day they are
// decided is a configuration change.
func (s *server) price(tier, period string) int64 {
	monthly := s.prices[strings.ToLower(tier)]
	if period == "annual" {
		// Twelve months less the advertised annual discount, which the
		// marketing site also states. Two statements of one number, and this
		// is the one that takes money.
		return monthly * 12 * 80 / 100
	}
	return monthly
}

func (s *server) currentTier(ctx context.Context) string {
	resp, err := s.tenant.GetEntitlement(ctx, &tenantpb.GetEntitlementRequest{})
	if err != nil {
		slog.Warn("could not read the tier", "err", err)
		return ""
	}
	return resp.GetEntitlement().GetTier()
}

func (s *server) GetSubscription(ctx context.Context, _ *pb.GetSubscriptionRequest) (*pb.GetSubscriptionResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	sub, err := s.st.Subscription(ctx, tenant)
	if errors.Is(err, store.ErrNotFound) {
		// Created on first read from the tier the entitlement record already
		// carries, so a tenant provisioned before this service existed has a
		// subscription without a backfill.
		tier := s.currentTier(ctx)
		if tier == "" {
			tier = "starter"
		}
		sub, err = s.st.EnsureSubscription(ctx, store.Subscription{
			TenantID: tenant, Tier: tier, Period: "monthly",
			AmountMinor: s.price(tier, "monthly"), Currency: s.currency,
			RenewsAt: time.Now().AddDate(0, 1, 0),
		})
	}
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetSubscriptionResponse{Subscription: subscriptionPB(sub)}, nil
}

func (s *server) ChangeSubscription(ctx context.Context, req *pb.ChangeSubscriptionRequest) (*pb.ChangeSubscriptionResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	// Make sure there is one to change.
	if _, err := s.GetSubscription(ctx, &pb.GetSubscriptionRequest{}); err != nil {
		return nil, err
	}
	current, err := s.st.Subscription(ctx, tenant)
	if err != nil {
		return nil, fail(err)
	}

	tier := strings.ToLower(strings.TrimSpace(req.GetTier()))
	if tier == "" {
		tier = current.Tier
	}
	if _, known := s.prices[tier]; !known {
		return nil, status.Errorf(codes.InvalidArgument, "there is no %q tier", tier)
	}
	period := periodName(req.GetPeriod())
	if req.GetPeriod() == pb.BillingPeriod_BILLING_PERIOD_UNSPECIFIED {
		period = current.Period
	}

	out, err := s.st.ChangeSubscription(ctx, tenant, tier, period,
		s.price(tier, period), req.GetCancel())
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("subscription changed", "tenant", tenant, "tier", out.Tier,
		"period", out.Period, "cancelling", req.GetCancel())
	return &pb.ChangeSubscriptionResponse{Subscription: subscriptionPB(out)}, nil
}

func (s *server) RunBillingCycle(ctx context.Context, req *pb.RunBillingCycleRequest) (*pb.RunBillingCycleResponse, error) {
	// The admin plane, or the scheduler acting for it. A merchant running their
	// own billing cycle is a merchant choosing when to be charged.
	if err := tenantctx.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	through := time.Now()
	if t := req.GetThrough(); t.IsValid() {
		through = t.AsTime()
	}
	due, err := s.st.DueForBilling(ctx, through, 500)
	if err != nil {
		return nil, fail(err)
	}

	resp := &pb.RunBillingCycleResponse{}
	for _, sub := range due {
		if sub.AmountMinor == 0 {
			// Nothing to charge, so no document. An invoice for zero is a
			// document a merchant has to read and a number burnt out of a
			// gapless sequence.
			resp.Skipped++
			if err := s.st.AdvancePeriod(ctx, sub.TenantID, nextRenewal(sub)); err != nil {
				slog.Error("advance period", "err", err, "tenant", sub.TenantID)
			}
			continue
		}
		doc, err := s.billOne(ctx, sub)
		if err != nil {
			// One tenant's billing failing must not stop the rest of the run.
			slog.Error("could not bill a tenant", "err", err, "tenant", sub.TenantID)
			resp.Skipped++
			continue
		}
		resp.Invoices = append(resp.Invoices, documentPB(doc))
	}
	slog.Info("billing cycle run", "through", through,
		"issued", len(resp.Invoices), "skipped", resp.Skipped)
	return resp, nil
}

// capitalise puts a tier name on a document. strings.Title is deprecated and
// does the wrong thing outside ASCII; a tier name is one word from a fixed set,
// so this is the whole of what is needed.
func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func nextRenewal(sub store.Subscription) time.Time {
	if sub.Period == "annual" {
		return sub.RenewsAt.AddDate(1, 0, 0)
	}
	return sub.RenewsAt.AddDate(0, 1, 0)
}

// billOne issues the tenant's own invoice.
//
// It runs as that tenant, because the numbering counter, the merchant code and
// the document all belong to them: a subscription invoice is numbered in the
// same gapless sequence as their customer invoices, which is what "one
// numbering machinery" means in practice.
func (s *server) billOne(ctx context.Context, sub store.Subscription) (store.Document, error) {
	as := tenantctx.Outbound(ctx, tenantctx.Identity{
		TenantID: sub.TenantID, Plane: tenantctx.PlaneTenant,
	})
	code, err := s.merchantCode(as, sub.TenantID)
	if err != nil {
		return store.Document{}, err
	}

	period := "month"
	if sub.Period == "annual" {
		period = "year"
	}
	description := fmt.Sprintf("TwentyFour %s, one %s from %s",
		capitalise(sub.Tier), period, sub.RenewsAt.UTC().Format("2 January 2006"))

	d := store.Document{
		TenantID: sub.TenantID, Kind: "subscription_invoice", Currency: sub.Currency,
		CustomerName: "", ArtifactType: "text/plain; charset=utf-8",
		ReportingStatus: "not_required",
		// One invoice per tenant per period. Re-running a failed cycle must not
		// charge twice, and the period start is what makes the key stable.
		IdempotencyKey: "billing:" + sub.RenewsAt.UTC().Format("2006-01-02"),
		Lines: []store.Line{{
			Description: description, Quantity: 1,
			UnitPriceMinor: sub.AmountMinor,
			// Tax on the platform's own invoice is this market's business and
			// is not modelled yet. Recorded as zero rather than guessed, which
			// is the same choice the analytics projection makes about a cost
			// nobody entered: an absent figure is better than an invented one.
			NetMinor: sub.AmountMinor, TaxMinor: 0, GrossMinor: sub.AmountMinor,
		}},
		NetMinor: sub.AmountMinor, GrossMinor: sub.AmountMinor,
	}
	out, _, err := s.issue(as, d, code, nil, "")
	if err != nil {
		return store.Document{}, err
	}
	if err := s.st.AdvancePeriod(ctx, sub.TenantID, nextRenewal(sub)); err != nil {
		return out, err
	}
	return out, nil
}

func main() {
	addr := flag.String("addr", ":9119", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	authAddr := flag.String("auth", "auth:9102", "Auth service address, for the merchant code")
	tenantAddr := flag.String("tenant", "tenant:9109", "Tenant service address")
	currency := flag.String("currency", "HUF", "this market's currency")
	prices := flag.String("prices", "starter=8900,growth=18900,max=34900,enterprise=0",
		"monthly price per tier in minor units; Registry values, not final")
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

	table := map[string]int64{}
	for _, pair := range strings.Split(*prices, ",") {
		name, amount, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if !ok {
			continue
		}
		var minor int64
		if _, err := fmt.Sscanf(amount, "%d", &minor); err != nil {
			slog.Error("price is not a number of minor units", "tier", name, "value", amount)
			os.Exit(1)
		}
		table[strings.ToLower(name)] = minor
	}

	authConn, err := grpcx.Dial(*authAddr)
	if err != nil {
		slog.Error("dial auth", "err", err)
		os.Exit(1)
	}
	defer authConn.Close()
	tenantConn, err := grpcx.Dial(*tenantAddr)
	if err != nil {
		slog.Error("dial tenant", "err", err)
		os.Exit(1)
	}
	defer tenantConn.Close()

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterInvoicingServiceServer(srv, &server{
		st: st, auth: authpb.NewAuthServiceClient(authConn),
		tenant:   tenantpb.NewTenantServiceClient(tenantConn),
		currency: *currency, prices: table,
	})

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		srv.GracefulStop()
	}()

	if err := grpcx.Run(srv, *addr, "invoicing"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
