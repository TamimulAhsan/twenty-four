// Package phrasing turns an event into a sentence a person can read.
//
// This is the whole of the service's value. A row saying
// `order.voided {"order_id":"9f3c...","reason":"wrong table"}` is something an
// engineer can decode during an incident. It is not what a merchant asking why
// a sale disappeared needs, and it is not what an auditor will accept.
//
// Three rules hold the package together.
//
// An unknown topic is still recorded. A trail that only covers the events
// somebody remembered to write a sentence for has holes in exactly the places
// nobody was watching, so an unrecognised event gets a generic sentence and
// keeps its payload. The sentence being clumsy is a smaller problem than the
// line being absent.
//
// Money is never reformatted here. It arrives as minor units and a currency
// code and it is rendered as minor units and a currency code. This package has
// no currency table, and inventing one would be a second answer to whether HUF
// has a subunit.
//
// No display terms. The sentence says "item", not "room", for the same reason
// the API path does: a hotel's vocabulary is applied when the trail is
// rendered, by whoever holds the term set, and welding it in here would make
// the record itself trade-specific.
package phrasing

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Result is what one event becomes.
type Result struct {
	// Semantic, matching the topic. The trail is filtered on this.
	Action string
	// What was acted on, so the trail can be read beside the thing itself.
	SubjectType string
	SubjectID   string
	// One sentence, written for a person.
	Summary string
	// Whether a sentence was actually written for this topic. A generic line is
	// still worth keeping, and worth knowing about.
	Known bool
}

// Money is the shape every amount arrives in. Minor units and a code, never a
// float, exactly as it is everywhere else.
type money struct {
	Minor    int64  `json:"minor"`
	Currency string `json:"currency"`
}

// String renders it the only honest way a service with no currency table can:
// the integer and the code. A hundredths point inserted here would be wrong for
// HUF, and getting it right would need the table this service does not have.
func (m money) String() string {
	if m.Currency == "" {
		return fmt.Sprintf("%d", m.Minor)
	}
	return fmt.Sprintf("%d %s", m.Minor, m.Currency)
}

// Describe reads an event and writes its line.
func Describe(topic string, payload []byte) Result {
	switch topic {
	case "order.placed":
		return order(payload, "rang up")
	case "order.voided":
		return voided(payload)
	case "payment.succeeded":
		return paymentSucceeded(payload)
	case "payment.refunded":
		return paymentRefunded(payload)
	case "stock.adjusted":
		return stockAdjusted(payload)
	case "stock.low":
		return stockLow(payload)
	case "staff.added":
		return staff(topic, payload, "joined the team")
	case "staff.removed":
		return staff(topic, payload, "was removed from the team")
	case "module.enabled":
		return module(topic, payload, "switched on")
	case "module.disabled":
		return module(topic, payload, "switched off")
	case "tenant.provisioned":
		return provisioned(payload)
	case "notification.queued":
		return notification(topic, payload, "was composed")
	case "notification.sent":
		return notification(topic, payload, "was sent")
	case "booking.created":
		return booking(topic, payload, "was booked")
	case "booking.cancelled":
		return booking(topic, payload, "was cancelled")
	case "booking.no_show":
		return booking(topic, payload, "was marked a no-show")
	case "invoice.issued":
		return invoiceIssued(payload)
	case "media.uploaded":
		return media(topic, payload, "was uploaded")
	case "media.deleted":
		return media(topic, payload, "was deleted")
	}
	return unknown(topic, payload)
}

