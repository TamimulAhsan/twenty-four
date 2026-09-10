package clickhouse

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// Reading values back out of a row.
//
// ClickHouse's JSON format quotes 64-bit integers, because a JSON number is a
// double and a double cannot hold them. Every one of these columns is money in
// minor units or a count, so the quoting is the thing that keeps them exact and
// unquoting them into a float would be the bug it exists to prevent.

// Int reads a required integer column. A missing or null value is an error
// rather than a zero: a sum that failed to arrive and a sum of nothing are
// different answers, and only one of them should reach a merchant.
func Int(r Row, col string) (int64, error) {
	raw, ok := r[col]
	if !ok {
		return 0, fmt.Errorf("clickhouse: no column %q", col)
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return strconv.ParseInt(s, 10, 64)
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, fmt.Errorf("clickhouse: column %q is not an integer: %s", col, raw)
	}
	return n, nil
}

// NullInt reads a nullable integer. The second return says whether there was a
// value at all, which is how "no cost was ever recorded" stays distinct from
// "the cost is zero".
func NullInt(r Row, col string) (int64, bool, error) {
	raw, ok := r[col]
	if !ok || string(raw) == "null" {
		return 0, false, nil
	}
	v, err := Int(r, col)
	return v, err == nil, err
}

// Sum reads an aggregate that ClickHouse returns as null when it summed no
// rows. A day with no sales has takings of zero, not takings unknown, so this
// is the one place a null legitimately becomes a zero.
func Sum(r Row, col string) (int64, error) {
	v, _, err := NullInt(r, col)
	return v, err
}

func String(r Row, col string) string {
	raw, ok := r[col]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

// Time reads a DateTime64 column. ClickHouse renders it without a zone because
// the zone is part of the column's type, so it is parsed as the UTC the schema
// declares.
func Time(r Row, col string) (time.Time, bool) {
	s := String(r, col)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{"2006-01-02 15:04:05.999999999", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
