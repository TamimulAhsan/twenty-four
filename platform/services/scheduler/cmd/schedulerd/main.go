// Command schedulerd serves the Scheduler service: what makes something happen
// later.
//
// It does not do the work. It publishes an event saying the work is due, and
// whichever service owns that work consumes it. That seam is what stops a
// scheduler becoming the place every recurring job's logic ends up living, and
// it is why this service has no idea what nightly reconciliation involves.
//
// The runner is a poller over two indexes rather than a job runtime. River is
// in the stack for durable work with retries and dependencies, and this is a
// due time and a claim, which Postgres does well on its own. The moment a job
// here grows a retry policy or a dependency on another job, that is the signal
// to move, not before.
package main

import (
	"context"
	"encoding/json"
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

	pb "github.com/twentyfour/platform/gen/go/twentyfour/scheduler/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/scheduler/internal/store"
)

type server struct {
	pb.UnimplementedSchedulerServiceServer
	st *store.Store
}

func fail(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return status.Error(codes.NotFound, "there is no such schedule")
	}
	slog.Error("scheduler", "err", err)
	return status.Error(codes.Internal, "could not read or write schedules")
}

func schedulePB(s store.Schedule) *pb.Schedule {
	out := &pb.Schedule{
		Key: s.Key, Topic: s.Topic, EverySeconds: s.EverySeconds,
		TimeZone: s.TimeZone, Paused: s.Paused, Payload: string(s.Payload),
		NextRunAt: timestamppb.New(s.NextRunAt), LastError: s.LastError,
	}
	if s.Hour != nil {
		out.Hour = s.Hour
	}
	if s.LastRunAt != nil {
		out.LastRunAt = timestamppb.New(*s.LastRunAt)
	}
	return out
}

func reminderStateName(s pb.ReminderState) string {
	switch s {
	case pb.ReminderState_REMINDER_STATE_PENDING:
		return "pending"
	case pb.ReminderState_REMINDER_STATE_FIRED:
		return "fired"
	case pb.ReminderState_REMINDER_STATE_CANCELLED:
		return "cancelled"
	}
	return ""
}

func reminderStatePB(s string) pb.ReminderState {
	switch s {
	case "pending":
		return pb.ReminderState_REMINDER_STATE_PENDING
	case "fired":
		return pb.ReminderState_REMINDER_STATE_FIRED
	case "cancelled":
		return pb.ReminderState_REMINDER_STATE_CANCELLED
	}
	return pb.ReminderState_REMINDER_STATE_UNSPECIFIED
}

func reminderPB(r store.Reminder) *pb.Reminder {
	out := &pb.Reminder{
		Id: r.ID.String(), Topic: r.Topic, DueAt: timestamppb.New(r.DueAt),
		State: reminderStatePB(r.State), SubjectType: r.SubjectType,
		SubjectId: r.SubjectID, Payload: string(r.Payload),
		CreatedAt: timestamppb.New(r.CreatedAt),
	}
	if r.FiredAt != nil {
		out.FiredAt = timestamppb.New(*r.FiredAt)
	}
	return out
}

// validTopic refuses a topic that is not shaped like an announcement.
//
// A caller that can name any topic can publish into another service's, and a
// scheduler is exactly the service somebody would use to do that by accident:
// it is the one place where the topic is a parameter rather than a constant.
func validTopic(topic string) bool {
	parts := strings.Split(topic, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false
	}
	for _, r := range topic {
		if (r < 'a' || r > 'z') && r != '.' && r != '_' {
			return false
		}
	}
	return true
}

func payloadOf(s string) (json.RawMessage, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	if !json.Valid([]byte(s)) {
		return nil, status.Error(codes.InvalidArgument, "the payload must be JSON")
	}
	return json.RawMessage(s), nil
}

func (s *server) PutSchedule(ctx context.Context, req *pb.PutScheduleRequest) (*pb.PutScheduleResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(req.GetKey())
	if key == "" {
		return nil, status.Error(codes.InvalidArgument, "a schedule needs a key")
	}
	if !validTopic(req.GetTopic()) {
		return nil, status.Error(codes.InvalidArgument,
			"a schedule publishes to a topic named subject.verb")
	}
	// A minute is not a limitation, it is a floor. Anything that has to happen
	// more often than once a minute is not a schedule, it is a loop, and it
	// belongs in the service that owns the work.
	if req.GetEverySeconds() < 60 {
		return nil, status.Error(codes.InvalidArgument,
			"a schedule runs at most once a minute; anything faster belongs in the service itself")
	}
	zone := req.GetTimeZone()
	if zone == "" {
		zone = "UTC"
	}
	if _, err := time.LoadLocation(zone); err != nil {
		return nil, status.Error(codes.InvalidArgument, "that is not a time zone we recognise")
	}
	if req.Hour != nil && (req.GetHour() < 0 || req.GetHour() > 23) {
		return nil, status.Error(codes.InvalidArgument, "an hour is 0 to 23")
	}
	payload, err := payloadOf(req.GetPayload())
	if err != nil {
		return nil, err
	}

	out, err := s.st.PutSchedule(ctx, store.Schedule{
		TenantID: tenant, Key: key, Topic: req.GetTopic(),
		EverySeconds: req.GetEverySeconds(), Hour: req.Hour, TimeZone: zone,
		Payload: payload, Paused: req.GetPaused(),
	})
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("schedule registered", "tenant", tenant, "key", key,
		"topic", out.Topic, "next", out.NextRunAt)
	return &pb.PutScheduleResponse{Schedule: schedulePB(out)}, nil
}

