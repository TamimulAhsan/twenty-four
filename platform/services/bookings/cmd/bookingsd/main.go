// Command bookingsd serves the Bookings service: the calendar.
//
// One guarantee, and everything else is arranged around it: a resource cannot
// be promised twice. Availability is that question asked in bulk, a reschedule
// is it asked again about a different time, and the capacity check happens
// inside a lock on the resource because the gap between "the page said it was
// free" and "the button was pressed" is exactly where a double booking lives.
//
// Trade-neutral, and it takes deliberate effort. A salon books a person, a
// hotel books a room, a clinic books both, a restaurant books a table. They are
// one shape, so this service has resources rather than staff and rooms, and the
// industry profile decides what a merchant sees them called.
package main

import (
	"context"
	"crypto/rand"
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

	pb "github.com/twentyfour/platform/gen/go/twentyfour/bookings/v1"
	catalogpb "github.com/twentyfour/platform/gen/go/twentyfour/catalog/v1"
	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	tenantpb "github.com/twentyfour/platform/gen/go/twentyfour/tenant/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/bookings/internal/slots"
	"github.com/twentyfour/platform/services/bookings/internal/store"
)

type server struct {
	pb.UnimplementedBookingsServiceServer
	st      *store.Store
	catalog catalogpb.CatalogServiceClient
	tenant  tenantpb.TenantServiceClient
	// How far apart offered start times are. Fifteen minutes for a forty-minute
	// appointment offers 09:00, 09:15, 09:30, which is what a customer expects
	// and what fills a day.
	step time.Duration
	// What a bookable item takes when the catalog does not say. A number is
	// needed to offer anything at all, and refusing to show availability
	// because somebody left a duration blank helps nobody.
	defaultDuration time.Duration
}

func fail(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "no such booking")
	case errors.Is(err, store.ErrTaken):
		return status.Error(codes.FailedPrecondition, "that time has just been taken")
	case errors.Is(err, store.ErrBadTransition):
		// The store's message names the state it is actually in, which is what
		// somebody looking at the booking on their screen needs to hear. The
		// last segment, not the first: the error is wrapped, so cutting at the
		// first colon keeps the wrapper and repeats it.
		if i := strings.LastIndex(err.Error(), ": "); i >= 0 {
			return status.Error(codes.FailedPrecondition, err.Error()[i+2:])
		}
		return status.Error(codes.FailedPrecondition,
			"a booking cannot go from where it is to there")
	}
	slog.Error("bookings", "err", err)
	return status.Error(codes.Internal, "could not read or write the calendar")
}

func statusName(s pb.BookingStatus) string {
	switch s {
	case pb.BookingStatus_BOOKING_STATUS_CONFIRMED:
		return "confirmed"
	case pb.BookingStatus_BOOKING_STATUS_ARRIVED:
		return "arrived"
	case pb.BookingStatus_BOOKING_STATUS_COMPLETED:
		return "completed"
	case pb.BookingStatus_BOOKING_STATUS_CANCELLED:
		return "cancelled"
	case pb.BookingStatus_BOOKING_STATUS_NO_SHOW:
		return "no_show"
	}
	return ""
}

func statusPB(s string) pb.BookingStatus {
	switch s {
	case "confirmed":
		return pb.BookingStatus_BOOKING_STATUS_CONFIRMED
	case "arrived":
		return pb.BookingStatus_BOOKING_STATUS_ARRIVED
	case "completed":
		return pb.BookingStatus_BOOKING_STATUS_COMPLETED
	case "cancelled":
		return pb.BookingStatus_BOOKING_STATUS_CANCELLED
	case "no_show":
		return pb.BookingStatus_BOOKING_STATUS_NO_SHOW
	}
	return pb.BookingStatus_BOOKING_STATUS_UNSPECIFIED
}

func resourcePB(r store.Resource) *pb.Resource {
	out := &pb.Resource{
		Id: r.ID.String(), Name: r.Name, Capacity: r.Capacity, Active: r.Active,
	}
	if r.StaffID != nil {
		out.StaffId = r.StaffID.String()
	}
	for _, w := range r.Opening {
		out.Opening = append(out.Opening, &pb.OpeningWindow{
			Weekday: int32(w.Weekday), Opens: w.Opens, Closes: w.Closes,
		})
	}
	return out
}

