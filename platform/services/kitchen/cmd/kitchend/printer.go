package main

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/services/kitchen/internal/store"
)

// printer turns a sale into a ticket.
//
// Named for what it replaces. A kitchen printer took the order off the till and
// put it in front of a cook, and this does the same job with a screen: the till
// announces a sale and knows nothing about who is going to make it.
//
// It writes directly rather than through bus.Once, the same exception the audit
// trail and the ledger make: the tickets table already has a unique index on
// the order, so the insert is the deduplication and a second claim table would
// be two rows to say one meal was cooked once.
type printer struct{ st *store.Store }

func (p *printer) handle(ctx context.Context, m bus.Message) error {
	if m.TenantID == uuid.Nil {
		slog.Warn("event with no tenant, no ticket", "topic", m.Topic, "event", m.EventID)
		return bus.ErrSkip
	}
	switch m.Topic {
	case "order.placed":
		return p.place(ctx, m)
	case "order.voided":
		return p.void(ctx, m)
	}
	return bus.ErrSkip
}

func (p *printer) place(ctx context.Context, m bus.Message) error {
	var o struct {
		OrderID  string `json:"order_id"`
		Number   string `json:"number"`
		Status   string `json:"status"`
		PlacedAt string `json:"placed_at"`
		TableID  string `json:"table_id"`
		Note     string `json:"note"`
		Lines    []struct {
			ItemID   string `json:"item_id"`
			Name     string `json:"name"`
			Quantity int32  `json:"quantity"`
		} `json:"lines"`
	}
	if err := m.Into(&o); err != nil {
		return err
	}
	// A parked tab is not work yet. The kitchen starts when the order is
	// placed, not when somebody opens a tab and stands at the bar deciding.
	if o.Status == "open" {
		return bus.ErrSkip
	}
	if len(o.Lines) == 0 {
		return bus.ErrSkip
	}

	orderID, err := uuid.Parse(o.OrderID)
	if err != nil {
		return err
	}
	routes, err := p.st.Routes(ctx, m.TenantID)
	if err != nil {
		return err
	}

	placedAt := m.At
	if o.PlacedAt != "" {
		if parsed, err := time.Parse(time.RFC3339, o.PlacedAt); err == nil {
			// The till's clock, not the consumer's. The screen colours by how
			// long a table has been waiting, and that starts when the order was
			// rung up rather than when this service happened to read it.
			placedAt = parsed
		}
	}

	t := store.Ticket{
		TenantID: m.TenantID, OrderID: orderID, OrderNumber: o.Number,
		TableLabel: o.TableID, Note: o.Note, PlacedAt: placedAt,
	}
	routed := 0
	for _, l := range o.Lines {
		itemID, err := uuid.Parse(l.ItemID)
		if err != nil {
			continue
		}
		line := store.Line{
			ItemID: itemID, Name: l.Name, Quantity: l.Quantity,
		}
		if station, ok := routes[itemID]; ok {
			s := station
			line.StationID = &s
			routed++
		}
		// A line with no route still goes on the ticket, with no station. It
		// shows on the pass and on nothing else, which is visible and fixable;
		// dropping it would be a dish that silently never gets made.
		t.Lines = append(t.Lines, line)
	}
	if len(t.Lines) == 0 {
		return bus.ErrSkip
	}

	out, repeat, err := p.st.Create(ctx, t)
	if err != nil {
		return err
	}
	if !repeat {
		slog.Info("ticket on the screen", "order", out.OrderNumber,
			"lines", len(out.Lines), "routed", routed)
		if routed < len(out.Lines) {
			// Worth saying out loud: an unrouted line appears only on the pass,
			// which is survivable and is not what anybody intended.
			slog.Warn("some lines have no station and will only show on the pass",
				"order", out.OrderNumber, "unrouted", len(out.Lines)-routed)
		}
	}
	return nil
}

func (p *printer) void(ctx context.Context, m bus.Message) error {
	var o struct {
		OrderID string `json:"order_id"`
	}
	if err := m.Into(&o); err != nil {
		return err
	}
	orderID, err := uuid.Parse(o.OrderID)
	if err != nil {
		return err
	}
	if err := p.st.VoidTicket(ctx, m.TenantID, orderID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// A sale with nothing the kitchen makes. Normal, not a failure.
			return bus.ErrSkip
		}
		return err
	}
	slog.Info("ticket pulled: the sale was voided", "order", orderID)
	return nil
}
