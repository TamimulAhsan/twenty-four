package main

import (
	"encoding/base64"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Page tokens carry the last row's sort key, not an offset.
//
// OFFSET pagination shows an item twice, or skips one, whenever a row is
// inserted behind the cursor. A till scrolling its catalogue while a colleague
// adds a product is exactly that case, and "the coffee appeared twice" is the
// kind of bug nobody reports and everybody notices.
//
// The token is opaque to the caller: base64 only so nobody is tempted to
// construct one, not as any kind of protection.
func encodePageToken(name string, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString([]byte(name + "\x00" + id.String()))
}

func decodePageToken(tok string) (string, uuid.UUID, error) {
	bad := status.Error(codes.InvalidArgument, "page_token is not one we issued")
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil {
		return "", uuid.Nil, bad
	}
	// Split at the LAST separator, not the first. A UUID never contains one,
	// so this is unambiguous even if a name somehow does.
	i := strings.LastIndexByte(string(raw), 0)
	if i < 0 {
		return "", uuid.Nil, bad
	}
	name, rest := string(raw[:i]), string(raw[i+1:])
	id, err := uuid.Parse(rest)
	if err != nil {
		return "", uuid.Nil, bad
	}
	return name, id, nil
}