func bookingPB(b store.Booking) *pb.Booking {
	out := &pb.Booking{
		Id: b.ID.String(), Reference: b.Reference,
		ItemId: b.ItemID.String(), ItemName: b.ItemName,
		ResourceId:    b.ResourceID.String(),
		CustomerName:  b.CustomerName,
		CustomerPhone: b.CustomerPhone, CustomerEmail: b.CustomerEmail,
		StartsAt: timestamppb.New(b.StartsAt), EndsAt: timestamppb.New(b.EndsAt),
		Status: statusPB(b.Status), PaymentId: b.PaymentID, Note: b.Note,
		CreatedAt:          timestamppb.New(b.CreatedAt),
		CancellationReason: b.CancelReason,
	}
	if b.StaffID != nil {
		out.StaffId = b.StaffID.String()
	}
	// Absent rather than zero: no deposit asked for is not a deposit of
	// nothing, and a no-show policy turns on which it was.
	if b.DepositMinor != nil {
		out.Deposit = &commonpb.Money{Minor: *b.DepositMinor, Currency: b.DepositCurrency}
	}
	if b.CancelledAt != nil {
		out.CancelledAt = timestamppb.New(*b.CancelledAt)
	}
	return out
}

// zone is the tenant's time zone, which every date question needs.
//
// Read from the profile rather than defaulted, because a calendar computed in
// the wrong zone is a list of times that are all wrong by the same amount,
// which is exactly the error nobody notices until a customer arrives an hour
// early.
func (s *server) zone(ctx context.Context) (*time.Location, error) {
	resp, err := s.tenant.GetProfile(ctx, &tenantpb.GetProfileRequest{})
	if err != nil {
		return nil, status.Error(codes.Unavailable,
			"we could not read this business's time zone")
	}
	name := resp.GetProfile().GetTimezone()
	if name == "" {
		return nil, status.Error(codes.FailedPrecondition,
			"this business has no time zone set, so a calendar cannot be drawn")
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition,
			"this business's time zone (%s) is not one we recognise", name)
	}
	return loc, nil
}

// duration is how long an item takes, from the catalog.
//
// The catalog owns it, which is why a haircut and a colour take different
// amounts of the same chair without this service knowing anything about hair.
func (s *server) duration(ctx context.Context, itemID string) (time.Duration, string, error) {
	resp, err := s.catalog.GetItem(ctx, &catalogpb.GetItemRequest{Id: itemID})
	if status.Code(err) == codes.NotFound {
		return 0, "", status.Error(codes.NotFound, "there is nothing bookable with that id")
	}
	if err != nil {
		return 0, "", status.Error(codes.Unavailable, "we could not look that up right now")
	}
	item := resp.GetItem()
	minutes := item.GetDurationMinutes()
	if minutes <= 0 {
		return s.defaultDuration, item.GetName(), nil
	}
	return time.Duration(minutes) * time.Minute, item.GetName(), nil
}

func (s *server) ListResources(ctx context.Context, req *pb.ListResourcesRequest) (*pb.ListResourcesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.st.ListResources(ctx, tenant, req.GetIncludeInactive())
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListResourcesResponse{}
	for _, r := range list {
		resp.Resources = append(resp.Resources, resourcePB(r))
	}
	return resp, nil
}

func (s *server) PutResource(ctx context.Context, req *pb.PutResourceRequest) (*pb.PutResourceResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.GetName())
	if name == "" {
		return nil, status.Error(codes.InvalidArgument, "a resource needs a name")
	}
	capacity := req.GetCapacity()
	if capacity <= 0 {
		capacity = 1
	}
	r := store.Resource{
		TenantID: tenant, Name: name, Capacity: capacity, Active: req.GetActive(),
	}
	if req.GetId() != "" {
		id, err := uuid.Parse(req.GetId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
		}
		r.ID = id
	} else {
		// A new resource is active unless somebody said otherwise. Creating one
		// switched off is not a thing anybody means to do.
		r.Active = true
	}
	if req.GetStaffId() != "" {
		id, err := uuid.Parse(req.GetStaffId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "staff_id must be a UUID")
		}
		r.StaffID = &id
	}
	for _, w := range req.GetOpening() {
		if w.GetWeekday() < 1 || w.GetWeekday() > 7 {
			return nil, status.Error(codes.InvalidArgument,
				"a weekday is 1 to 7, Monday first")
		}
		if !validClock(w.GetOpens()) || !validClock(w.GetCloses()) {
			return nil, status.Error(codes.InvalidArgument, "opening hours are written as HH:MM")
		}
		r.Opening = append(r.Opening, slots.Window{
			Weekday: int(w.GetWeekday()), Opens: w.GetOpens(), Closes: w.GetCloses(),
		})
	}
	out, err := s.st.PutResource(ctx, r)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.PutResourceResponse{Resource: resourcePB(out)}, nil
}

