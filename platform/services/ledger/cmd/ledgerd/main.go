// Command ledgerd serves the Ledger service: the double-entry journal for this
// environment's single legal entity.
//
// One ledger per deployment, because one deployment is one market, one legal
// entity, one currency and one set of books. There is no consolidation here and
// no currency conversion, because the architecture put both on the other side
// of a VPS boundary.
//
// It listens rather than being called. The books are derived from what the
// operational services announced, which is what stops them being a second
// opinion about whether a sale happened. Post exists for the corrections an
// accountant makes by hand, and those are the ones that carry a person's name.
package main

import (
	"context"
	"errors"
	"flag"
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

	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	pb "github.com/twentyfour/platform/gen/go/twentyfour/ledger/v1"
	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/ledger/internal/chart"
	"github.com/twentyfour/platform/services/ledger/internal/store"
)

type server struct {
	pb.UnimplementedLedgerServiceServer
	st       *store.Store
	currency string
}

func fail(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "no such entry")
	case errors.Is(err, store.ErrUnbalanced):
		return status.Error(codes.InvalidArgument,
			"the lines of an entry have to sum to zero")
	case errors.Is(err, store.ErrEmpty):
		return status.Error(codes.InvalidArgument, "an entry with no lines records nothing")
	case errors.Is(err, store.ErrNoSuchAccount):
		// Rewritten rather than passed through: the store's error carries a
		// package prefix, and "store: no such account" is a sentence written
		// for the wrong reader.
		return status.Errorf(codes.InvalidArgument,
			"there is no account called %q in the chart", accountFrom(err))
	case errors.Is(err, store.ErrAlreadyReversed):
		return status.Error(codes.FailedPrecondition,
			"that entry has already been reversed")
	}
	slog.Error("ledger", "err", err)
	return status.Error(codes.Internal, "could not read or write the books")
}

// accountFrom pulls the code out of the store's error, so the message names
// the account that was wrong rather than making somebody re-read their request
// to find out which line it was.
func accountFrom(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 {
		return msg[i+2:]
	}
	return msg
}

func kindPB(k string) pb.AccountKind {
	switch chart.Kind(k) {
	case chart.Asset:
		return pb.AccountKind_ACCOUNT_KIND_ASSET
	case chart.Liability:
		return pb.AccountKind_ACCOUNT_KIND_LIABILITY
	case chart.Equity:
		return pb.AccountKind_ACCOUNT_KIND_EQUITY
	case chart.Revenue:
		return pb.AccountKind_ACCOUNT_KIND_REVENUE
	case chart.Expense:
		return pb.AccountKind_ACCOUNT_KIND_EXPENSE
	}
	return pb.AccountKind_ACCOUNT_KIND_UNSPECIFIED
}

func accountPB(a store.Account) *pb.Account {
	return &pb.Account{
		Code: a.Code, Name: a.Name, Kind: kindPB(a.Kind), Builtin: a.Builtin,
	}
}

func (s *server) money(minor int64) *commonpb.Money {
	return &commonpb.Money{Minor: minor, Currency: s.currency}
}

func moneyIn(currency string, minor int64) *commonpb.Money {
	return &commonpb.Money{Minor: minor, Currency: currency}
}

func entryPB(e store.Entry) *pb.Entry {
	out := &pb.Entry{
		Id: e.ID.String(), Kind: e.Kind,
		ReferenceType: e.ReferenceType, ReferenceId: e.ReferenceID,
		Memo: e.Memo, OccurredAt: timestamppb.New(e.OccurredAt),
		PostedAt: timestamppb.New(e.PostedAt),
	}
	if e.EventID != nil {
		out.EventId = e.EventID.String()
	}
	if e.ReversesID != nil {
		out.ReversesId = e.ReversesID.String()
	}
	if e.ReversedByID != nil {
		out.ReversedById = e.ReversedByID.String()
	}
	if e.PostedBy != nil {
		out.PostedBy = e.PostedBy.String()
	}
	for _, l := range e.Lines {
		out.Lines = append(out.Lines, &pb.Line{
			AccountCode: l.AccountCode, Amount: moneyIn(e.Currency, l.Minor), Memo: l.Memo,
		})
	}
	return out
}