// unknown is the fallback, and it is deliberately not a failure.
//
// The topic is turned into a readable phrase rather than dropped: "order.voided"
// with no handler would still read as "order voided". It is marked unknown so
// the gap is findable, without the record having a hole in it meanwhile.
func unknown(topic string, payload []byte) Result {
	parts := strings.SplitN(topic, ".", 2)
	subject := parts[0]
	verb := topic
	if len(parts) == 2 {
		verb = strings.ReplaceAll(parts[1], "_", " ")
	}
	r := Result{
		Action: topic, SubjectType: subject,
		Summary: capitalise(subject) + " " + verb + ".",
	}
	// Most events carry an id for their own subject named after it. Using it
	// when it is there keeps even an unrecognised line readable beside the
	// thing it concerns.
	var generic map[string]json.RawMessage
	if json.Unmarshal(payload, &generic) == nil {
		if raw, ok := generic[subject+"_id"]; ok {
			var id string
			if json.Unmarshal(raw, &id) == nil {
				r.SubjectID = id
			}
		}
	}
	return r
}

func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func order(payload []byte, verb string) Result {
	var p struct {
		OrderID string `json:"order_id"`
		Number  string `json:"number"`
		Gross   money  `json:"gross"`
		Lines   []struct {
			Name     string `json:"name"`
			Quantity int32  `json:"quantity"`
		} `json:"lines"`
		Tenders []struct {
			Method string `json:"method"`
		} `json:"tenders"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown("order.placed", payload)
	}
	// The item count, not the line count. Three of one thing is three items
	// sold, and a merchant reading the trail counts what left the shelf.
	items := 0
	for _, l := range p.Lines {
		items += int(l.Quantity)
	}
	methods := make([]string, 0, len(p.Tenders))
	for _, t := range p.Tenders {
		methods = append(methods, t.Method)
	}
	summary := fmt.Sprintf("Sale %s %s: %s for %s", p.Number, verb,
		plural(items, "item", "items"), p.Gross)
	if len(methods) > 0 {
		summary += ", paid by " + strings.Join(methods, " and ")
	}
	return Result{
		Action: "order.placed", SubjectType: "order", SubjectID: p.OrderID,
		Summary: summary + ".", Known: true,
	}
}

func voided(payload []byte) Result {
	var p struct {
		OrderID string `json:"order_id"`
		Number  string `json:"number"`
		Gross   money  `json:"gross"`
		Note    string `json:"note"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown("order.voided", payload)
	}
	summary := fmt.Sprintf("Sale %s was voided, taking %s back out of the day's takings",
		p.Number, p.Gross)
	if p.Note != "" {
		summary += ": " + p.Note
	}
	return Result{
		Action: "order.voided", SubjectType: "order", SubjectID: p.OrderID,
		Summary: summary + ".", Known: true,
	}
}

func paymentSucceeded(payload []byte) Result {
	var p struct {
		PaymentID     string `json:"payment_id"`
		MethodKey     string `json:"method_key"`
		Amount        money  `json:"amount"`
		ReferenceType string `json:"reference_type"`
		ReferenceID   string `json:"reference_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown("payment.succeeded", payload)
	}
	summary := fmt.Sprintf("%s taken by %s", p.Amount, p.MethodKey)
	if p.ReferenceID != "" {
		summary += fmt.Sprintf(" against %s %s", p.ReferenceType, p.ReferenceID)
	}
	return Result{
		Action: "payment.succeeded", SubjectType: "payment", SubjectID: p.PaymentID,
		Summary: summary + ".", Known: true,
	}
}

func paymentRefunded(payload []byte) Result {
	var p struct {
		PaymentID     string `json:"payment_id"`
		Amount        money  `json:"amount"`
		Reason        string `json:"reason"`
		FullyRefunded bool   `json:"fully_refunded"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown("payment.refunded", payload)
	}
	// Partly and fully refunded are different facts and the sentence says which,
	// because "refunded" alone is the ambiguity that starts the argument.
	what := "Partly refunded"
	if p.FullyRefunded {
		what = "Fully refunded"
	}
	summary := fmt.Sprintf("%s: %s returned", what, p.Amount)
	if p.Reason != "" {
		summary += ", " + p.Reason
	}
	return Result{
		Action: "payment.refunded", SubjectType: "payment", SubjectID: p.PaymentID,
		Summary: summary + ".", Known: true,
	}
}

