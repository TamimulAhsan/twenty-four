package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	bookingspb "github.com/twentyfour/platform/gen/go/twentyfour/bookings/v1"
	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	"github.com/twentyfour/platform/packages/httpx"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// The calendar.
//
// Resources are exposed as resources, not as staff and not as rooms. The
// dashboard renders whatever the term set calls them, which is what lets one
// API serve a salon booking a person and a hotel booking a room.
func (g *gateway) registerBookings(mux *http.ServeMux) {
	mux.Handle("GET /api/bookings", g.authenticated(g.listBookings))
	mux.Handle("POST /api/bookings", g.authenticated(g.createBooking))
	mux.Handle("GET /api/bookings/availability", g.authenticated(g.bookingAvailability))
	mux.Handle("GET /api/bookings/{id}", g.authenticated(g.getBooking))
	mux.Handle("PATCH /api/bookings/{id}", g.authenticated(g.patchBooking))

	mux.Handle("GET /api/bookings/resources", g.authenticated(g.listResources))
	mux.Handle("PUT /api/bookings/resources", g.authenticated(g.putResource))
	mux.Handle("DELETE /api/bookings/resources/{id}", g.authenticated(g.deleteResource))
}

var bookingStatusNames = map[bookingspb.BookingStatus]string{
	bookingspb.BookingStatus_BOOKING_STATUS_CONFIRMED: "confirmed",
	bookingspb.BookingStatus_BOOKING_STATUS_ARRIVED:   "arrived",
	bookingspb.BookingStatus_BOOKING_STATUS_COMPLETED: "completed",
	bookingspb.BookingStatus_BOOKING_STATUS_CANCELLED: "cancelled",
	bookingspb.BookingStatus_BOOKING_STATUS_NO_SHOW:   "no_show",
}

var bookingStatusValues = func() map[string]bookingspb.BookingStatus {
	out := make(map[string]bookingspb.BookingStatus, len(bookingStatusNames))
	for k, v := range bookingStatusNames {
		out[v] = k
	}
	return out
}()

func bookingJSON(b *bookingspb.Booking) map[string]any {
	out := map[string]any{
		"id": b.GetId(), "reference": b.GetReference(),
		"itemId": b.GetItemId(), "itemName": b.GetItemName(),
		// What it was booked on. staffId stays for the calendar's person
		// columns, and is null for a room or a table, which is exactly why the
		// resource is carried too.
		"resourceId":   b.GetResourceId(),
		"customerName": b.GetCustomerName(), "customerPhone": b.GetCustomerPhone(),
		"staffId":  nullable(b.GetStaffId()),
		"startsAt": b.GetStartsAt().AsTime(), "endsAt": b.GetEndsAt().AsTime(),
		"status": bookingStatusNames[b.GetStatus()],
		"note":   b.GetNote(),
		// Null when no deposit was asked for, which is not the same as a
		// deposit of zero: a no-show policy turns on which it was.
		"deposit": nil,
	}
	if d := b.GetDeposit(); d != nil {
		out["deposit"] = moneyJSON(d)
	}
	return out
}

func (g *gateway) listBookings(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "bookings:booking:read") {
		return
	}
	q := r.URL.Query()
	req := &bookingspb.ListRequest{
		ResourceId: q.Get("resourceId"),
		Status:     bookingStatusValues[strings.ToLower(q.Get("status"))],
	}
	if from, ok := parseDay(q.Get("from")); ok {
		req.From = timestamppb.New(from)
	}
	if to, ok := parseDay(q.Get("to")); ok {
		// The calendar asks for a range of days and means the whole of the last
		// one, so the far end is exclusive at midnight after it.
		req.To = timestamppb.New(to.AddDate(0, 0, 1))
	}
	resp, err := g.bookings.List(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetBookings()))
	for _, b := range resp.GetBookings() {
		out = append(out, bookingJSON(b))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) getBooking(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "bookings:booking:read") {
		return
	}
	resp, err := g.bookings.Get(g.downstream(r, c),
		&bookingspb.GetRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, bookingJSON(resp.GetBooking()))
}