func (s *server) Post(ctx context.Context, req *pb.PostRequest) (*pb.PostResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if len(req.GetLines()) == 0 {
		return nil, status.Error(codes.InvalidArgument, "an entry with no lines records nothing")
	}
	kind := strings.TrimSpace(req.GetKind())
	if kind == "" {
		kind = "manual"
	}

	e := store.Entry{
		TenantID: tenant, Kind: kind,
		ReferenceType: req.GetReferenceType(), ReferenceID: req.GetReferenceId(),
		Memo: req.GetMemo(), Currency: s.currency,
		IdempotencyKey: req.GetIdempotencyKey(),
	}
	if actor := tenantctx.User(ctx); actor != uuid.Nil {
		e.PostedBy = &actor
	}
	if t := req.GetOccurredAt(); t.IsValid() {
		e.OccurredAt = t.AsTime()
	}
	for _, l := range req.GetLines() {
		amount := l.GetAmount()
		if amount == nil {
			return nil, status.Error(codes.InvalidArgument, "every line needs an amount")
		}
		// One currency per deployment. A line in another one is not a
		// conversion problem to solve here, it is a line in the wrong books.
		if amount.GetCurrency() != "" && amount.GetCurrency() != s.currency {
			return nil, status.Errorf(codes.InvalidArgument,
				"these books are kept in %s", s.currency)
		}
		e.Lines = append(e.Lines, store.Line{
			AccountCode: l.GetAccountCode(), Minor: amount.GetMinor(), Memo: l.GetMemo(),
		})
	}
	if err := s.st.EnsureChart(ctx, tenant); err != nil {
		return nil, fail(err)
	}
	out, repeat, err := s.st.Post(ctx, e)
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("entry posted", "tenant", tenant, "entry", out.ID,
		"kind", out.Kind, "lines", len(out.Lines), "repeat", repeat)
	return &pb.PostResponse{Entry: entryPB(out)}, nil
}

func (s *server) Reverse(ctx context.Context, req *pb.ReverseRequest) (*pb.ReverseResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	out, err := s.st.Reverse(ctx, tenant, id, tenantctx.User(ctx), strings.TrimSpace(req.GetMemo()))
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("entry reversed", "tenant", tenant, "original", id, "reversal", out.ID)
	return &pb.ReverseResponse{Entry: entryPB(out)}, nil
}