func stockAdjusted(payload []byte) Result {
	var p struct {
		ItemID        string `json:"item_id"`
		Delta         int32  `json:"delta"`
		Kind          string `json:"kind"`
		Reason        string `json:"reason"`
		OnHand        int32  `json:"on_hand"`
		ReferenceType string `json:"reference_type"`
		ReferenceID   string `json:"reference_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown("stock.adjusted", payload)
	}
	// The move kinds read differently to a person than they do in the schema:
	// "reserve 2" is stock held, not stock gained.
	var summary string
	switch p.Kind {
	case "reserve":
		summary = fmt.Sprintf("%d held against %s %s", p.Delta, p.ReferenceType, p.ReferenceID)
	case "release":
		summary = fmt.Sprintf("%d released back from %s %s", p.Delta, p.ReferenceType, p.ReferenceID)
	case "consume", "consume_unreserved":
		summary = fmt.Sprintf("%d left the shelf, %d on hand", p.Delta, p.OnHand)
	default:
		direction := "added"
		count := p.Delta
		if count < 0 {
			direction, count = "removed", -count
		}
		summary = fmt.Sprintf("%d %s, %d on hand", count, direction, p.OnHand)
		if p.Reason != "" {
			summary += ": " + p.Reason
		}
	}
	return Result{
		Action: "stock.adjusted", SubjectType: "catalog_item", SubjectID: p.ItemID,
		Summary: capitalise(summary) + ".", Known: true,
	}
}

func stockLow(payload []byte) Result {
	var p struct {
		ItemID    string `json:"item_id"`
		OnHand    int32  `json:"on_hand"`
		Threshold int32  `json:"threshold"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown("stock.low", payload)
	}
	return Result{
		Action: "stock.low", SubjectType: "catalog_item", SubjectID: p.ItemID,
		Summary: fmt.Sprintf("Down to %d, at or below the threshold of %d.", p.OnHand, p.Threshold),
		Known:   true,
	}
}

func staff(topic string, payload []byte, verb string) Result {
	var p struct {
		UserID string `json:"user_id"`
		Email  string `json:"email"`
		Name   string `json:"name"`
		Role   string `json:"role_key"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown(topic, payload)
	}
	who := p.Name
	if who == "" {
		who = p.Email
	}
	if who == "" {
		who = "Somebody"
	}
	summary := who + " " + verb
	if p.Role != "" {
		summary += " as " + p.Role
	}
	return Result{
		Action: topic, SubjectType: "staff_member",
		SubjectID: p.UserID, Summary: summary + ".", Known: true,
	}
}

func module(topic string, payload []byte, verb string) Result {
	var p struct {
		ModuleID string `json:"module_id"`
		Source   string `json:"source"`
		Pending  bool   `json:"pending"`
		Tier     string `json:"tier"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown(topic, payload)
	}
	summary := capitalise(p.ModuleID) + " was " + verb
	switch p.Source {
	case "tier":
		summary += " by the " + p.Tier + " tier"
	case "dependency":
		summary += " because something else needs it"
	case "profile":
		summary += " by the industry profile"
	case "override":
		summary += " as an override recorded against this business"
	}
	// A module granted but not yet provisioned is a materially different state
	// from one that is working, and the trail is where somebody looks to find
	// out which of the two they are in.
	if p.Pending {
		summary += ", and is waiting on a step a person has to take"
	}
	return Result{
		Action: topic, SubjectType: "module",
		SubjectID: p.ModuleID, Summary: summary + ".", Known: true,
	}
}

