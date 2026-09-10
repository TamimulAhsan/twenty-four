// Command notificationd serves the Notification service: the one place a
// message to a person is composed, checked against the tenant's policy, and
// recorded.
//
// It does not talk to a mail server. The architecture rules self-hosted SMTP
// out because deliverability is a full-time job, and the transport belongs
// inside the market-swappable boundary anyway: Hungary and Bangladesh will not
// share an SMS aggregator. So the transport is an interface with one
// implementation in this pass, a development one that records what would have
// been sent and serves it on a page.
//
// That is the same bargain the payments desk makes, and it is defensible for
// the same reason: a transport that always succeeded instantly would let
// callers grow a dependence on synchronous delivery, and the first real
// provider, with its rate limits and its bounces, would break every one of
// them.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/twentyfour/platform/gen/go/twentyfour/notification/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/notification/internal/store"
	"github.com/twentyfour/platform/services/notification/internal/templates"
)

type server struct {
	pb.UnimplementedNotificationServiceServer
	st *store.Store
}

func fail(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return status.Error(codes.NotFound, "no such message")
	}
	slog.Error("notification", "err", err)
	return status.Error(codes.Internal, "could not read or write messages")
}

// Wire names for the enums. The database stores the word rather than the
// number: a dump of the deliveries table should be readable without the proto
// file beside it, and an enum renumbered by a careless edit would otherwise
// silently reinterpret history.
func channelName(c pb.Channel) string {
	switch c {
	case pb.Channel_CHANNEL_EMAIL:
		return "email"
	case pb.Channel_CHANNEL_SMS:
		return "sms"
	case pb.Channel_CHANNEL_PUSH:
		return "push"
	}
	return ""
}

func channelPB(s string) pb.Channel {
	switch s {
	case "email":
		return pb.Channel_CHANNEL_EMAIL
	case "sms":
		return pb.Channel_CHANNEL_SMS
	case "push":
		return pb.Channel_CHANNEL_PUSH
	}
	return pb.Channel_CHANNEL_UNSPECIFIED
}

func categoryName(c pb.Category) string {
	switch c {
	case pb.Category_CATEGORY_TRANSACTIONAL:
		return "transactional"
	case pb.Category_CATEGORY_RECEIPT:
		return "receipt"
	case pb.Category_CATEGORY_REMINDER:
		return "reminder"
	case pb.Category_CATEGORY_OPERATIONAL:
		return "operational"
	case pb.Category_CATEGORY_MARKETING:
		return "marketing"
	}
	return ""
}

func categoryPB(s string) pb.Category {
	switch s {
	case "transactional":
		return pb.Category_CATEGORY_TRANSACTIONAL
	case "receipt":
		return pb.Category_CATEGORY_RECEIPT
	case "reminder":
		return pb.Category_CATEGORY_REMINDER
	case "operational":
		return pb.Category_CATEGORY_OPERATIONAL
	case "marketing":
		return pb.Category_CATEGORY_MARKETING
	}
	return pb.Category_CATEGORY_UNSPECIFIED
}

func statusName(s pb.Status) string {
	switch s {
	case pb.Status_STATUS_QUEUED:
		return "queued"
	case pb.Status_STATUS_HELD:
		return "held"
	case pb.Status_STATUS_SENT:
		return "sent"
	case pb.Status_STATUS_FAILED:
		return "failed"
	case pb.Status_STATUS_SUPPRESSED:
		return "suppressed"
	}
	return ""
}

func statusPB(s string) pb.Status {
	switch s {
	case "queued":
		return pb.Status_STATUS_QUEUED
	case "held":
		return pb.Status_STATUS_HELD
	case "sent":
		return pb.Status_STATUS_SENT
	case "failed":
		return pb.Status_STATUS_FAILED
	case "suppressed":
		return pb.Status_STATUS_SUPPRESSED
	}
	return pb.Status_STATUS_UNSPECIFIED
}

func deliveryPB(d store.Delivery) *pb.Delivery {
	out := &pb.Delivery{
		Id: d.ID.String(), TemplateKey: d.TemplateKey,
		Channel: channelPB(d.Channel), Category: categoryPB(d.Category),
		Status: statusPB(d.Status), Recipient: d.Recipient,
		Subject: d.Subject, Body: d.Body,
		ReferenceType: d.ReferenceType, ReferenceId: d.ReferenceID,
		FailureReason: d.FailureReason,
		CreatedAt:     timestamppb.New(d.CreatedAt),
	}
	if d.DeliverAfter != nil {
		out.DeliverAfter = timestamppb.New(*d.DeliverAfter)
	}
	if d.SentAt != nil {
		out.SentAt = timestamppb.New(*d.SentAt)
	}
	return out
}