func (s *server) GetEntry(ctx context.Context, req *pb.GetEntryRequest) (*pb.GetEntryResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	e, err := s.st.Entry(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetEntryResponse{Entry: entryPB(e)}, nil
}

func (s *server) ListEntries(ctx context.Context, req *pb.ListEntriesRequest) (*pb.ListEntriesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 200 {
		size = 50
	}
	f := store.Filter{
		Kind: req.GetKind(), ReferenceType: req.GetReferenceType(),
		ReferenceID: req.GetReferenceId(), Limit: size + 1,
	}
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
	list, err := s.st.ListEntries(ctx, tenant, f)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListEntriesResponse{}
	if len(list) > size {
		last := list[size-1]
		resp.NextPageToken = encodeToken(last.OccurredAt, last.ID)
		list = list[:size]
	}
	for _, e := range list {
		resp.Entries = append(resp.Entries, entryPB(e))
	}
	return resp, nil
}

func (s *server) ListAccounts(ctx context.Context, _ *pb.ListAccountsRequest) (*pb.ListAccountsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.st.EnsureChart(ctx, tenant); err != nil {
		return nil, fail(err)
	}
	list, err := s.st.ListAccounts(ctx, tenant)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListAccountsResponse{}
	for _, a := range list {
		resp.Accounts = append(resp.Accounts, accountPB(a))
	}
	return resp, nil
}

func (s *server) TrialBalance(ctx context.Context, req *pb.TrialBalanceRequest) (*pb.TrialBalanceResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	var from, to *time.Time
	if t := req.GetFrom(); t.IsValid() {
		at := t.AsTime()
		from = &at
	}
	if t := req.GetTo(); t.IsValid() {
		at := t.AsTime()
		to = &at
	}
	if err := s.st.EnsureChart(ctx, tenant); err != nil {
		return nil, fail(err)
	}
	balances, currency, err := s.st.TrialBalance(ctx, tenant, from, to)
	if err != nil {
		return nil, fail(err)
	}
	if currency == "" {
		// No entries yet. The books are still in this deployment's currency,
		// and a report labelled with nothing is a report nobody can read.
		currency = s.currency
	}

	resp := &pb.TrialBalanceResponse{}
	var debits, credits int64
	for _, b := range balances {
		// The two columns, from the one signed total. Exactly one of them is
		// non-zero for any account, which is what a trial balance is.
		var debit, credit int64
		if b.DebitMinor > 0 {
			debit = b.DebitMinor
		} else {
			credit = -b.DebitMinor
		}
		debits += debit
		credits += credit

		// The balance as the account is normally read: revenue earned reads
		// positive, cash held reads positive. The only presentation this
		// service applies to a figure.
		natural := b.DebitMinor
		if !chart.Kind(b.Account.Kind).DebitPositive() {
			natural = -natural
		}
		resp.Balances = append(resp.Balances, &pb.Balance{
			Account: accountPB(b.Account),
			Balance: moneyIn(currency, natural),
			Debit:   moneyIn(currency, debit),
			Credit:  moneyIn(currency, credit),
		})
	}
	resp.TotalDebits = moneyIn(currency, debits)
	resp.TotalCredits = moneyIn(currency, credits)
	// Stated rather than left to the reader. A trial balance that silently does
	// not balance is the failure this whole service is arranged to prevent, and
	// the arrangement is only worth anything if somebody is told when it fails.
	resp.Balanced = debits == credits
	if !resp.Balanced {
		slog.Error("the trial balance does not balance",
			"tenant", tenant, "debits", debits, "credits", credits)
	}
	return resp, nil
}

func (s *server) AccountLedger(ctx context.Context, req *pb.AccountLedgerRequest) (*pb.AccountLedgerResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if req.GetAccountCode() == "" {
		return nil, status.Error(codes.InvalidArgument, "which account?")
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 1000 {
		size = 200
	}
	var from, to *time.Time
	if t := req.GetFrom(); t.IsValid() {
		at := t.AsTime()
		from = &at
	}
	if t := req.GetTo(); t.IsValid() {
		at := t.AsTime()
		to = &at
	}
	account, opening, lines, err := s.st.AccountLedger(ctx, tenant, req.GetAccountCode(), from, to, size)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.AccountLedgerResponse{
		Account:        accountPB(account),
		OpeningBalance: s.money(opening),
		ClosingBalance: s.money(opening),
	}
	for _, l := range lines {
		resp.Lines = append(resp.Lines, &pb.PostedLine{
			EntryId: l.EntryID.String(), Kind: l.Kind, Memo: l.Memo,
			ReferenceType: l.ReferenceType, ReferenceId: l.ReferenceID,
			Amount: s.money(l.Minor), RunningBalance: s.money(l.RunningMinor),
			OccurredAt: timestamppb.New(l.OccurredAt),
		})
		resp.ClosingBalance = s.money(l.RunningMinor)
	}
	return resp, nil
}

func main() {
	addr := flag.String("addr", ":9118", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	brokers := flag.String("brokers", "kafka:9092", "comma separated Kafka brokers")
	currency := flag.String("currency", "HUF", "this market's currency; one set of books, one currency")
	level := flag.String("log-level", "info", "debug, info, warn or error")
	flag.Parse()

	grpcx.SetupLogging(*level)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

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

	// Only the topics that produce entries, named rather than matched. Audit
	// subscribes to everything because a trail with holes is worthless; the
	// books are the opposite case, where reading an event that produces nothing
	// is pure cost.
	bookkeeper := &bookkeeper{st: st, currency: *currency}
	consumer, err := bus.NewConsumer(strings.Split(*brokers, ","), "ledger",
		[]string{"order.placed", "order.voided", "payment.refunded"}, bookkeeper.handle)
	if err != nil {
		slog.Error("join the bus", "err", err)
		os.Exit(1)
	}
	defer consumer.Close()
	go func() {
		if err := consumer.Run(ctx); err != nil {
			slog.Error("consume", "err", err)
		}
	}()

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterLedgerServiceServer(srv, &server{st: st, currency: *currency})

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		cancel()
		srv.GracefulStop()
	}()

	if err := grpcx.Run(srv, *addr, "ledger"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
