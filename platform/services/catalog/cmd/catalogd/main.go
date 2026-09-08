// Command catalogd serves the Catalog service: what a tenant sells and what it
// costs.
//
// Every other commerce service reads prices from here and none of them keeps a
// copy. That is the whole reason this service exists: the moment two services
// hold prices, the numbers on the receipt and the numbers in the report stop
// matching, and nobody notices until an accountant does.
//
// No handler reads a tenant from its request. The gateway resolved it and the
// interceptor put it on the context; the proto does not even carry the field.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/twentyfour/platform/gen/go/twentyfour/catalog/v1"
	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	"github.com/twentyfour/platform/packages/grpcx"
	"github.com/twentyfour/platform/packages/money"
	"github.com/twentyfour/platform/packages/tenantctx"
	"github.com/twentyfour/platform/services/catalog/internal/store"
)

// maxPageSize caps what a caller can ask for. A till asking for everything is
// normal; a till asking for a million rows is a mistake worth refusing.
const (
	defaultPageSize = 200
	maxPageSize     = 500
)

type server struct {
	pb.UnimplementedCatalogServiceServer
	st *store.Store
}

// --- conversions ------------------------------------------------------------

func kindStr(k pb.ItemKind) string {
	if k == pb.ItemKind_ITEM_KIND_SERVICE {
		return "service"
	}
	return "product"
}

func kindPB(s string) pb.ItemKind {
	if s == "service" {
		return pb.ItemKind_ITEM_KIND_SERVICE
	}
	return pb.ItemKind_ITEM_KIND_PRODUCT
}

func moneyPB(minor int64, currency string) *commonpb.Money {
	return &commonpb.Money{Minor: minor, Currency: currency}
}

func toPB(it store.Item) *pb.Item {
	out := &pb.Item{
		Id: it.ID.String(), Sku: it.SKU, Name: it.Name, Description: it.Description,
		Kind:        kindPB(it.Kind),
		UnitPrice:   moneyPB(it.UnitPriceMinor, it.Currency),
		TaxRate:     &commonpb.TaxRate{BasisPoints: it.TaxBasisPoints},
		TaxIncluded: it.TaxIncluded, TrackStock: it.TrackStock,
		Active: it.Active, DurationMinutes: it.DurationMin,
		CreatedAt: timestamppb.New(it.CreatedAt), UpdatedAt: timestamppb.New(it.UpdatedAt),
	}
	if it.CategoryID != nil {
		out.CategoryId = it.CategoryID.String()
	}
	// Left unset when not recorded, so a caller can tell "no cost recorded"
	// from "costs nothing".
	if it.CostPriceMinor != nil {
		out.CostPrice = moneyPB(*it.CostPriceMinor, it.Currency)
	}
	if it.Colour != nil {
		out.Colour = *it.Colour
	}
	if it.ArchivedAt != nil {
		out.ArchivedAt = timestamppb.New(*it.ArchivedAt)
	}
	return out
}

func categoryPB(c store.Category) *pb.Category {
	return &pb.Category{Id: c.ID.String(), Name: c.Name, Position: c.Position, ItemCount: c.ItemCount}
}

// fail turns a store error into the right gRPC code once, so no handler has to
// remember that a missing row is NotFound and a taken SKU is AlreadyExists.
func fail(err error, what string) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return status.Errorf(codes.NotFound, "no such %s", what)
	case errors.Is(err, store.ErrNoCategory):
		return status.Error(codes.NotFound, "no such category")
	case errors.Is(err, store.ErrSKUTaken):
		return status.Error(codes.AlreadyExists, "that SKU is already in use")
	case errors.Is(err, store.ErrNameTaken):
		return status.Error(codes.AlreadyExists, "a category with that name already exists")
	}
	slog.Error("catalog", "what", what, "err", err)
	return status.Errorf(codes.Internal, "could not read or write %s", what)
}

func parseID(s, what string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, status.Errorf(codes.InvalidArgument, "%s must be a UUID", what)
	}
	return id, nil
}

// --- items ------------------------------------------------------------------

// validate is the one place an item is checked, so create and update cannot
// drift apart on what they will accept.
func validate(it *pb.Item) error {
	if strings.TrimSpace(it.GetName()) == "" {
		return status.Error(codes.InvalidArgument, "an item needs a name")
	}
	price := it.GetUnitPrice()
	if price == nil {
		return status.Error(codes.InvalidArgument, "an item needs a price, including its currency")
	}
	if _, ok := money.Exponent(price.GetCurrency()); !ok {
		return status.Errorf(codes.InvalidArgument, "unknown currency %q", price.GetCurrency())
	}
	if price.GetMinor() < 0 {
		return status.Error(codes.InvalidArgument, "a price cannot be negative")
	}
	if bp := it.GetTaxRate().GetBasisPoints(); bp < 0 || bp > 100_000 {
		return status.Errorf(codes.InvalidArgument, "tax rate %d is out of range", bp)
	}
	if cost := it.GetCostPrice(); cost != nil && cost.GetCurrency() != price.GetCurrency() {
		return status.Error(codes.InvalidArgument, "cost and price must be in the same currency")
	}
	return nil
}