func prefsPB(p store.Preferences) *pb.Preferences {
	out := &pb.Preferences{
		QuietFrom: p.QuietFrom, QuietTo: p.QuietTo, TimeZone: p.TimeZone,
		BookingReminders: p.BookingReminders, ReceiptByEmail: p.ReceiptByEmail,
		Marketing: p.Marketing,
	}
	for _, c := range p.Channels {
		out.Channels = append(out.Channels, channelPB(c))
	}
	return out
}

// resolve picks the wording for a message: the tenant's override if it wrote
// one, the platform's otherwise.
func (s *server) resolve(ctx context.Context, tenantID uuid.UUID, key string) (store.Template, error) {
	t, err := s.st.Template(ctx, tenantID, key)
	if err == nil {
		return t, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return store.Template{}, err
	}
	d, ok := templates.Builtin(key)
	if !ok {
		return store.Template{}, status.Errorf(codes.NotFound,
			"there is no message template called %q", key)
	}
	return store.Template{
		Key: d.Key, Channel: d.Channel, Category: d.Category,
		Subject: d.Subject, Body: d.Body,
	}, nil
}

func (s *server) Send(ctx context.Context, req *pb.SendRequest) (*pb.SendResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(req.GetTemplateKey())
	if key == "" {
		return nil, status.Error(codes.InvalidArgument, "a message needs a template")
	}
	recipient := strings.TrimSpace(req.GetRecipient())
	if recipient == "" {
		return nil, status.Error(codes.InvalidArgument, "a message needs somewhere to go")
	}

	tpl, err := s.resolve(ctx, tenant, key)
	if err != nil {
		return nil, err
	}
	// The request may override the channel and category, but the template's own
	// are the default. A caller that has to restate them on every send is a
	// caller that will eventually restate one of them wrongly.
	channel := channelName(req.GetChannel())
	if channel == "" {
		channel = tpl.Channel
	}
	category := categoryName(req.GetCategory())
	if category == "" {
		category = tpl.Category
	}

	prefs, err := s.st.Preferences(ctx, tenant)
	if err != nil {
		return nil, fail(err)
	}

	subject := templates.Render(tpl.Subject, req.GetParams())
	body := templates.Render(tpl.Body, req.GetParams())
	if missing := templates.Missing(tpl.Subject, tpl.Body, req.GetParams()); len(missing) > 0 {
		// Logged, not refused. A receipt with a blank line is worth sending; a
		// sale that fails because a template gained a placeholder nobody
		// noticed is not.
		slog.Warn("message sent with unfilled placeholders",
			"template", key, "missing", strings.Join(missing, ","), "tenant", tenant)
	}

	d := store.Delivery{
		TenantID: tenant, TemplateKey: key, Channel: channel, Category: category,
		Recipient: recipient, Subject: subject, Body: body,
		ReferenceType: req.GetReferenceType(), ReferenceID: req.GetReferenceId(),
		IdempotencyKey: req.GetIdempotencyKey(),
	}

	if allowed, why := prefs.Allows(channel, category); !allowed {
		// Recorded rather than dropped. "We never sent it, and here is why" is
		// an answer somebody will need, and a message that vanishes silently is
		// indistinguishable from one the provider lost.
		d.Status = "suppressed"
		d.FailureReason = why
	} else if until := prefs.HeldUntil(time.Now(), category); !until.IsZero() {
		d.Status = "held"
		d.DeliverAfter = &until
	} else {
		d.Status = "queued"
	}

	out, repeat, err := s.st.Enqueue(ctx, d)
	if err != nil {
		return nil, fail(err)
	}
	slog.Info("message accepted", "tenant", tenant, "template", key,
		"channel", channel, "status", out.Status, "repeat", repeat)
	return &pb.SendResponse{Delivery: deliveryPB(out)}, nil
}