func (g *gateway) bookingAvailability(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "bookings:booking:read") {
		return
	}
	q := r.URL.Query()
	resp, err := g.bookings.Availability(g.downstream(r, c), &bookingspb.AvailabilityRequest{
		ItemId: q.Get("itemId"), Date: q.Get("date"), ResourceId: q.Get("resourceId"),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetSlots()))
	for _, s := range resp.GetSlots() {
		out = append(out, map[string]any{
			"startsAt": s.GetStartsAt().AsTime(), "endsAt": s.GetEndsAt().AsTime(),
			"resourceId": s.GetResourceId(), "resourceName": s.GetResourceName(),
		})
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) createBooking(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "bookings:booking:create") {
		return
	}
	var in struct {
		ItemID         string `json:"itemId"`
		ResourceID     string `json:"resourceId"`
		StartsAt       string `json:"startsAt"`
		CustomerName   string `json:"customerName"`
		CustomerPhone  string `json:"customerPhone"`
		CustomerEmail  string `json:"customerEmail"`
		Note           string `json:"note"`
		DepositMinor   *int64 `json:"depositMinor"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	startsAt, err := time.Parse(time.RFC3339, in.StartsAt)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
			"A booking needs a start time.")
		return
	}
	req := &bookingspb.CreateRequest{
		ItemId: in.ItemID, ResourceId: in.ResourceID,
		StartsAt:      timestamppb.New(startsAt),
		CustomerName:  in.CustomerName,
		CustomerPhone: in.CustomerPhone, CustomerEmail: in.CustomerEmail,
		Note: in.Note, IdempotencyKey: in.IdempotencyKey,
	}
	// Only set when the caller actually asked for a deposit. Sending zero would
	// record a deposit of nothing, which is a different fact.
	if in.DepositMinor != nil {
		req.Deposit = &commonpb.Money{Minor: *in.DepositMinor, Currency: g.currency}
	}
	resp, err := g.bookings.Create(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusCreated, bookingJSON(resp.GetBooking()))
}

// patchBooking is both moving a booking and changing its status, because from
// the calendar's side they are one gesture: dragging an appointment moves it,
// clicking a menu item changes it, and both are a PATCH on the same thing.
func (g *gateway) patchBooking(w http.ResponseWriter, r *http.Request, c caller) {
	var in struct {
		StartsAt   string `json:"startsAt"`
		ResourceID string `json:"resourceId"`
		Status     string `json:"status"`
		Reason     string `json:"reason"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}

	ctx := g.downstream(r, c)
	id := r.PathValue("id")

	if in.Status != "" {
		st, ok := bookingStatusValues[strings.ToLower(in.Status)]
		if !ok {
			httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
				"That is not a state a booking can be in.")
			return
		}
		// Cancelling is its own permission. Somebody who can take a booking is
		// not automatically somebody who can cancel one, which is the whole
		// reason bookings.cancel exists separately in the role editor.
		permission := "bookings:booking:update"
		if st == bookingspb.BookingStatus_BOOKING_STATUS_CANCELLED ||
			st == bookingspb.BookingStatus_BOOKING_STATUS_NO_SHOW {
			permission = "bookings:booking:cancel"
		}
		if !g.requirePermission(w, r, c, permission) {
			return
		}
		resp, err := g.bookings.SetStatus(ctx, &bookingspb.SetStatusRequest{
			Id: id, Status: st, Reason: in.Reason,
		})
		if err != nil {
			g.failGRPC(w, r, err)
			return
		}
		httpx.JSON(w, r, http.StatusOK, bookingJSON(resp.GetBooking()))
		return
	}

	if !g.requirePermission(w, r, c, "bookings:booking:update") {
		return
	}
	req := &bookingspb.RescheduleRequest{Id: id, ResourceId: in.ResourceID}
	if in.StartsAt != "" {
		startsAt, err := time.Parse(time.RFC3339, in.StartsAt)
		if err != nil {
			httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
				"That is not a time we can read.")
			return
		}
		req.StartsAt = timestamppb.New(startsAt)
	}
	resp, err := g.bookings.Reschedule(ctx, req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, bookingJSON(resp.GetBooking()))
}

func resourceJSON(r *bookingspb.Resource) map[string]any {
	opening := make([]map[string]any, 0, len(r.GetOpening()))
	for _, w := range r.GetOpening() {
		opening = append(opening, map[string]any{
			"weekday": w.GetWeekday(), "opens": w.GetOpens(), "closes": w.GetCloses(),
		})
	}
	return map[string]any{
		"id": r.GetId(), "name": r.GetName(),
		"staffId":  nullable(r.GetStaffId()),
		"capacity": r.GetCapacity(), "active": r.GetActive(),
		"opening": opening,
	}
}

func (g *gateway) listResources(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "bookings:booking:read") {
		return
	}
	resp, err := g.bookings.ListResources(g.downstream(r, c),
		&bookingspb.ListResourcesRequest{
			IncludeInactive: r.URL.Query().Get("includeInactive") == "true",
		})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetResources()))
	for _, res := range resp.GetResources() {
		out = append(out, resourceJSON(res))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) putResource(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "bookings:resource:manage") {
		return
	}
	var in struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		StaffID  string `json:"staffId"`
		Capacity int32  `json:"capacity"`
		Active   bool   `json:"active"`
		Opening  []struct {
			Weekday int32  `json:"weekday"`
			Opens   string `json:"opens"`
			Closes  string `json:"closes"`
		} `json:"opening"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	req := &bookingspb.PutResourceRequest{
		Id: in.ID, Name: in.Name, StaffId: in.StaffID,
		Capacity: in.Capacity, Active: in.Active,
	}
	for _, o := range in.Opening {
		req.Opening = append(req.Opening, &bookingspb.OpeningWindow{
			Weekday: o.Weekday, Opens: o.Opens, Closes: o.Closes,
		})
	}
	resp, err := g.bookings.PutResource(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, resourceJSON(resp.GetResource()))
}

func (g *gateway) deleteResource(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "bookings:resource:manage") {
		return
	}
	if _, err := g.bookings.DeleteResource(g.downstream(r, c),
		&bookingspb.DeleteResourceRequest{Id: r.PathValue("id")}); err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.NoContent(w)
}
