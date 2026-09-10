// Package clickhouse is a small read client for ClickHouse's HTTP interface.
//
// A driver would give typed scanning and connection pooling. Neither earns its
// place here: this service issues a handful of aggregate queries and reads a
// handful of rows back, and the HTTP interface already does server-side
// parameter binding, which is the only part that has to be right.
//
// Binding is not a convenience. Every query here is scoped by a tenant id that
// arrived over the network, and a tenant id pasted into SQL is a cross-tenant
// leak one quoting mistake away. Parameters are sent separately and never
// parsed as SQL.
package clickhouse

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	base string
	user string
	pass string
	db   string
	http *http.Client
}

func New(base, user, pass, db string) *Client {
	return &Client{
		base: strings.TrimRight(base, "/"),
		user: user, pass: pass, db: db,
		// Long enough for a cold aggregate over a year, short enough that a
		// wedged connection fails the request rather than the page.
		http: &http.Client{Timeout: 30 * time.Second},
	}
}

// Exec runs a statement that returns nothing. Used for the schema and for
// nothing else: this service does not write rows.
func (c *Client) Exec(ctx context.Context, sql string) error {
	_, err := c.do(ctx, sql, nil)
	return err
}

// Row is one result row, keyed by column name. Values arrive as JSON, so
// integers come back as strings where the column is 64 bit: ClickHouse's JSON
// format quotes them because a float64 cannot hold them, and a money figure
// silently losing its low bits is exactly the failure that would not be
// noticed.
type Row map[string]json.RawMessage

// Query runs a SELECT and returns its rows. Parameters are bound by name and
// referenced in the SQL as {name:Type}.
func (c *Client) Query(ctx context.Context, sql string, params map[string]string) ([]Row, error) {
	body, err := c.do(ctx, sql+"\nFORMAT JSON", params)
	if err != nil {
		return nil, err
	}
	var out struct {
		Data []Row `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("clickhouse: decode: %w", err)
	}
	return out.Data, nil
}

func (c *Client) do(ctx context.Context, sql string, params map[string]string) ([]byte, error) {
	q := url.Values{}
	q.Set("database", c.db)
	for k, v := range params {
		q.Set("param_"+k, v)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.base+"/?"+q.Encode(), strings.NewReader(sql))
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-ClickHouse-User", c.user)
	req.Header.Set("X-ClickHouse-Key", c.pass)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("clickhouse: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("clickhouse: read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		// ClickHouse puts the whole error in the body, and its first line is
		// the useful one. Passing the lot to a log makes the stack trace the
		// message.
		msg := strings.SplitN(strings.TrimSpace(string(body)), "\n", 2)[0]
		return nil, fmt.Errorf("clickhouse: %s: %s", resp.Status, msg)
	}
	return body, nil
}