func (s *server) ListDeliveries(ctx context.Context, req *pb.ListDeliveriesRequest) (*pb.ListDeliveriesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 200 {
		size = 50
	}
	f := store.DeliveryFilter{
		Status: statusName(req.GetStatus()), Channel: channelName(req.GetChannel()),
		ReferenceType: req.GetReferenceType(), ReferenceID: req.GetReferenceId(),
		Limit: size + 1,
	}
	if tok := req.GetPageToken(); tok != "" {
		created, id, err := decodeToken(tok)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "that page token is not one of ours")
		}
		f.BeforeCreated, f.BeforeID = &created, &id
	}
	list, err := s.st.ListDeliveries(ctx, tenant, f)
	if err != nil {
		return nil, fail(err)
	}
	resp := &pb.ListDeliveriesResponse{}
	if len(list) > size {
		last := list[size-1]
		resp.NextPageToken = encodeToken(last.CreatedAt, last.ID)
		list = list[:size]
	}
	for _, d := range list {
		resp.Deliveries = append(resp.Deliveries, deliveryPB(d))
	}
	return resp, nil
}

func (s *server) GetDelivery(ctx context.Context, req *pb.GetDeliveryRequest) (*pb.GetDeliveryResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(req.GetId())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "id must be a UUID")
	}
	d, err := s.st.Delivery(ctx, tenant, id)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetDeliveryResponse{Delivery: deliveryPB(d)}, nil
}

func (s *server) GetPreferences(ctx context.Context, _ *pb.GetPreferencesRequest) (*pb.GetPreferencesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	p, err := s.st.Preferences(ctx, tenant)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.GetPreferencesResponse{Preferences: prefsPB(p)}, nil
}

func (s *server) UpdatePreferences(ctx context.Context, req *pb.UpdatePreferencesRequest) (*pb.UpdatePreferencesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	in := req.GetPreferences()
	if in == nil {
		return nil, status.Error(codes.InvalidArgument, "there is nothing to change")
	}
	var patch store.PreferencePatch
	for _, field := range req.GetUpdateMask() {
		switch field {
		case "channels":
			chans := make([]string, 0, len(in.GetChannels()))
			for _, c := range in.GetChannels() {
				name := channelName(c)
				if name == "" {
					return nil, status.Error(codes.InvalidArgument, "that is not a channel we know")
				}
				chans = append(chans, name)
			}
			patch.Channels = &chans
		case "quiet_from":
			v := in.GetQuietFrom()
			if !validClock(v) {
				return nil, status.Error(codes.InvalidArgument, "quiet hours are written as HH:MM")
			}
			patch.QuietFrom = &v
		case "quiet_to":
			v := in.GetQuietTo()
			if !validClock(v) {
				return nil, status.Error(codes.InvalidArgument, "quiet hours are written as HH:MM")
			}
			patch.QuietTo = &v
		case "time_zone":
			v := in.GetTimeZone()
			if _, err := time.LoadLocation(v); err != nil {
				return nil, status.Error(codes.InvalidArgument, "that is not a time zone we recognise")
			}
			patch.TimeZone = &v
		case "booking_reminders":
			v := in.GetBookingReminders()
			patch.BookingReminders = &v
		case "receipt_by_email":
			v := in.GetReceiptByEmail()
			patch.ReceiptByEmail = &v
		case "marketing":
			v := in.GetMarketing()
			patch.Marketing = &v
		default:
			return nil, status.Errorf(codes.InvalidArgument, "there is no setting called %q", field)
		}
	}
	p, err := s.st.UpdatePreferences(ctx, tenant, patch)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.UpdatePreferencesResponse{Preferences: prefsPB(p)}, nil
}

func validClock(s string) bool {
	_, err := time.Parse("15:04", s)
	return err == nil
}

func (s *server) ListTemplates(ctx context.Context, _ *pb.ListTemplatesRequest) (*pb.ListTemplatesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	overrides, err := s.st.ListTemplates(ctx, tenant)
	if err != nil {
		return nil, fail(err)
	}
	own := make(map[string]store.Template, len(overrides))
	for _, t := range overrides {
		own[t.Key] = t
	}

	resp := &pb.ListTemplatesResponse{}
	// Every built-in appears, whether or not the tenant has overridden it, so
	// the editor lists what can be sent rather than what happens to have been
	// edited. An override replaces the entry rather than adding a second one.
	for _, d := range templates.All() {
		if t, ok := own[d.Key]; ok {
			resp.Templates = append(resp.Templates, templatePB(t, false))
			continue
		}
		resp.Templates = append(resp.Templates, templatePB(store.Template{
			Key: d.Key, Channel: d.Channel, Category: d.Category,
			Subject: d.Subject, Body: d.Body,
		}, true))
	}
	// A tenant may also write a template the platform has none of, for a
	// message only that business sends.
	for _, t := range overrides {
		if _, builtin := templates.Builtin(t.Key); !builtin {
			resp.Templates = append(resp.Templates, templatePB(t, false))
		}
	}
	return resp, nil
}

