// Command analyticsd serves reporting figures out of ClickHouse.
//
// It owns no data. Every row it reads was put there by the CDC connectors off
// the services that do own it, which is why this service has no database
// migrations against an operational store, no outbox, and no writes at all.
// A reporting query against the database that is taking payments is how a busy
// Saturday becomes an outage.
//
// The one thing worth remembering about it: the figures are a projection, and
// a projection is behind. Every answer says what it includes, and the screens
// are expected to show that rather than pretend a chart and a till can never
// disagree.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/twentyfour/platform/gen/go/twentyfour/analytics/v1"
	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/analytics/internal/clickhouse"
	"github.com/twentyfour/platform/services/analytics/schema"
)

type server struct {
	pb.UnimplementedAnalyticsServiceServer
	ch       *clickhouse.Client
	currency string
}

// The window a request may ask for.
//
// Bounded because an unbounded range is a full scan of every partition, and the
// screen that would ask for one is a screen nobody meant to build. Five years
// covers anything a merchant asks about their own trading.
const maxPeriodDays = 5 * 366

// bind turns a request's period into the parameters every query takes, and
// refuses the ones that cannot mean anything.
//
// The time zone is required rather than defaulted. A default of UTC would move
// takings between days for every business that trades in the evening, and it
// would do it quietly.
func (s *server) bind(ctx context.Context, p *pb.Period) (map[string]string, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	from, err := time.Parse(time.DateOnly, p.GetFrom())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "from must be a date, as YYYY-MM-DD")
	}
	to, err := time.Parse(time.DateOnly, p.GetTo())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "to must be a date, as YYYY-MM-DD")
	}
	if to.Before(from) {
		return nil, status.Error(codes.InvalidArgument, "the period ends before it starts")
	}
	if to.Sub(from) > maxPeriodDays*24*time.Hour {
		return nil, status.Errorf(codes.InvalidArgument, "a period cannot be longer than %d days", maxPeriodDays)
	}
	zone := strings.TrimSpace(p.GetTimeZone())
	if zone == "" {
		return nil, status.Error(codes.InvalidArgument, "a period needs the time zone its days are in")
	}
	if _, err := time.LoadLocation(zone); err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "%q is not a time zone", zone)
	}
	return map[string]string{
		"tenant": tenant.String(),
		"tz":     zone,
		"from":   p.GetFrom(),
		"to":     p.GetTo(),
	}, nil
}

func (s *server) fail(err error) error {
	slog.Error("analytics", "err", err)
	return status.Error(codes.Unavailable, "could not read the figures right now")
}

func (s *server) money(minor int64) *commonpb.Money {
	return &commonpb.Money{Minor: minor, Currency: s.currency}
}

// previous is the equal-length window immediately before this one.
//
// Equal length rather than "the same period last month", because a 31-day month
// against a 28-day one moves every figure for a reason that has nothing to do
// with the business.
func previous(p *pb.Period) *pb.Period {
	from, _ := time.Parse(time.DateOnly, p.GetFrom())
	to, _ := time.Parse(time.DateOnly, p.GetTo())
	days := int(to.Sub(from).Hours()/24) + 1
	return &pb.Period{
		From:     from.AddDate(0, 0, -days).Format(time.DateOnly),
		To:       from.AddDate(0, 0, -1).Format(time.DateOnly),
		TimeZone: p.GetTimeZone(),
	}
}

func (s *server) freshness(ctx context.Context, tenant string) *pb.Freshness {
	rows, err := s.ch.Query(ctx, freshnessSQL, map[string]string{"tenant": tenant})
	if err != nil || len(rows) == 0 {
		// Not knowing how fresh the figures are must not fail the figures. It
		// is one line on a screen, and losing it is better than losing them.
		if err != nil {
			slog.Warn("freshness", "err", err)
		}
		return &pb.Freshness{}
	}
	at, ok := clickhouse.Time(rows[0], "through")
	if !ok || at.IsZero() {
		return &pb.Freshness{}
	}
	return &pb.Freshness{Through: timestamppb.New(at)}
}

