package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	catalogpb "github.com/twentyfour/platform/gen/go/twentyfour/catalog/v1"
	commonpb "github.com/twentyfour/platform/gen/go/twentyfour/common/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// The catalog routes.
//
// The gateway translates between two shapes on purpose. The service speaks
// protobuf with a nested Money and a TaxRate message; the dashboard speaks JSON
// with a flat taxBasisPoints and money whose minor units are a string.
//
// Neither should adopt the other. Money as a JSON number is a double by the
// time anything in a browser sees it, and int64 amounts lose their last digits
// silently; money as a string survives. Equally, a service that flattened its
// contract to suit one client's form layout would be shaped by that client
// forever. Translating here is what a gateway is for.
func (g *gateway) registerCatalog(mux *http.ServeMux) {
	mux.Handle("GET /api/catalog/items", g.authenticated(g.listItems))
	mux.Handle("POST /api/catalog/items", g.authenticated(g.createItem))
	mux.Handle("GET /api/catalog/items/{id}", g.authenticated(g.getItem))
	mux.Handle("PATCH /api/catalog/items/{id}", g.authenticated(g.updateItem))
	mux.Handle("DELETE /api/catalog/items/{id}", g.authenticated(g.archiveItem))

	mux.Handle("GET /api/catalog/categories", g.authenticated(g.listCategories))
	mux.Handle("POST /api/catalog/categories", g.authenticated(g.createCategory))
	mux.Handle("PATCH /api/catalog/categories/{id}", g.authenticated(g.updateCategory))
	mux.Handle("DELETE /api/catalog/categories/{id}", g.authenticated(g.archiveCategory))
}

// --- wire shapes ------------------------------------------------------------

// moneyJSON sends minor units as a string. See the note above: a JSON number
// is a double in the browser, and an int64 amount has already lost its last
// digits by the time anything notices.
func moneyJSON(m *commonpb.Money) map[string]any {
	if m == nil {
		return nil
	}
	return map[string]any{
		"minor":    strconv.FormatInt(m.GetMinor(), 10),
		"currency": m.GetCurrency(),
	}
}

func itemJSON(it *catalogpb.Item) map[string]any {
	kind := "product"
	if it.GetKind() == catalogpb.ItemKind_ITEM_KIND_SERVICE {
		kind = "service"
	}
	out := map[string]any{
		"id": it.GetId(), "sku": it.GetSku(), "name": it.GetName(),
		"description": it.GetDescription(), "kind": kind,
		"unitPrice":       moneyJSON(it.GetUnitPrice()),
		"taxBasisPoints":  it.GetTaxRate().GetBasisPoints(),
		"taxIncluded":     it.GetTaxIncluded(),
		"trackStock":      it.GetTrackStock(),
		"active":          it.GetActive(),
		"durationMinutes": it.GetDurationMinutes(),
		// null rather than "" so the dashboard can tell "no category" from a
		// category whose name happens to be empty.
		"categoryId": nullable(it.GetCategoryId()),
		"colour":     nullable(it.GetColour()),
		// null means no cost recorded, which is not a cost of zero.
		"costPrice": moneyJSON(it.GetCostPrice()),
		"archived":  it.GetArchivedAt() != nil,
	}
	return out
}

