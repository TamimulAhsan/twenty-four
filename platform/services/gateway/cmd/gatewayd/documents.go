package main

import (
	"encoding/json"
	"net/http"
	"strings"

	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	invoicingpb "github.com/twentyfour/platform/gen/go/twentyfour/invoicing/v1"
	staffpb "github.com/twentyfour/platform/gen/go/twentyfour/staff/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/httpx"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Fiscal documents, and the tenant's own subscription. Both from Invoicing,
// because they are one service: the only real difference between them is who
// the document is addressed to.
func (g *gateway) registerDocuments(mux *http.ServeMux) {
	mux.Handle("GET /api/documents", g.authenticated(g.listDocuments))
	mux.Handle("GET /api/documents/{id}", g.authenticated(g.getDocument))
	mux.Handle("GET /api/documents/{id}/artifact", g.authenticated(g.documentArtifact))
	mux.Handle("POST /api/documents", g.authenticated(g.issueDocument))
	mux.Handle("POST /api/documents/{id}/corrections", g.authenticated(g.correctDocument))

	mux.Handle("GET /api/billing/subscription", g.authenticated(g.getSubscription))
	mux.Handle("PATCH /api/billing/subscription", g.authenticated(g.changeSubscription))
}

var documentKinds = map[string]invoicingpb.DocumentKind{
	"invoice":              invoicingpb.DocumentKind_DOCUMENT_KIND_INVOICE,
	"receipt":              invoicingpb.DocumentKind_DOCUMENT_KIND_RECEIPT,
	"credit_note":          invoicingpb.DocumentKind_DOCUMENT_KIND_CREDIT_NOTE,
	"subscription_invoice": invoicingpb.DocumentKind_DOCUMENT_KIND_SUBSCRIPTION_INVOICE,
}

var documentKindNames = func() map[invoicingpb.DocumentKind]string {
	out := make(map[invoicingpb.DocumentKind]string, len(documentKinds))
	for name, k := range documentKinds {
		out[k] = name
	}
	return out
}()

var reportingNames = map[invoicingpb.ReportingStatus]string{
	invoicingpb.ReportingStatus_REPORTING_STATUS_NOT_REQUIRED: "not_required",
	invoicingpb.ReportingStatus_REPORTING_STATUS_QUEUED:       "queued",
	invoicingpb.ReportingStatus_REPORTING_STATUS_REPORTED:     "reported",
	invoicingpb.ReportingStatus_REPORTING_STATUS_RETRYING:     "retrying",
	invoicingpb.ReportingStatus_REPORTING_STATUS_FAILED:       "failed",
}

func documentJSON(d *invoicingpb.Document) map[string]any {
	out := map[string]any{
		"id": d.GetId(), "number": d.GetNumber(),
		"kind":     documentKindNames[d.GetKind()],
		"issuedAt": d.GetIssuedAt().AsTime(),
		"gross":    moneyJSON(d.GetGross()),
		"net":      moneyJSON(d.GetNet()),
		"tax":      moneyJSON(d.GetTax()),
		// The frontend's type says these are null when absent rather than
		// empty strings, because "no order" and "an order with an empty id"
		// are different things to render.
		"orderId":      nullable(d.GetOrderId()),
		"customerName": nullable(d.GetCustomerName()),
		// Generic, and it stays generic: no tax authority is named on the
		// merchant plane, so the dashboard cannot learn which one this
		// deployment talks to.
		"reportingStatus": reportingNames[d.GetReportingStatus()],
		// The artifact is fetched through the gateway rather than linked
		// directly, because it is stored in the issuing service and reading it
		// is a permission check, not a signed URL.
		"artifactUrl": "/api/documents/" + d.GetId() + "/artifact",
		"correctedBy": nullable(d.GetCorrectedById()),
		"corrects":    nullable(d.GetCorrectsId()),
	}
	return out
}

func (g *gateway) listDocuments(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "invoice:document:read") {
		return
	}
	q := r.URL.Query()
	req := &invoicingpb.ListDocumentsRequest{
		Kind:      documentKinds[strings.ToLower(q.Get("kind"))],
		OrderId:   q.Get("orderId"),
		PageToken: q.Get("pageToken"),
	}
	if from, ok := parseDay(q.Get("from")); ok {
		req.From = timestamppb.New(from)
	}
	if to, ok := parseDay(q.Get("to")); ok {
		req.To = timestamppb.New(to.AddDate(0, 0, 1))
	}
	resp, err := g.invoicing.ListDocuments(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetDocuments()))
	for _, d := range resp.GetDocuments() {
		out = append(out, documentJSON(d))
	}
	// A bare array, because that is what the documents page already parses.
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) getDocument(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "invoice:document:read") {
		return
	}
	resp, err := g.invoicing.GetDocument(g.downstream(r, c),
		&invoicingpb.GetDocumentRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, documentJSON(resp.GetDocument()))
}

// documentArtifact serves the stored bytes.
//
// Through the gateway rather than as a signed URL from object storage, because
// the artifact lives with the document that owns it. An invoice is not a file
// somebody uploaded; it is the record, and reading it is a permission check
// against the service that issued it.
func (g *gateway) documentArtifact(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "invoice:document:read") {
		return
	}
	resp, err := g.invoicing.RenderDocument(g.downstream(r, c),
		&invoicingpb.RenderDocumentRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	w.Header().Set("Content-Type", resp.GetContentType())
	w.Header().Set("Content-Disposition", `inline; filename="`+resp.GetFilename()+`"`)
	// Immutable, because an issued document never changes. This is the one
	// place in the API where that header is simply true.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(resp.GetBody())
}

