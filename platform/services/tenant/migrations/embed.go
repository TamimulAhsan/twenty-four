// Package migrations carries the Tenant service's schema, beside the SQL
// because go:embed cannot reach outside its own directory.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