func (s *server) ListSchedules(ctx context.Context, _ *pb.ListSchedulesRequest) (*pb.ListSchedulesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.st.ListSchedules(ctx, tenant)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListSchedulesResponse{}
	for _, sc := range list {
		resp.Schedules = append(resp.Schedules, schedulePB(sc))
	}
	return resp, nil
}

func (s *server) DeleteSchedule(ctx context.Context, req *pb.DeleteScheduleRequest) (*pb.DeleteScheduleResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.st.DeleteSchedule(ctx, tenant, req.GetKey()); err != nil {
		return nil, fail(err)
	}
	return &pb.DeleteScheduleResponse{}, nil
}

func (s *server) RunNow(ctx context.Context, req *pb.RunNowRequest) (*pb.RunNowResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	out, err := s.st.RunNow(ctx, tenant, req.GetKey())
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("schedule run by hand", "tenant", tenant, "key", req.GetKey(),
		"next_run_unchanged", out.NextRunAt)
	return &pb.RunNowResponse{Schedule: schedulePB(out)}, nil
}

func (s *server) Schedule(ctx context.Context, req *pb.ScheduleRequest) (*pb.ScheduleResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	if !validTopic(req.GetTopic()) {
		return nil, status.Error(codes.InvalidArgument,
			"a reminder publishes to a topic named subject.verb")
	}
	due := req.GetDueAt()
	if !due.IsValid() {
		return nil, status.Error(codes.InvalidArgument, "a reminder needs a time")
	}
	payload, err := payloadOf(req.GetPayload())
	if err != nil {
		return nil, err
	}
	// A due time in the past is accepted rather than refused, and fires on the
	// next pass. Refusing it would make every caller race the clock between
	// deciding to schedule and the call arriving, and the honest reading of
	// "remind me at 3pm" at 3:01 is "now", not "never".
	out, repeat, err := s.st.PutReminder(ctx, store.Reminder{
		TenantID: tenant, Topic: req.GetTopic(), DueAt: due.AsTime(),
		SubjectType: req.GetSubjectType(), SubjectID: req.GetSubjectId(),
		Payload: payload, IdempotencyKey: req.GetIdempotencyKey(),
	})
	if err != nil {
		return nil, fail(err)
	}
	if repeat {
		slog.Debug("reminder already scheduled", "tenant", tenant, "id", out.ID)
	}
	return &pb.ScheduleResponse{Reminder: reminderPB(out)}, nil
}

func (s *server) Cancel(ctx context.Context, req *pb.CancelRequest) (*pb.CancelResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	var id *uuid.UUID
	if req.GetId() != "" {
		parsed, err := uuid.Parse(req.GetId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
		}
		id = &parsed
	}
	if id == nil && (req.GetSubjectType() == "" || req.GetSubjectId() == "") {
		// Without either, this would cancel everything the tenant has pending.
		// That is a plausible typo and an implausible intention.
		return nil, status.Error(codes.InvalidArgument,
			"cancel one reminder, or everything pending about one thing")
	}
	n, err := s.st.CancelReminder(ctx, tenant, id, req.GetSubjectType(), req.GetSubjectId())
	if err != nil {
		return nil, fail(err)
	}
	return &pb.CancelResponse{Cancelled: int32(n)}, nil
}

func (s *server) ListReminders(ctx context.Context, req *pb.ListRemindersRequest) (*pb.ListRemindersResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 500 {
		size = 100
	}
	list, err := s.st.ListReminders(ctx, tenant, reminderStateName(req.GetState()),
		req.GetSubjectType(), req.GetSubjectId(), size)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListRemindersResponse{}
	for _, r := range list {
		resp.Reminders = append(resp.Reminders, reminderPB(r))
	}
	return resp, nil
}

// runner is the poll loop.
//
// One pass does schedules and then reminders, and each is one transaction with
// SKIP LOCKED, so a second replica takes different rows rather than the same
// ones. That is what makes this safe to run more than once, which matters
// because a scheduler that must be a singleton is a scheduler that stops when
// its node does.
func runner(ctx context.Context, st *store.Store, every time.Duration, batch int) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := st.FireDueSchedules(ctx, batch); err != nil {
				slog.Error("fire schedules", "err", err)
			} else if n > 0 {
				slog.Info("schedules fired", "count", n)
			}
			if n, err := st.FireDueReminders(ctx, batch); err != nil {
				slog.Error("fire reminders", "err", err)
			} else if n > 0 {
				slog.Info("reminders fired", "count", n)
			}
		}
	}
}

func main() {
	addr := flag.String("addr", ":9116", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	tick := flag.Duration("tick", 10*time.Second, "how often the runner looks for due work")
	batch := flag.Int("batch", 50, "how much one pass fires")
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

	go runner(ctx, st, *tick, *batch)

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterSchedulerServiceServer(srv, &server{st: st})

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		cancel()
		srv.GracefulStop()
	}()

	if err := grpcx.Run(srv, *addr, "scheduler"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
