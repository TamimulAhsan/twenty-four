// Package schema holds the ClickHouse tables the CDC connectors write into.
//
// Not goose, and not the pg package. Those run against PostgreSQL, and this is
// a projection in another store with another dialect. It is also not a
// migration in the usual sense: the tables are derived, so a wrong one is
// dropped and refilled from the source rather than patched in place.
package schema

import (
	"embed"
	"strings"
)

//go:embed *.sql
var files embed.FS

// Statements returns the DDL, one statement at a time, because ClickHouse's
// HTTP interface takes one per request.
func Statements() []string {
	entries, err := files.ReadDir(".")
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		body, err := files.ReadFile(e.Name())
		if err != nil {
			continue
		}
		// Comments come off before the file is split, not after. A semicolon
		// inside a sentence would otherwise cut a comment in half and send
		// the second half to ClickHouse as SQL.
		for _, stmt := range strings.Split(strip(string(body)), ";") {
			if sql := strings.TrimSpace(stmt); sql != "" {
				out = append(out, sql)
			}
		}
	}
	return out
}

// strip removes the comment lines, so that the leading block of prose in each
// file does not arrive at ClickHouse as a statement of its own.
func strip(sql string) string {
	var kept []string
	for _, line := range strings.Split(sql, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}
