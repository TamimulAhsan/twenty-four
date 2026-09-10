package main

import (
	"net/http"
	"time"

	ledgerpb "github.com/twentyfour/platform/gen/go/twentyfour/ledger/v1"
	"github.com/twentyfour/platform/packages/httpx"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// The books.
//
// Read-only through this gateway. Posting an entry by hand is an accountant's
// act on the admin plane with a name attached to it, and exposing it on the
// merchant API would make the books writable by anyone who can reach a
// dashboard.
func (g *gateway) registerLedger(mux *http.ServeMux) {
	mux.Handle("GET /api/ledger/accounts", g.authenticated(g.ledgerAccounts))
	mux.Handle("GET /api/ledger/entries", g.authenticated(g.ledgerEntries))
	mux.Handle("GET /api/ledger/trial-balance", g.authenticated(g.trialBalance))
	mux.Handle("GET /api/ledger/accounts/{code}", g.authenticated(g.accountLedger))
}

var accountKindNames = map[ledgerpb.AccountKind]string{
	ledgerpb.AccountKind_ACCOUNT_KIND_ASSET:     "asset",
	ledgerpb.AccountKind_ACCOUNT_KIND_LIABILITY: "liability",
	ledgerpb.AccountKind_ACCOUNT_KIND_EQUITY:    "equity",
	ledgerpb.AccountKind_ACCOUNT_KIND_REVENUE:   "revenue",
	ledgerpb.AccountKind_ACCOUNT_KIND_EXPENSE:   "expense",
}

func accountJSON(a *ledgerpb.Account) map[string]any {
	return map[string]any{
		"code": a.GetCode(), "name": a.GetName(),
		"kind": accountKindNames[a.GetKind()], "builtin": a.GetBuiltin(),
	}
}

func (g *gateway) ledgerAccounts(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "ledger:journal:read") {
		return
	}
	resp, err := g.ledger.ListAccounts(g.downstream(r, c), &ledgerpb.ListAccountsRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetAccounts()))
	for _, a := range resp.GetAccounts() {
		out = append(out, accountJSON(a))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) ledgerEntries(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "ledger:journal:read") {
		return
	}
	q := r.URL.Query()
	req := &ledgerpb.ListEntriesRequest{
		Kind: q.Get("kind"), ReferenceType: q.Get("referenceType"),
		ReferenceId: q.Get("referenceId"), PageToken: q.Get("pageToken"),
	}
	if from, ok := parseDay(q.Get("from")); ok {
		req.From = timestamppb.New(from)
	}
	if to, ok := parseDay(q.Get("to")); ok {
		// Exclusive at the far end, and the query parameter is a day, so the
		// caller asking for the 9th gets the whole of the 9th.
		req.To = timestamppb.New(to.AddDate(0, 0, 1))
	}
	resp, err := g.ledger.ListEntries(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetEntries()))
	for _, e := range resp.GetEntries() {
		lines := make([]map[string]any, 0, len(e.GetLines()))
		for _, l := range e.GetLines() {
			lines = append(lines, map[string]any{
				"account": l.GetAccountCode(),
				"amount":  moneyJSON(l.GetAmount()),
				"memo":    l.GetMemo(),
			})
		}
		out = append(out, map[string]any{
			"id": e.GetId(), "kind": e.GetKind(), "memo": e.GetMemo(),
			"referenceType": e.GetReferenceType(), "referenceId": e.GetReferenceId(),
			"reversesId": e.GetReversesId(), "reversedById": e.GetReversedById(),
			"lines": lines, "occurredAt": e.GetOccurredAt().AsTime(),
		})
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"entries": out, "nextPageToken": resp.GetNextPageToken(),
	})
}

func (g *gateway) trialBalance(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "ledger:report:read") {
		return
	}
	q := r.URL.Query()
	req := &ledgerpb.TrialBalanceRequest{}
	if from, ok := parseDay(q.Get("from")); ok {
		req.From = timestamppb.New(from)
	}
	if to, ok := parseDay(q.Get("to")); ok {
		req.To = timestamppb.New(to.AddDate(0, 0, 1))
	}
	resp, err := g.ledger.TrialBalance(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	rows := make([]map[string]any, 0, len(resp.GetBalances()))
	for _, b := range resp.GetBalances() {
		rows = append(rows, map[string]any{
			"account": accountJSON(b.GetAccount()),
			"balance": moneyJSON(b.GetBalance()),
			"debit":   moneyJSON(b.GetDebit()),
			"credit":  moneyJSON(b.GetCredit()),
		})
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"rows":         rows,
		"totalDebits":  moneyJSON(resp.GetTotalDebits()),
		"totalCredits": moneyJSON(resp.GetTotalCredits()),
		// Passed through rather than recomputed here. If the books do not
		// balance the screen has to say so, and a gateway that quietly worked
		// it out for itself would be a second opinion.
		"balanced": resp.GetBalanced(),
	})
}

func (g *gateway) accountLedger(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "ledger:journal:read") {
		return
	}
	q := r.URL.Query()
	req := &ledgerpb.AccountLedgerRequest{AccountCode: r.PathValue("code")}
	if from, ok := parseDay(q.Get("from")); ok {
		req.From = timestamppb.New(from)
	}
	if to, ok := parseDay(q.Get("to")); ok {
		req.To = timestamppb.New(to.AddDate(0, 0, 1))
	}
	resp, err := g.ledger.AccountLedger(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	lines := make([]map[string]any, 0, len(resp.GetLines()))
	for _, l := range resp.GetLines() {
		lines = append(lines, map[string]any{
			"entryId": l.GetEntryId(), "kind": l.GetKind(), "memo": l.GetMemo(),
			"referenceType": l.GetReferenceType(), "referenceId": l.GetReferenceId(),
			"amount": moneyJSON(l.GetAmount()),
			// The balance after this line, so a statement reads the way a bank
			// statement does rather than needing to be added up.
			"runningBalance": moneyJSON(l.GetRunningBalance()),
			"occurredAt":     l.GetOccurredAt().AsTime(),
		})
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"account":        accountJSON(resp.GetAccount()),
		"openingBalance": moneyJSON(resp.GetOpeningBalance()),
		"closingBalance": moneyJSON(resp.GetClosingBalance()),
		"lines":          lines,
	})
}

// parseDay reads a YYYY-MM-DD query parameter.
func parseDay(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}