func categoryJSON(c *catalogpb.Category) map[string]any {
	return map[string]any{
		"id": c.GetId(), "name": c.GetName(),
		"position": c.GetPosition(), "itemCount": c.GetItemCount(),
	}
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// --- request decoding -------------------------------------------------------

// body decodes into a map first so the handler can tell a field that was sent
// as null from one that was not sent at all. A PATCH depends on that
// difference: omitting costPrice must leave it alone, sending null must clear
// it, and a plain struct decode cannot distinguish the two.
func body(r *http.Request) (map[string]json.RawMessage, error) {
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	if err := dec.Decode(&raw); err != nil {
		return nil, errors.New("the request body was not valid JSON")
	}
	return raw, nil
}

// parseMoney accepts minor units as a string or a number. The frontend sends a
// string, which is the correct form; accepting a number too means a curl by
// hand does not need to know that.
func parseMoney(raw json.RawMessage) (*commonpb.Money, error) {
	var m struct {
		Minor    any    `json:"minor"`
		Currency string `json:"currency"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, errors.New("money must be an object with minor and currency")
	}
	if m.Currency == "" {
		return nil, errors.New("money is missing its currency code")
	}
	var minor int64
	switch v := m.Minor.(type) {
	case string:
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%q is not a whole number of minor units", v)
		}
		minor = n
	case float64:
		if v != float64(int64(v)) {
			return nil, errors.New("minor units must be a whole number")
		}
		minor = int64(v)
	default:
		return nil, errors.New("money is missing its minor units")
	}
	return &commonpb.Money{Minor: minor, Currency: strings.ToUpper(m.Currency)}, nil
}

// itemFromBody builds the proto item and the field mask.
//
// The mask names exactly the fields the caller sent, so a PATCH of one field
// changes one field. A POST sends everything and gets an empty mask, which the
// service reads as a full replace.
func (g *gateway) itemFromBody(raw map[string]json.RawMessage) (*catalogpb.Item, []string, error) {
	it := &catalogpb.Item{}
	var mask []string
	var err error

	str := func(key string, set func(string)) {
		if v, ok := raw[key]; ok {
			var s string
			// null on a string field means "clear it", which is an empty
			// string on the wire.
			if string(v) != "null" {
				if e := json.Unmarshal(v, &s); e != nil && err == nil {
					err = fmt.Errorf("%s must be a string", key)
					return
				}
			}
			set(s)
			mask = append(mask, protoName(key))
		}
	}
	num := func(key string, set func(int32)) {
		if v, ok := raw[key]; ok {
			var n int32
			if e := json.Unmarshal(v, &n); e != nil && err == nil {
				err = fmt.Errorf("%s must be a whole number", key)
				return
			}
			set(n)
			mask = append(mask, protoName(key))
		}
	}
	boolean := func(key string, set func(bool)) {
		if v, ok := raw[key]; ok {
			var b bool
			if e := json.Unmarshal(v, &b); e != nil && err == nil {
				err = fmt.Errorf("%s must be true or false", key)
				return
			}
			set(b)
			mask = append(mask, protoName(key))
		}
	}

	str("sku", func(v string) { it.Sku = v })
	str("name", func(v string) { it.Name = v })
	str("description", func(v string) { it.Description = v })
	str("categoryId", func(v string) { it.CategoryId = v })
	str("colour", func(v string) { it.Colour = v })
	str("kind", func(v string) {
		if v == "service" {
			it.Kind = catalogpb.ItemKind_ITEM_KIND_SERVICE
		} else {
			it.Kind = catalogpb.ItemKind_ITEM_KIND_PRODUCT
		}
	})
	num("taxBasisPoints", func(v int32) { it.TaxRate = &commonpb.TaxRate{BasisPoints: v} })
	num("durationMinutes", func(v int32) { it.DurationMinutes = v })
	boolean("taxIncluded", func(v bool) { it.TaxIncluded = v })
	boolean("trackStock", func(v bool) { it.TrackStock = v })
	boolean("active", func(v bool) { it.Active = v })
	if err != nil {
		return nil, nil, err
	}

	if v, ok := raw["unitPrice"]; ok {
		m, e := parseMoney(v)
		if e != nil {
			return nil, nil, fmt.Errorf("unitPrice: %w", e)
		}
		it.UnitPrice = m
		mask = append(mask, "unit_price")
	}
	if v, ok := raw["costPrice"]; ok {
		// null clears the recorded cost. Leaving the field off leaves it alone.
		if string(v) != "null" {
			m, e := parseMoney(v)
			if e != nil {
				return nil, nil, fmt.Errorf("costPrice: %w", e)
			}
			it.CostPrice = m
		}
		mask = append(mask, "cost_price")
	}
	return it, mask, nil
}

// protoName maps the dashboard's camelCase onto the field names the service's
// update mask uses. Keeping the two vocabularies apart is the same seam the
// permission translation uses.
func protoName(jsonKey string) string {
	switch jsonKey {
	case "categoryId":
		return "category_id"
	case "taxBasisPoints":
		return "tax_rate"
	case "taxIncluded":
		return "tax_included"
	case "trackStock":
		return "track_stock"
	case "durationMinutes":
		return "duration_minutes"
	}
	return jsonKey
}

// --- handlers ---------------------------------------------------------------

func (g *gateway) listItems(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:read") {
		return
	}
	q := r.URL.Query()
	req := &catalogpb.ListItemsRequest{
		CategoryId:      q.Get("categoryId"),
		Search:          q.Get("search"),
		IncludeInactive: q.Get("includeInactive") == "true",
		PageToken:       q.Get("pageToken"),
	}
	switch q.Get("kind") {
	case "product":
		req.Kind = catalogpb.ItemKind_ITEM_KIND_PRODUCT
	case "service":
		req.Kind = catalogpb.ItemKind_ITEM_KIND_SERVICE
	}

	resp, err := g.catalog.ListItems(g.downstream(r, c), req)
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	// A list is a list. Pagination lives in a header rather than wrapping the
	// array, because the dashboard reads the body as an array and a wrapper
	// would be a breaking change for a feature nobody is using yet.
	if tok := resp.GetNextPageToken(); tok != "" {
		w.Header().Set("X-Next-Page-Token", tok)
	}
	out := make([]map[string]any, 0, len(resp.GetItems()))
	for _, it := range resp.GetItems() {
		out = append(out, itemJSON(it))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) getItem(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:read") {
		return
	}
	resp, err := g.catalog.GetItem(g.downstream(r, c),
		&catalogpb.GetItemRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, itemJSON(resp.GetItem()))
}

func (g *gateway) createItem(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:create") {
		return
	}
	raw, err := body(r)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, err.Error())
		return
	}
	it, _, err := g.itemFromBody(raw)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, err.Error())
		return
	}
	// A form that does not mention "active" means a live item. Defaulting to
	// false here would create every item invisible to the till.
	if _, ok := raw["active"]; !ok {
		it.Active = true
	}

	resp, err := g.catalog.CreateItem(g.downstream(r, c), &catalogpb.CreateItemRequest{Item: it})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusCreated, itemJSON(resp.GetItem()))
}

func (g *gateway) updateItem(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:update") {
		return
	}
	raw, err := body(r)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, err.Error())
		return
	}
	it, mask, err := g.itemFromBody(raw)
	if err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, err.Error())
		return
	}
	if len(mask) == 0 {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "Nothing to change.")
		return
	}
	it.Id = r.PathValue("id")

	resp, err := g.catalog.UpdateItem(g.downstream(r, c),
		&catalogpb.UpdateItemRequest{Item: it, UpdateMask: mask})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, itemJSON(resp.GetItem()))
}

func (g *gateway) archiveItem(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:archive") {
		return
	}
	if _, err := g.catalog.ArchiveItem(g.downstream(r, c),
		&catalogpb.ArchiveItemRequest{Id: r.PathValue("id")}); err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.NoContent(w)
}

func (g *gateway) listCategories(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:read") {
		return
	}
	resp, err := g.catalog.ListCategories(g.downstream(r, c), &catalogpb.ListCategoriesRequest{})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetCategories()))
	for _, cat := range resp.GetCategories() {
		out = append(out, categoryJSON(cat))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) createCategory(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:create") {
		return
	}
	var in struct {
		Name     string `json:"name"`
		Position int32  `json:"position"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	resp, err := g.catalog.CreateCategory(g.downstream(r, c), &catalogpb.CreateCategoryRequest{
		Category: &catalogpb.Category{Name: in.Name, Position: in.Position},
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusCreated, categoryJSON(resp.GetCategory()))
}

func (g *gateway) updateCategory(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:update") {
		return
	}
	var in struct {
		Name     string `json:"name"`
		Position int32  `json:"position"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	resp, err := g.catalog.UpdateCategory(g.downstream(r, c), &catalogpb.UpdateCategoryRequest{
		Category: &catalogpb.Category{Id: r.PathValue("id"), Name: in.Name, Position: in.Position},
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, categoryJSON(resp.GetCategory()))
}

func (g *gateway) archiveCategory(w http.ResponseWriter, r *http.Request, c caller) {
	if !g.requirePermission(w, r, c, "catalog:item:archive") {
		return
	}
	resp, err := g.catalog.ArchiveCategory(g.downstream(r, c),
		&catalogpb.ArchiveCategoryRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	// The count matters: archiving a shelf silently moving twenty items to
	// uncategorised is a surprise a merchant should be told about.
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"itemsUncategorised": resp.GetItemsUncategorised(),
	})
}