func (g *gateway) issueDocument(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "invoice:document:issue") {
		return
	}
	var in struct {
		Kind            string `json:"kind"`
		OrderID         string `json:"orderId"`
		CustomerName    string `json:"customerName"`
		CustomerAddress string `json:"customerAddress"`
		CustomerTaxID   string `json:"customerTaxId"`
		Lines           []struct {
			Description string `json:"description"`
			Quantity    int32  `json:"quantity"`
			UnitPrice   int64  `json:"unitPriceMinor"`
			Net         int64  `json:"netMinor"`
			Tax         int64  `json:"taxMinor"`
			Gross       int64  `json:"grossMinor"`
			TaxRate     int32  `json:"taxBasisPoints"`
		} `json:"lines"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	kind, ok := documentKinds[strings.ToLower(in.Kind)]
	if !ok {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
			"Say whether this is an invoice or a receipt.")
		return
	}
	req := &invoicingpb.IssueRequest{
		Kind: kind, OrderId: in.OrderID, CustomerName: in.CustomerName,
		CustomerAddress: in.CustomerAddress, CustomerTaxId: in.CustomerTaxID,
		IdempotencyKey: in.IdempotencyKey,
	}
	for _, l := range in.Lines {
		req.Lines = append(req.Lines, &invoicingpb.DocumentLine{
			Description: l.Description, Quantity: l.Quantity,
			UnitPrice: g.minor(l.UnitPrice), Net: g.minor(l.Net),
			Tax: g.minor(l.Tax), Gross: g.minor(l.Gross),
			TaxRate: &commonpb.TaxRate{BasisPoints: l.TaxRate},
		})
	}
	resp, err := g.invoicing.Issue(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusCreated, documentJSON(resp.GetDocument()))
}

func (g *gateway) correctDocument(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "invoice:document:issue") {
		return
	}
	var in struct {
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	resp, err := g.invoicing.Correct(g.downstream(r, c), &invoicingpb.CorrectRequest{
		Id: r.PathValue("id"), Reason: in.Reason,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusCreated, documentJSON(resp.GetCreditNote()))
}

var subscriptionStatusNames = map[invoicingpb.SubscriptionStatus]string{
	invoicingpb.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE:    "active",
	invoicingpb.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE:  "past_due",
	invoicingpb.SubscriptionStatus_SUBSCRIPTION_STATUS_CANCELLED: "cancelled",
}

func (g *gateway) getSubscription(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "tenant:billing:manage") {
		return
	}
	resp, err := g.invoicing.GetSubscription(g.downstream(r, c),
		&invoicingpb.GetSubscriptionRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, g.subscriptionJSON(r, c, resp.GetSubscription()))
}

func (g *gateway) changeSubscription(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "tenant:billing:manage") {
		return
	}
	var in struct {
		Tier   string `json:"tier"`
		Period string `json:"billingPeriod"`
		Cancel bool   `json:"cancel"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	period := invoicingpb.BillingPeriod_BILLING_PERIOD_UNSPECIFIED
	switch strings.ToLower(in.Period) {
	case "monthly":
		period = invoicingpb.BillingPeriod_BILLING_PERIOD_MONTHLY
	case "annual":
		period = invoicingpb.BillingPeriod_BILLING_PERIOD_ANNUAL
	}
	resp, err := g.invoicing.ChangeSubscription(g.downstream(r, c),
		&invoicingpb.ChangeSubscriptionRequest{
			Tier: in.Tier, Period: period, Cancel: in.Cancel,
		})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, g.subscriptionJSON(r, c, resp.GetSubscription()))
}

// subscriptionJSON adds the seat count, which lives on the entitlement record
// rather than on the subscription.
//
// Two services, one screen. The money side is Invoicing's and the quota is
// Tenant's, and neither should hold a copy of the other's: a seat limit stored
// beside a price is a seat limit that disagrees with the one the Staff service
// enforces.
func (g *gateway) subscriptionJSON(r *http.Request, c caller, s *invoicingpb.Subscription) map[string]any {
	out := map[string]any{
		"tier":          s.GetTier(),
		"status":        subscriptionStatusNames[s.GetStatus()],
		"billingPeriod": billingPeriodNames[s.GetPeriod()],
		"amount":        moneyJSON(s.GetAmount()),
		"renewsAt":      s.GetRenewsAt().AsTime(),
	}
	if t := s.GetCancelsAt(); t.IsValid() {
		out["cancelsAt"] = t.AsTime()
	}
	seats := map[string]any{"limit": nil, "used": 0}
	if ent, err := g.tenant.GetEntitlement(g.downstream(r, c),
		&tenantpb.GetEntitlementRequest{}); err == nil {
		if limit := ent.GetEntitlement().GetSeatLimit(); limit > 0 {
			seats["limit"] = limit
		}
	}
	if members, err := g.staff.ListMembers(g.downstream(r, c),
		&staffpb.ListMembersRequest{}); err == nil {
		seats["used"] = len(members.GetMembers())
	}
	out["seats"] = seats
	return out
}

var billingPeriodNames = map[invoicingpb.BillingPeriod]string{
	invoicingpb.BillingPeriod_BILLING_PERIOD_MONTHLY: "monthly",
	invoicingpb.BillingPeriod_BILLING_PERIOD_ANNUAL:  "annual",
}

// minor wraps an integer amount in this market's currency, which the gateway
// knows because every service in the deployment is configured with the same one.
func (g *gateway) minor(v int64) *commonpb.Money {
	return &commonpb.Money{Minor: v, Currency: g.currency}
}