func (s *server) CreateItem(ctx context.Context, req *pb.CreateItemRequest) (*pb.CreateItemResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	in := req.GetItem()
	if in == nil {
		return nil, status.Error(codes.InvalidArgument, "no item supplied")
	}
	if err := validate(in); err != nil {
		return nil, err
	}

	it := store.Item{
		ID: uuid.New(), TenantID: tenant,
		SKU: strings.TrimSpace(in.GetSku()), Name: strings.TrimSpace(in.GetName()),
		Description: in.GetDescription(), Kind: kindStr(in.GetKind()),
		UnitPriceMinor: in.GetUnitPrice().GetMinor(),
		Currency:       in.GetUnitPrice().GetCurrency(),
		TaxBasisPoints: in.GetTaxRate().GetBasisPoints(),
		TaxIncluded:    in.GetTaxIncluded(),
		TrackStock:     in.GetTrackStock(),
		DurationMin:    in.GetDurationMinutes(),
		Active:         in.GetActive(),
	}
	// A SKU is optional to the merchant, but the till scans one. Deriving it
	// from the ID gives every item something scannable without asking.
	if it.SKU == "" {
		it.SKU = strings.ToUpper(it.ID.String()[:8])
	}
	if in.GetCostPrice() != nil {
		v := in.GetCostPrice().GetMinor()
		it.CostPriceMinor = &v
	}
	if c := in.GetColour(); c != "" {
		it.Colour = &c
	}
	if cid := in.GetCategoryId(); cid != "" {
		id, err := parseID(cid, "category_id")
		if err != nil {
			return nil, err
		}
		it.CategoryID = &id
	}

	out, err := s.st.CreateItem(ctx, it)
	if err != nil {
		return nil, fail(err, "item")
	}
	slog.Info("item created", "tenant", tenant, "item", out.ID, "sku", out.SKU)
	return &pb.CreateItemResponse{Item: toPB(out)}, nil
}

func (s *server) GetItem(ctx context.Context, req *pb.GetItemRequest) (*pb.GetItemResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	it, err := s.st.Item(ctx, tenant, id)
	if err != nil {
		return nil, fail(err, "item")
	}
	return &pb.GetItemResponse{Item: toPB(it)}, nil
}

func (s *server) ListItems(ctx context.Context, req *pb.ListItemsRequest) (*pb.ListItemsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	f := store.ItemFilter{
		Search:          strings.TrimSpace(req.GetSearch()),
		IncludeArchived: req.GetIncludeArchived(),
		IncludeInactive: req.GetIncludeInactive(),
		Limit:           int(req.GetPageSize()),
	}
	if f.Limit <= 0 {
		f.Limit = defaultPageSize
	}
	if f.Limit > maxPageSize {
		f.Limit = maxPageSize
	}
	if k := req.GetKind(); k != pb.ItemKind_ITEM_KIND_UNSPECIFIED {
		f.Kind = kindStr(k)
	}
	if cid := req.GetCategoryId(); cid != "" {
		id, err := parseID(cid, "category_id")
		if err != nil {
			return nil, err
		}
		f.CategoryID = &id
	}
	if tok := req.GetPageToken(); tok != "" {
		name, id, err := decodePageToken(tok)
		if err != nil {
			return nil, err
		}
		f.AfterName, f.AfterID = name, id
	}

	// One more than asked for, so "is there another page" is answered by the
	// query rather than by a second count.
	f.Limit++
	items, err := s.st.ListItems(ctx, tenant, f)
	if err != nil {
		return nil, fail(err, "items")
	}
	resp := &pb.ListItemsResponse{}
	if len(items) == f.Limit {
		last := items[len(items)-2]
		items = items[:len(items)-1]
		resp.NextPageToken = encodePageToken(last.Name, last.ID)
	}
	for _, it := range items {
		resp.Items = append(resp.Items, toPB(it))
	}
	return resp, nil
}

