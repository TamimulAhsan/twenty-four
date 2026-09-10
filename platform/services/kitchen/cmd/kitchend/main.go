// Command kitchend serves the Kitchen service: the prep screens.
//
// A trade capability, not a sold module. Nobody buys it; the industry profile
// switches it on for food service, and a candy shop buying the same POS gets a
// till and no prep screen. That is what keeps POS meaning "register a sale"
// everywhere, and it is why this is a separate service rather than a feature
// inside the till.
//
// It owns the one thing POS does not: the state of the work. A sale is placed
// once and is then history. A ticket is claimed, cooked and passed by different
// people at different screens over ten minutes, and putting that inside POS
// would put a kitchen's workflow inside the till's transaction.
//
// It listens rather than being called. The till rings up a sale and knows
// nothing about a pass.
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

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/twentyfour/platform/gen/go/twentyfour/kitchen/v1"
	"github.com/twentyfour/platform/packages/bus"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/kitchen/internal/store"
)

type server struct {
	pb.UnimplementedKitchenServiceServer
	st *store.Store
}

func fail(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "that is not on any screen")
	case errors.Is(err, store.ErrClaimed):
		return status.Error(codes.FailedPrecondition, "somebody is already on that")
	case errors.Is(err, store.ErrNotReady):
		return status.Error(codes.FailedPrecondition,
			"that ticket still has something cooking")
	}
	slog.Error("kitchen", "err", err)
	return status.Error(codes.Internal, "could not read or write the screens")
}

func ticketStatePB(s string) pb.TicketState {
	switch s {
	case "waiting":
		return pb.TicketState_TICKET_STATE_WAITING
	case "cooking":
		return pb.TicketState_TICKET_STATE_COOKING
	case "ready":
		return pb.TicketState_TICKET_STATE_READY
	case "passed":
		return pb.TicketState_TICKET_STATE_PASSED
	case "voided":
		return pb.TicketState_TICKET_STATE_VOIDED
	}
	return pb.TicketState_TICKET_STATE_UNSPECIFIED
}

func lineStatePB(s string) pb.LineState {
	switch s {
	case "waiting":
		return pb.LineState_LINE_STATE_WAITING
	case "claimed":
		return pb.LineState_LINE_STATE_CLAIMED
	case "done":
		return pb.LineState_LINE_STATE_DONE
	case "voided":
		return pb.LineState_LINE_STATE_VOIDED
	}
	return pb.LineState_LINE_STATE_UNSPECIFIED
}

func ticketPB(t store.Ticket) *pb.Ticket {
	out := &pb.Ticket{
		Id: t.ID.String(), OrderId: t.OrderID.String(), OrderNumber: t.OrderNumber,
		TableLabel: t.TableLabel, State: ticketStatePB(t.State), Note: t.Note,
		PlacedAt: timestamppb.New(t.PlacedAt),
	}
	if t.PassedAt != nil {
		out.PassedAt = timestamppb.New(*t.PassedAt)
	}
	for _, l := range t.Lines {
		line := &pb.TicketLine{
			Id: l.ID.String(), ItemId: l.ItemID.String(), Name: l.Name,
			Quantity: l.Quantity, Note: l.Note, StationName: l.StationName,
			State: lineStatePB(l.State),
		}
		if l.StationID != nil {
			line.StationId = l.StationID.String()
		}
		if l.ClaimedBy != nil {
			line.ClaimedBy = l.ClaimedBy.String()
		}
		if l.ClaimedAt != nil {
			line.ClaimedAt = timestamppb.New(*l.ClaimedAt)
		}
		if l.DoneAt != nil {
			line.DoneAt = timestamppb.New(*l.DoneAt)
		}
		out.Lines = append(out.Lines, line)
	}
	return out
}

func stationPB(s store.Station) *pb.Station {
	return &pb.Station{
		Id: s.ID.String(), Name: s.Name, IsPass: s.IsPass, Active: s.Active,
	}
}

func (s *server) ListTickets(ctx context.Context, req *pb.ListTicketsRequest) (*pb.ListTicketsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	var station *uuid.UUID
	if req.GetStationId() != "" {
		id, err := uuid.Parse(req.GetStationId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "station_id must be a UUID")
		}
		station = &id
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 500 {
		size = 200
	}
	list, err := s.st.List(ctx, tenant, station, req.GetIncludeFinished(), size)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListTicketsResponse{}
	for _, t := range list {
		resp.Tickets = append(resp.Tickets, ticketPB(t))
	}
	return resp, nil
}