func validClock(s string) bool {
	_, err := time.Parse("15:04", s)
	return err == nil
}

func (s *server) DeleteResource(ctx context.Context, req *pb.DeleteResourceRequest) (*pb.DeleteResourceResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	if err := s.st.DeleteResource(ctx, tenant, id); err != nil {
		return nil, fail(err)
	}
	return &pb.DeleteResourceResponse{}, nil
}

func (s *server) Availability(ctx context.Context, req *pb.AvailabilityRequest) (*pb.AvailabilityResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	loc, err := s.zone(ctx)
	if err != nil {
		return nil, err
	}
	// The request may state a zone, which is what a storefront in another one
	// would do. The tenant's own wins for computing the day, because opening
	// hours are the business's wall clock.
	date, err := time.ParseInLocation("2006-01-02", req.GetDate(), loc)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "a date is written YYYY-MM-DD")
	}
	duration, _, err := s.duration(ctx, req.GetItemId())
	if err != nil {
		return nil, err
	}

	resources, err := s.st.ListResources(ctx, tenant, false)
	if err != nil {
		return nil, fail(err)
	}
	if want := req.GetResourceId(); want != "" {
		filtered := resources[:0]
		for _, r := range resources {
			if r.ID.String() == want {
				filtered = append(filtered, r)
			}
		}
		resources = filtered
	}

	// A generous window either side of the day, so a booking that starts before
	// midnight and runs past it still counts as busy.
	from := date.Add(-24 * time.Hour)
	to := date.Add(48 * time.Hour)
	now := time.Now()

	resp := &pb.AvailabilityResponse{}
	for _, r := range resources {
		busy, err := s.st.Busy(ctx, tenant, r.ID, from, to)
		if err != nil {
			return nil, fail(err)
		}
		free := slots.Free(slots.Resource{
			ID: r.ID.String(), Name: r.Name, Capacity: int(r.Capacity), Opening: r.Opening,
		}, date, loc, duration, s.step, busy, now)
		for _, sl := range free {
			resp.Slots = append(resp.Slots, &pb.Slot{
				StartsAt: timestamppb.New(sl.Start), EndsAt: timestamppb.New(sl.End),
				ResourceId: sl.ResourceID, ResourceName: sl.ResourceName,
			})
		}
	}
	return resp, nil
}