func templatePB(t store.Template, builtin bool) *pb.Template {
	out := &pb.Template{
		Key: t.Key, Channel: channelPB(t.Channel), Category: categoryPB(t.Category),
		Subject: t.Subject, Body: t.Body, Builtin: builtin,
		Params: templates.Params(t.Subject, t.Body),
	}
	if !t.UpdatedAt.IsZero() {
		out.UpdatedAt = timestamppb.New(t.UpdatedAt)
	}
	return out
}

func (s *server) UpsertTemplate(ctx context.Context, req *pb.UpsertTemplateRequest) (*pb.UpsertTemplateResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(req.GetKey())
	if key == "" {
		return nil, status.Error(codes.InvalidArgument, "a template needs a key")
	}
	if strings.TrimSpace(req.GetBody()) == "" {
		return nil, status.Error(codes.InvalidArgument, "a template with no body sends nothing")
	}
	t := store.Template{
		Key: key, Channel: channelName(req.GetChannel()),
		Category: categoryName(req.GetCategory()),
		Subject:  req.GetSubject(), Body: req.GetBody(),
	}
	// Fall back to the built-in's classification, so editing the wording of a
	// receipt does not accidentally reclassify it as marketing and suppress it.
	if d, ok := templates.Builtin(key); ok {
		if t.Channel == "" {
			t.Channel = d.Channel
		}
		if t.Category == "" {
			t.Category = d.Category
		}
	}
	if t.Channel == "" || t.Category == "" {
		return nil, status.Error(codes.InvalidArgument,
			"a new template needs a channel and a category")
	}
	out, err := s.st.UpsertTemplate(ctx, tenant, t)
	if err != nil {
		return nil, fail(err)
	}
	return &pb.UpsertTemplateResponse{Template: templatePB(out, false)}, nil
}

func (s *server) DeleteTemplate(ctx context.Context, req *pb.DeleteTemplateRequest) (*pb.DeleteTemplateResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	key := req.GetKey()
	if err := s.st.DeleteTemplate(ctx, tenant, key); err != nil {
		return nil, fail(err)
	}
	// Answer with what sending now uses, which is the platform's text. A caller
	// that deleted an override and got nothing back would have to guess whether
	// the message still exists at all.
	if d, ok := templates.Builtin(key); ok {
		return &pb.DeleteTemplateResponse{Template: templatePB(store.Template{
			Key: d.Key, Channel: d.Channel, Category: d.Category,
			Subject: d.Subject, Body: d.Body,
		}, true)}, nil
	}
	return &pb.DeleteTemplateResponse{}, nil
}

func main() {
	addr := flag.String("addr", ":9112", "gRPC listen address")
	deskAddr := flag.String("desk-addr", ":9113", "HTTP address of the development message desk")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
	interval := flag.Duration("send-interval", 5*time.Second, "how often the sender looks for due messages")
	batch := flag.Int("send-batch", 20, "how many messages one pass sends")
	attempts := flag.Int("max-attempts", 5, "how many times a message is retried before it is given up on")
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

	// The transport. One implementation in this pass; the market-swapped one
	// replaces this line and nothing else.
	transport := &recordingTransport{}
	sender := &sender{st: st, transport: transport, batch: *batch,
		maxAttempts: int32(*attempts), interval: *interval}
	go sender.run(ctx)

	desk := &deskHandler{st: st}
	deskSrv := &http.Server{
		Addr:              *deskAddr,
		Handler:           desk.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		slog.Info("message desk listening", "addr", *deskAddr)
		if err := deskSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("desk", "err", err)
		}
	}()

	srv := grpcx.New(grpcx.Options{})
	pb.RegisterNotificationServiceServer(srv, &server{st: st})

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		<-stop
		cancel()
		shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_ = deskSrv.Shutdown(shutdown)
		srv.GracefulStop()
	}()

	if err := grpcx.Run(srv, *addr, "notification"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