func (s *server) UpdateItem(ctx context.Context, req *pb.UpdateItemRequest) (*pb.UpdateItemResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	in := req.GetItem()
	if in == nil {
		return nil, status.Error(codes.InvalidArgument, "no item supplied")
	}
	id, err := parseID(in.GetId(), "id")
	if err != nil {
		return nil, err
	}

	// An empty mask means "replace everything settable", which is what a form
	// submitting the whole object wants. A named mask is a partial edit.
	mask := req.GetUpdateMask()
	full := len(mask) == 0
	want := make(map[string]bool, len(mask))
	for _, f := range mask {
		want[f] = true
	}
	changing := func(field string) bool { return full || want[field] }

	if changing("name") || changing("unit_price") || changing("tax_rate") || changing("cost_price") {
		// Validate against the merged view a full replace would produce. A
		// partial edit of one field still has to leave a coherent item.
		if full {
			if err := validate(in); err != nil {
				return nil, err
			}
		}
	}

	var p store.ItemPatch
	if changing("sku") {
		v := strings.TrimSpace(in.GetSku())
		if v != "" {
			p.SKU = &v
		}
	}
	if changing("name") {
		v := strings.TrimSpace(in.GetName())
		if v == "" {
			return nil, status.Error(codes.InvalidArgument, "an item needs a name")
		}
		p.Name = &v
	}
	if changing("description") {
		v := in.GetDescription()
		p.Description = &v
	}
	if changing("kind") && in.GetKind() != pb.ItemKind_ITEM_KIND_UNSPECIFIED {
		v := kindStr(in.GetKind())
		p.Kind = &v
	}
	if changing("unit_price") && in.GetUnitPrice() != nil {
		if _, ok := money.Exponent(in.GetUnitPrice().GetCurrency()); !ok {
			return nil, status.Errorf(codes.InvalidArgument, "unknown currency %q", in.GetUnitPrice().GetCurrency())
		}
		if in.GetUnitPrice().GetMinor() < 0 {
			return nil, status.Error(codes.InvalidArgument, "a price cannot be negative")
		}
		v, c := in.GetUnitPrice().GetMinor(), in.GetUnitPrice().GetCurrency()
		p.UnitPriceMinor, p.Currency = &v, &c
	}
	if changing("cost_price") {
		// Sending no cost on a field that is being changed clears it, which is
		// how a merchant removes a cost they should not have entered.
		var v *int64
		if c := in.GetCostPrice(); c != nil {
			m := c.GetMinor()
			v = &m
		}
		p.CostPriceMinor = &v
	}
	if changing("tax_rate") && in.GetTaxRate() != nil {
		bp := in.GetTaxRate().GetBasisPoints()
		if bp < 0 || bp > 100_000 {
			return nil, status.Errorf(codes.InvalidArgument, "tax rate %d is out of range", bp)
		}
		p.TaxBasisPoints = &bp
	}
	if changing("tax_included") {
		v := in.GetTaxIncluded()
		p.TaxIncluded = &v
	}
	if changing("category_id") {
		var v *uuid.UUID
		if cid := in.GetCategoryId(); cid != "" {
			id, err := parseID(cid, "category_id")
			if err != nil {
				return nil, err
			}
			v = &id
		}
		p.CategoryID = &v
	}
	if changing("colour") {
		var v *string
		if c := in.GetColour(); c != "" {
			v = &c
		}
		p.Colour = &v
	}
	if changing("track_stock") {
		v := in.GetTrackStock()
		p.TrackStock = &v
	}
	if changing("duration_minutes") {
		v := in.GetDurationMinutes()
		p.DurationMin = &v
	}
	if changing("active") {
		v := in.GetActive()
		p.Active = &v
	}

	out, err := s.st.UpdateItem(ctx, tenant, id, p)
	if err != nil {
		return nil, fail(err, "item")
	}
	return &pb.UpdateItemResponse{Item: toPB(out)}, nil
}

func (s *server) ArchiveItem(ctx context.Context, req *pb.ArchiveItemRequest) (*pb.ArchiveItemResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	it, err := s.st.ArchiveItem(ctx, tenant, id)
	if err != nil {
		return nil, fail(err, "item")
	}
	slog.Info("item archived", "tenant", tenant, "item", id)
	return &pb.ArchiveItemResponse{Item: toPB(it)}, nil
}

// --- pricing ----------------------------------------------------------------