// totals reads one period's figures.
//
// Margin is unset rather than zero when any line in the period has no recorded
// cost. An item nobody costed has no margin; reporting one of a hundred percent
// is a number a merchant would act on.
func (s *server) totals(ctx context.Context, params map[string]string) (*pb.Totals, error) {
	rows, err := s.ch.Query(ctx, summarySQL, params)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return &pb.Totals{
			Gross: s.money(0), Net: s.money(0), Tax: s.money(0),
			Discount: s.money(0), Refunded: s.money(0), AverageBasket: s.money(0),
		}, nil
	}
	r := rows[0]

	num := func(col string) int64 {
		v, err := clickhouse.Sum(r, col)
		if err != nil {
			slog.Warn("unreadable figure", "column", col, "err", err)
		}
		return v
	}
	gross, net := num("gross_minor"), num("net_minor")
	orders := num("orders")
	lines := num("lines")

	out := &pb.Totals{
		Gross:     s.money(gross),
		Net:       s.money(net),
		Tax:       s.money(num("tax_minor")),
		Discount:  s.money(num("discount_minor")),
		Refunded:  s.money(num("refunded_minor")),
		Orders:    orders,
		Customers: num("customers"),
	}
	if orders > 0 {
		out.AverageBasket = s.money(gross / orders)
		out.AverageLinesPerOrderMilli = lines * 1000 / orders
	} else {
		out.AverageBasket = s.money(0)
	}
	if num("uncosted") == 0 {
		cost := num("cost_minor")
		out.Cost = s.money(cost)
		out.Margin = s.money(net - cost)
	}
	return out, nil
}

func (s *server) Summary(ctx context.Context, req *pb.SummaryRequest) (*pb.SummaryResponse, error) {
	params, err := s.bind(ctx, req.GetPeriod())
	if err != nil {
		return nil, err
	}
	current, err := s.totals(ctx, params)
	if err != nil {
		return nil, s.fail(err)
	}

	before := previous(req.GetPeriod())
	priorParams := map[string]string{
		"tenant": params["tenant"], "tz": params["tz"],
		"from": before.GetFrom(), "to": before.GetTo(),
	}
	prior, err := s.totals(ctx, priorParams)
	if err != nil {
		return nil, s.fail(err)
	}
	return &pb.SummaryResponse{
		Current: current, Previous: prior, PreviousPeriod: before,
		Freshness: s.freshness(ctx, params["tenant"]),
	}, nil
}

func (s *server) Series(ctx context.Context, req *pb.SeriesRequest) (*pb.SeriesResponse, error) {
	params, err := s.bind(ctx, req.GetPeriod())
	if err != nil {
		return nil, err
	}
	rows, err := s.ch.Query(ctx, seriesSQL, params)
	if err != nil {
		return nil, s.fail(err)
	}

	points := make([]*pb.DayPoint, 0, len(rows))
	for _, r := range rows {
		net, _ := clickhouse.Sum(r, "net_minor")
		gross, _ := clickhouse.Sum(r, "gross_minor")
		tax, _ := clickhouse.Sum(r, "tax_minor")
		orders, _ := clickhouse.Sum(r, "orders")
		customers, _ := clickhouse.Sum(r, "customers")
		uncosted, _, _ := clickhouse.NullInt(r, "uncosted")

		p := &pb.DayPoint{
			Date:      clickhouse.String(r, "day"),
			Gross:     s.money(gross),
			Net:       s.money(net),
			Tax:       s.money(tax),
			Orders:    orders,
			Customers: customers,
		}
		// A day with no lines at all has a margin of nothing, which is zero.
		// A day whose lines include one nobody costed has no margin at all.
		if uncosted == 0 {
			cost, _ := clickhouse.Sum(r, "cost_minor")
			p.Margin = s.money(net - cost)
		}
		points = append(points, p)
	}
	return &pb.SeriesResponse{Points: points, Freshness: s.freshness(ctx, params["tenant"])}, nil
}