func (s *server) Create(ctx context.Context, req *pb.CreateRequest) (*pb.CreateResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	// Asked first, before anything looks for a free slot. A retried request
	// that goes hunting for a resource finds the one this very booking is
	// occupying and is told nothing is free, which is exactly the answer the
	// idempotency key exists to prevent: the customer double-taps, the first
	// booking succeeds, and the second response says it failed.
	if key := req.GetIdempotencyKey(); key != "" {
		if existing, err := s.st.ByIdempotencyKey(ctx, tenant, key); err == nil {
			return &pb.CreateResponse{Booking: bookingPB(existing)}, nil
		} else if !errors.Is(err, store.ErrNotFound) {
			return nil, fail(err)
		}
	}
	startsAt := req.GetStartsAt()
	if !startsAt.IsValid() {
		return nil, status.Error(codes.InvalidArgument, "a booking needs a time")
	}
	itemID, err := uuid.Parse(req.GetItemId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "item_id must be a UUID")
	}
	duration, itemName, err := s.duration(ctx, req.GetItemId())
	if err != nil {
		return nil, err
	}
	loc, err := s.zone(ctx)
	if err != nil {
		return nil, err
	}

	start := startsAt.AsTime()
	end := start.Add(duration)

	resource, err := s.pickResource(ctx, tenant, req.GetResourceId(), start, end, loc)
	if err != nil {
		return nil, err
	}

	b := store.Booking{
		TenantID: tenant, ItemID: itemID, ItemName: itemName,
		ResourceID:    resource.ID,
		CustomerName:  strings.TrimSpace(req.GetCustomerName()),
		CustomerPhone: strings.TrimSpace(req.GetCustomerPhone()),
		CustomerEmail: strings.TrimSpace(req.GetCustomerEmail()),
		StartsAt:      start, EndsAt: end, Note: req.GetNote(),
		PaymentID: req.GetPaymentId(), IdempotencyKey: req.GetIdempotencyKey(),
	}
	if d := req.GetDeposit(); d != nil && d.GetCurrency() != "" {
		minor := d.GetMinor()
		b.DepositMinor, b.DepositCurrency = &minor, d.GetCurrency()
	}

	out, repeat, err := s.st.Create(ctx, b, reference)
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("booking created", "tenant", tenant, "reference", out.Reference,
		"resource", resource.Name, "starts", out.StartsAt, "repeat", repeat)
	return &pb.CreateResponse{Booking: bookingPB(out)}, nil
}

// pickResource resolves which resource takes the booking.
//
// Named explicitly, or the first one that is both open and free. Choosing on
// the service's side rather than making the caller do it is what lets a
// customer book "any stylist", which is what most of them want.
func (s *server) pickResource(ctx context.Context, tenant uuid.UUID, wanted string,
	start, end time.Time, loc *time.Location) (store.Resource, error) {
	resources, err := s.st.ListResources(ctx, tenant, false)
	if err != nil {
		return store.Resource{}, fail(err)
	}
	if len(resources) == 0 {
		return store.Resource{}, status.Error(codes.FailedPrecondition,
			"there is nothing set up that can be booked yet")
	}

	if wanted != "" {
		id, err := uuid.Parse(wanted)
		if err != nil {
			return store.Resource{}, status.Error(codes.InvalidArgument, "resource_id must be a UUID")
		}
		for _, r := range resources {
			if r.ID == id {
				// Checked here so the caller gets "we are closed then" rather
				// than "that time is taken", which are different problems with
				// different answers.
				if !slots.WithinOpening(toSlotResource(r), start, end, loc) {
					return store.Resource{}, status.Error(codes.FailedPrecondition,
						"that is outside the hours this is available")
				}
				return r, nil
			}
		}
		return store.Resource{}, status.Error(codes.NotFound, "no such resource")
	}

	anyOpen := false
	for _, r := range resources {
		if !slots.WithinOpening(toSlotResource(r), start, end, loc) {
			continue
		}
		anyOpen = true
		busy, err := s.st.Busy(ctx, tenant, r.ID, start, end)
		if err != nil {
			return store.Resource{}, fail(err)
		}
		if slots.Fits(int(r.Capacity), busy, start, end) {
			// Still re-checked under the lock when the row is written. This is
			// a way of choosing, not a guarantee: between here and the insert,
			// somebody else can take it.
			return r, nil
		}
	}
	// Closed and full are different answers, and a customer deserves the right
	// one: "we are shut then" is actionable and "we are full" is a reason to
	// look at another time.
	if !anyOpen {
		return store.Resource{}, status.Error(codes.FailedPrecondition,
			"the business is not open then")
	}
	return store.Resource{}, status.Error(codes.FailedPrecondition,
		"nothing is free at that time")
}

func toSlotResource(r store.Resource) slots.Resource {
	return slots.Resource{
		ID: r.ID.String(), Name: r.Name, Capacity: int(r.Capacity), Opening: r.Opening,
	}
}