// PriceItems is the call a till makes once per cart.
//
// The arithmetic lives in the pricing package and is deliberately not repeated
// by any caller: rounding per line and summing rounded lines is what makes a
// receipt's lines add up to its total, and a second implementation somewhere
// else would eventually round differently.
func (s *server) PriceItems(ctx context.Context, req *pb.PriceItemsRequest) (*pb.PriceItemsResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	lines := req.GetLines()
	if len(lines) == 0 {
		return nil, status.Error(codes.InvalidArgument, "no lines to price")
	}

	ids := make([]uuid.UUID, 0, len(lines))
	for _, l := range lines {
		id, err := parseID(l.GetItemId(), "item_id")
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	items, err := s.st.ItemsByID(ctx, tenant, ids)
	if err != nil {
		return nil, fail(err, "items")
	}

	resp := &pb.PriceItemsResponse{}
	amounts := make([]money.Amounts, 0, len(lines))
	for i, l := range lines {
		it, ok := items[ids[i]]
		if !ok {
			return nil, status.Errorf(codes.NotFound, "no such item: %s", l.GetItemId())
		}
		// An archived item can still be priced. A refund of something that was
		// withdrawn last week has to be able to work out what it cost.
		a, err := money.PriceLine(money.Line{
			Quantity:       l.GetQuantity(),
			UnitPriceMinor: it.UnitPriceMinor,
			Currency:       it.Currency,
			TaxBasisPoints: it.TaxBasisPoints,
			TaxIncluded:    it.TaxIncluded,
			DiscountMinor:  l.GetDiscountMinor(),
		})
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "line %d (%s): %v", i+1, it.Name, err)
		}
		amounts = append(amounts, a)
		resp.Lines = append(resp.Lines, &pb.PricedLine{
			ItemId: it.ID.String(), Name: it.Name, Quantity: l.GetQuantity(),
			UnitPrice:     moneyPB(it.UnitPriceMinor, it.Currency),
			TaxRate:       &commonpb.TaxRate{BasisPoints: it.TaxBasisPoints},
			DiscountMinor: l.GetDiscountMinor(),
			Gross:         moneyPB(a.GrossMinor, a.Currency),
			Net:           moneyPB(a.NetMinor, a.Currency),
			Tax:           moneyPB(a.TaxMinor, a.Currency),
		})
	}

	total, err := money.Total(amounts)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "%v", err)
	}
	resp.GrossTotal = moneyPB(total.GrossMinor, total.Currency)
	resp.NetTotal = moneyPB(total.NetMinor, total.Currency)
	resp.TaxTotal = moneyPB(total.TaxMinor, total.Currency)
	return resp, nil
}

// --- categories -------------------------------------------------------------

func (s *server) ListCategories(ctx context.Context, req *pb.ListCategoriesRequest) (*pb.ListCategoriesResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	cats, err := s.st.ListCategories(ctx, tenant, req.GetIncludeArchived())
	if err != nil {
		return nil, fail(err, "categories")
	}
	resp := &pb.ListCategoriesResponse{}
	for _, c := range cats {
		resp.Categories = append(resp.Categories, categoryPB(c))
	}
	return resp, nil
}

func (s *server) CreateCategory(ctx context.Context, req *pb.CreateCategoryRequest) (*pb.CreateCategoryResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.GetCategory().GetName())
	if name == "" {
		return nil, status.Error(codes.InvalidArgument, "a category needs a name")
	}
	c, err := s.st.CreateCategory(ctx, store.Category{
		ID: uuid.New(), TenantID: tenant, Name: name,
		Position: req.GetCategory().GetPosition(),
	})
	if err != nil {
		return nil, fail(err, "category")
	}
	return &pb.CreateCategoryResponse{Category: categoryPB(c)}, nil
}

func (s *server) UpdateCategory(ctx context.Context, req *pb.UpdateCategoryRequest) (*pb.UpdateCategoryResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	in := req.GetCategory()
	id, err := parseID(in.GetId(), "id")
	if err != nil {
		return nil, err
	}
	var name *string
	if n := strings.TrimSpace(in.GetName()); n != "" {
		name = &n
	}
	pos := in.GetPosition()
	c, err := s.st.UpdateCategory(ctx, tenant, id, name, &pos)
	if err != nil {
		return nil, fail(err, "category")
	}
	return &pb.UpdateCategoryResponse{Category: categoryPB(c)}, nil
}

func (s *server) ArchiveCategory(ctx context.Context, req *pb.ArchiveCategoryRequest) (*pb.ArchiveCategoryResponse, error) {
	tenant, err := tenantctx.Tenant(ctx)
	if err != nil {
		return nil, err
	}
	id, err := parseID(req.GetId(), "id")
	if err != nil {
		return nil, err
	}
	moved, err := s.st.ArchiveCategory(ctx, tenant, id)
	if err != nil {
		return nil, fail(err, "category")
	}
	slog.Info("category archived", "tenant", tenant, "category", id, "items_uncategorised", moved)
	return &pb.ArchiveCategoryResponse{ItemsUncategorised: moved}, nil
}

func main() {
	addr := flag.String("addr", ":9103", "gRPC listen address")
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "PostgreSQL DSN")
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

	// No exemptions. Every call this service serves belongs to exactly one
	// tenant, and one that arrives without a tenant is a bug upstream.
	srv := grpcx.New(grpcx.Options{})
	pb.RegisterCatalogServiceServer(srv, &server{st: st})

	if err := grpcx.Run(srv, *addr, "catalog"); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}