func (s *server) Breakdown(ctx context.Context, req *pb.BreakdownRequest) (*pb.BreakdownResponse, error) {
	params, err := s.bind(ctx, req.GetPeriod())
	if err != nil {
		return nil, err
	}
	var query string
	switch req.GetDimension() {
	case pb.Dimension_DIMENSION_METHOD:
		query = methodSQL
	case pb.Dimension_DIMENSION_CATEGORY:
		query = categorySQL
	case pb.Dimension_DIMENSION_ITEM:
		query = itemSQL
	default:
		return nil, status.Error(codes.InvalidArgument, "say what to split the revenue by")
	}
	rows, err := s.ch.Query(ctx, query, params)
	if err != nil {
		return nil, s.fail(err)
	}

	var total int64
	slices := make([]*pb.Slice, 0, len(rows))
	for _, r := range rows {
		gross, _ := clickhouse.Sum(r, "gross_minor")
		orders, _ := clickhouse.Sum(r, "orders")
		total += gross
		slices = append(slices, &pb.Slice{
			Key:    clickhouse.String(r, "key"),
			Label:  clickhouse.String(r, "label"),
			Gross:  s.money(gross),
			Orders: orders,
		})
	}

	out := &pb.BreakdownResponse{Freshness: s.freshness(ctx, params["tenant"])}
	// Folding happens here rather than in SQL so the remainder can carry its
	// own order count. A LIMIT would simply lose the tail, and a screen showing
	// four methods out of six with shares that do not reach 100 is a screen
	// somebody will file a bug about.
	limit := int(req.GetLimit())
	if limit > 0 && len(slices) > limit {
		other := &pb.Slice{Gross: s.money(0)}
		var rest int64
		for _, sl := range slices[limit:] {
			rest += sl.GetGross().GetMinor()
			other.Orders += sl.GetOrders()
		}
		other.Gross = s.money(rest)
		slices = slices[:limit]
		out.Other = other
	}
	// Share is computed against the period's whole gross, including whatever
	// was folded away, so the parts add up to the total a merchant can see
	// elsewhere on the same screen.
	share := func(sl *pb.Slice) {
		if total > 0 {
			sl.ShareBasisPoints = int32(sl.GetGross().GetMinor() * 10000 / total)
		}
	}
	for _, sl := range slices {
		share(sl)
	}
	if out.Other != nil {
		share(out.Other)
	}
	out.Slices = slices
	return out, nil
}

func (s *server) Heatmap(ctx context.Context, req *pb.HeatmapRequest) (*pb.HeatmapResponse, error) {
	params, err := s.bind(ctx, req.GetPeriod())
	if err != nil {
		return nil, err
	}
	rows, err := s.ch.Query(ctx, heatmapSQL, params)
	if err != nil {
		return nil, s.fail(err)
	}

	type cell struct {
		orders int64
		gross  int64
	}
	found := map[int32]cell{}
	for _, r := range rows {
		weekday, _ := clickhouse.Sum(r, "weekday")
		hour, _ := clickhouse.Sum(r, "hour")
		orders, _ := clickhouse.Sum(r, "orders")
		gross, _ := clickhouse.Sum(r, "gross_minor")
		found[int32(weekday)*24+int32(hour)] = cell{orders: orders, gross: gross}
	}

	// Every cell, including the empty ones. A caller drawing a grid should not
	// have to invent the hours nobody traded in, and the hours nobody traded in
	// are half the point of looking at this.
	cells := make([]*pb.HeatCell, 0, 7*24)
	for weekday := int32(1); weekday <= 7; weekday++ {
		for hour := int32(0); hour < 24; hour++ {
			c := found[weekday*24+hour]
			cells = append(cells, &pb.HeatCell{
				Weekday: weekday, Hour: hour,
				Orders: c.orders, Gross: s.money(c.gross),
			})
		}
	}
	return &pb.HeatmapResponse{Cells: cells, Freshness: s.freshness(ctx, params["tenant"])}, nil
}

// applySchema creates the projection tables if they are not there.
//
// The connectors write into these tables and would fail against a database
// with none, so somebody has to make them, and the only process that reads
// them is this one. A schema owned by nobody is a schema nobody notices has
// drifted from the connector feeding it.
func applySchema(ctx context.Context, ch *clickhouse.Client) error {
	for _, stmt := range schema.Statements() {
		if err := ch.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("schema: %w", err)
		}
	}
	return nil
}

func main() {
	addr := flag.String("addr", ":9111", "gRPC listen address")
	chURL := flag.String("clickhouse", envOr("CLICKHOUSE_URL", "http://clickhouse:8123"), "ClickHouse HTTP address")
	chUser := flag.String("clickhouse-user", os.Getenv("CLICKHOUSE_USER"), "ClickHouse user")
	chPass := flag.String("clickhouse-password", os.Getenv("CLICKHOUSE_PASSWORD"), "ClickHouse password")
	chDB := flag.String("clickhouse-db", envOr("CLICKHOUSE_DB", "analytics"), "ClickHouse database")
	currency := flag.String("currency", envOr("CURRENCY", "HUF"), "this deployment's currency")
	level := flag.String("log-level", "info", "debug, info, warn or error")
	flag.Parse()

	grpcx.SetupLogging(*level)
	ctx := context.Background()

	ch := clickhouse.New(*chURL, *chUser, *chPass, *chDB)
	if err := applySchema(ctx, ch); err != nil {
		slog.Error("apply schema", "err", err)
		os.Exit(1)
	}

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterAnalyticsServiceServer(srv, &server{ch: ch, currency: *currency})
	if err := grpcx.Run(srv, *addr, "analytics"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