func (s *server) Get(ctx context.Context, req *pb.GetRequest) (*pb.GetResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	b, err := s.st.Booking(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetResponse{Booking: bookingPB(b)}, nil
}

func (s *server) List(ctx context.Context, req *pb.ListRequest) (*pb.ListResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 1000 {
		size = 500
	}
	f := store.Filter{Status: statusName(req.GetStatus()), Limit: size}
	if t := req.GetFrom(); t.IsValid() {
		at := t.AsTime()
		f.From = &at
	}
	if t := req.GetTo(); t.IsValid() {
		at := t.AsTime()
		f.To = &at
	}
	if req.GetResourceId() != "" {
		id, err := uuid.Parse(req.GetResourceId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "resource_id must be a UUID")
		}
		f.ResourceID = &id
	}
	list, err := s.st.List(ctx, tenant, f)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListResponse{}
	for _, b := range list {
		resp.Bookings = append(resp.Bookings, bookingPB(b))
	}
	return resp, nil
}

func (s *server) Reschedule(ctx context.Context, req *pb.RescheduleRequest) (*pb.RescheduleResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	current, err := s.st.Booking(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	start := current.StartsAt
	if t := req.GetStartsAt(); t.IsValid() {
		start = t.AsTime()
	}
	// The length stays what it was. A reschedule moves a booking; changing what
	// was booked is a different act with a different price.
	end := start.Add(current.EndsAt.Sub(current.StartsAt))

	resourceID := current.ResourceID
	if req.GetResourceId() != "" {
		parsed, err := uuid.Parse(req.GetResourceId())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "resource_id must be a UUID")
		}
		resourceID = parsed
	}
	loc, err := s.zone(ctx)
	if err != nil {
		return nil, err
	}
	resource, err := s.st.Resource(ctx, tenant, resourceID)
	if err != nil {
		return nil, fail(err)
	}
	if !slots.WithinOpening(toSlotResource(resource), start, end, loc) {
		return nil, status.Error(codes.FailedPrecondition,
			"that is outside the hours this is available")
	}

	out, err := s.st.Reschedule(ctx, tenant, id, resourceID, start, end)
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("booking moved", "tenant", tenant, "reference", out.Reference,
		"starts", out.StartsAt)
	return &pb.RescheduleResponse{Booking: bookingPB(out)}, nil
}

func (s *server) SetStatus(ctx context.Context, req *pb.SetStatusRequest) (*pb.SetStatusResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	to := statusName(req.GetStatus())
	if to == "" {
		return nil, status.Error(codes.InvalidArgument, "say what the booking became")
	}
	out, err := s.st.SetStatus(ctx, tenant, id, to, strings.TrimSpace(req.GetReason()))
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("booking status", "tenant", tenant, "reference", out.Reference, "status", to)
	return &pb.SetStatusResponse{Booking: bookingPB(out)}, nil
}

// reference is what a customer is told on the telephone.
//
// Six characters of the same Crockford alphabet the merchant code uses, and for
// the same reason: I against 1 and O against 0 are misheard and misread, and U
// is out so a random string does not spell something. Short enough to say, and
// unique per tenant rather than globally, which is all it has to be.
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func reference() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		// Never expected. A reference derived from the clock is still unique
		// enough per tenant, and refusing to book because the random source
		// hiccupped would be the wrong trade.
		return fmt.Sprintf("T%05d", time.Now().UnixNano()%100000)
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

func main() {
	addr := flag.String("addr", ":9120", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	catalogAddr := flag.String("catalog", "catalog:9103", "Catalog service address")
	tenantAddr := flag.String("tenant", "tenant:9109", "Tenant service address")
	step := flag.Duration("slot-step", 15*time.Minute, "how far apart offered start times are")
	defaultDuration := flag.Duration("default-duration", 30*time.Minute,
		"how long a bookable item takes when the catalog does not say")
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

	catalogConn, err := grpcx.Dial(*catalogAddr)
	if err != nil {
		slog.Error("dial catalog", "err", err)
		os.Exit(1)
	}
	defer catalogConn.Close()
	tenantConn, err := grpcx.Dial(*tenantAddr)
	if err != nil {
		slog.Error("dial tenant", "err", err)
		os.Exit(1)
	}
	defer tenantConn.Close()

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterBookingsServiceServer(srv, &server{
		st:      st,
		catalog: catalogpb.NewCatalogServiceClient(catalogConn),
		tenant:  tenantpb.NewTenantServiceClient(tenantConn),
		step:    *step, defaultDuration: *defaultDuration,
	})

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		srv.GracefulStop()
	}()

	if err := grpcx.Run(srv, *addr, "bookings"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