func (s *server) GetTicket(ctx context.Context, req *pb.GetTicketRequest) (*pb.GetTicketResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	t, err := s.st.Ticket(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetTicketResponse{Ticket: ticketPB(t)}, nil
}

func (s *server) ClaimLine(ctx context.Context, req *pb.ClaimLineRequest) (*pb.ClaimLineResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	lineID, err := uuid.Parse(req.GetLineId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "line_id must be a UUID")
	}
	// The person at the screen. Without it two cooks can both start the same
	// dish, which is the whole reason claiming exists.
	staff := tenantctx.User(ctx)
	if req.GetStaffId() != "" {
		parsed, err := uuid.Parse(req.GetStaffId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "staff_id must be a UUID")
		}
		staff = parsed
	}
	if staff == uuid.Nil {
		return nil, status.Error(codes.InvalidArgument,
			"say who is taking it, or the screen cannot stop two people starting the same dish")
	}
	t, err := s.st.Claim(ctx, tenant, lineID, staff)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.ClaimLineResponse{Ticket: ticketPB(t)}, nil
}

func (s *server) CompleteLine(ctx context.Context, req *pb.CompleteLineRequest) (*pb.CompleteLineResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetLineId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "line_id must be a UUID")
	}
	t, err := s.st.Complete(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.CompleteLineResponse{Ticket: ticketPB(t)}, nil
}

func (s *server) VoidLine(ctx context.Context, req *pb.VoidLineRequest) (*pb.VoidLineResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetLineId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "line_id must be a UUID")
	}
	t, err := s.st.VoidLine(ctx, tenant, id, strings.TrimSpace(req.GetReason()))
	if err != nil {
		return nil, fail(err)
	}
	return &pb.VoidLineResponse{Ticket: ticketPB(t)}, nil
}

func (s *server) PassTicket(ctx context.Context, req *pb.PassTicketRequest) (*pb.PassTicketResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	t, err := s.st.Pass(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("ticket passed", "tenant", tenant, "order", t.OrderNumber)
	return &pb.PassTicketResponse{Ticket: ticketPB(t)}, nil
}

func (s *server) ListStations(ctx context.Context, req *pb.ListStationsRequest) (*pb.ListStationsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.st.ListStations(ctx, tenant, req.GetIncludeInactive())
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListStationsResponse{}
	for _, st := range list {
		resp.Stations = append(resp.Stations, stationPB(st))
	}
	return resp, nil
}

func (s *server) PutStation(ctx context.Context, req *pb.PutStationRequest) (*pb.PutStationResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.GetName())
	if name == "" {
		return nil, status.Error(codes.InvalidArgument, "a station needs a name")
	}
	st := store.Station{
		TenantID: tenant, Name: name, IsPass: req.GetIsPass(), Active: req.GetActive(),
	}
	if req.GetId() != "" {
		id, err := uuid.Parse(req.GetId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
		}
		st.ID = id
	} else {
		st.Active = true
	}
	out, err := s.st.PutStation(ctx, st)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.PutStationResponse{Station: stationPB(out)}, nil
}

func (s *server) DeleteStation(ctx context.Context, req *pb.DeleteStationRequest) (*pb.DeleteStationResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	if err := s.st.DeleteStation(ctx, tenant, id); err != nil {
		return nil, fail(err)
	}
	return &pb.DeleteStationResponse{}, nil
}

func (s *server) RouteItem(ctx context.Context, req *pb.RouteItemRequest) (*pb.RouteItemResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	itemID, err := uuid.Parse(req.GetItemId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "item_id must be a UUID")
	}
	var station *uuid.UUID
	if req.GetStationId() != "" {
		id, err := uuid.Parse(req.GetStationId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "station_id must be a UUID")
		}
		station = &id
	}
	if err := s.st.RouteItem(ctx, tenant, itemID, station); err != nil {
		return nil, fail(err)
	}
	return &pb.RouteItemResponse{}, nil
}

func main() {
	addr := flag.String("addr", ":9121", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	brokers := flag.String("brokers", "kafka:9092", "comma separated Kafka brokers")
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

	printer := &printer{st: st}
	consumer, err := bus.NewConsumer(strings.Split(*brokers, ","), "kitchen",
		[]string{"order.placed", "order.voided"}, printer.handle)
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
	pb.RegisterKitchenServiceServer(srv, &server{st: st})

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		cancel()
		srv.GracefulStop()
	}()

	if err := grpcx.Run(srv, *addr, "kitchen"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