func provisioned(payload []byte) Result {
	var p struct {
		TenantID string `json:"tenant_id"`
		Tier     string `json:"tier"`
		Industry string `json:"industry"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown("tenant.provisioned", payload)
	}
	summary := "The business was set up"
	if p.Industry != "" {
		summary += " as " + p.Industry
	}
	if p.Tier != "" {
		summary += " on the " + p.Tier + " tier"
	}
	return Result{
		Action: "tenant.provisioned", SubjectType: "tenant", SubjectID: p.TenantID,
		Summary: summary + ".", Known: true,
	}
}

func notification(topic string, payload []byte, verb string) Result {
	var p struct {
		DeliveryID  string `json:"delivery_id"`
		TemplateKey string `json:"template_key"`
		Channel     string `json:"channel"`
		Held        bool   `json:"held"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown(topic, payload)
	}
	summary := fmt.Sprintf("%s %s message (%s) %s",
		article(p.Channel), p.Channel, p.TemplateKey, verb)
	if p.Held {
		summary += ", and is waiting for quiet hours to end"
	}
	return Result{
		Action: topic, SubjectType: "message",
		SubjectID: p.DeliveryID, Summary: summary + ".", Known: true,
	}
}

func booking(topic string, payload []byte, verb string) Result {
	var p struct {
		BookingID string `json:"booking_id"`
		Customer  string `json:"customer_name"`
		StartsAt  string `json:"starts_at"`
		Reason    string `json:"reason"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown(topic, payload)
	}
	who := p.Customer
	if who == "" {
		who = "A booking"
	}
	summary := fmt.Sprintf("%s %s", who, verb)
	if p.StartsAt != "" {
		summary += " for " + p.StartsAt
	}
	if p.Reason != "" {
		summary += ": " + p.Reason
	}
	return Result{
		Action: topic, SubjectType: "booking",
		SubjectID: p.BookingID, Summary: summary + ".", Known: true,
	}
}

func invoiceIssued(payload []byte) Result {
	var p struct {
		DocumentID string `json:"document_id"`
		Number     string `json:"number"`
		Total      money  `json:"total"`
		Customer   string `json:"customer_name"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown("invoice.issued", payload)
	}
	summary := fmt.Sprintf("Invoice %s issued for %s", p.Number, p.Total)
	if p.Customer != "" {
		summary += " to " + p.Customer
	}
	return Result{
		Action: "invoice.issued", SubjectType: "document", SubjectID: p.DocumentID,
		Summary: summary + ".", Known: true,
	}
}

// article picks "a" or "an" for a word that is data rather than prose. Every
// channel name that exists is either email, SMS or push, and the first of them
// is the reason this function exists at all.
func article(word string) string {
	if word == "" {
		return "A"
	}
	switch strings.ToLower(word[:1]) {
	case "a", "e", "i", "o", "u":
		return "An"
	}
	return "A"
}

func media(topic string, payload []byte, verb string) Result {
	var p struct {
		MediaID     string `json:"media_id"`
		Purpose     string `json:"purpose"`
		Filename    string `json:"filename"`
		SizeBytes   int64  `json:"size_bytes"`
		SubjectType string `json:"subject_type"`
		SubjectID   string `json:"subject_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return unknown(topic, payload)
	}
	what := p.Filename
	if what == "" {
		what = "A file"
	}
	summary := what + " " + verb
	// The purpose is stored as a key and read as words, so the trail says
	// "catalog image" rather than "catalog_image".
	if p.Purpose != "" {
		summary += " as " + strings.ReplaceAll(p.Purpose, "_", " ")
	}
	if p.SubjectID != "" {
		summary += " for " + strings.ReplaceAll(p.SubjectType, "_", " ") + " " + p.SubjectID
	}
	// The subject is what the file is attached to, when it is attached to
	// something, so the trail reads beside that thing rather than beside a list
	// of files. A file with nothing to belong to is its own subject.
	subjectType, subjectID := p.SubjectType, p.SubjectID
	if subjectID == "" {
		subjectType, subjectID = "media", p.MediaID
	}
	return Result{
		Action: topic, SubjectType: subjectType, SubjectID: subjectID,
		Summary: summary + ".", Known: true,
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}
