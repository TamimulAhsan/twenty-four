// Package rules is what a purpose is allowed to be.
//
// This service never sees the bytes. The browser uploads straight to the store,
// which is the point, and the consequence is that everything this service can
// enforce it must enforce before a URL exists rather than after a file arrives.
// A signed URL is a capability: once issued, the only remaining limits are the
// ones written into the signature.
//
// So the allowlist is an allowlist, not a blocklist. A type nobody thought
// about is refused, which is occasionally inconvenient and never dangerous.
package rules

import (
	"fmt"
	"path"
	"strings"
	"time"
)

// Rule is what one purpose permits.
type Rule struct {
	// Content types, exactly. No wildcards: "image/*" would admit image/svg+xml,
	// which is a document that runs script, and the browser decides what a file
	// is by what the store says it is.
	Types []string
	// The largest file this purpose accepts.
	MaxBytes int64
	// How long a read URL lives. A logo on a public storefront is fetched by
	// everyone and can be cached for an hour; a supplier invoice is not.
	ReadTTL time.Duration
	// Whether the object is readable by anyone holding the link, which is what
	// a storefront needs and an attachment must not have.
	Public bool
}

// SVG is deliberately absent from every image rule.
//
// It is an image to a designer and a document with script in it to a browser.
// Serving one from a host that shares an origin with the dashboard is
// cross-site scripting with extra steps, and the fix is not to sanitise it: it
// is to not accept it, because a sanitiser is a thing that is eventually
// out of date.
var rules = map[string]Rule{
	"catalog_image": {
		Types:    []string{"image/jpeg", "image/png", "image/webp", "image/avif"},
		MaxBytes: 8 << 20,
		ReadTTL:  time.Hour,
		Public:   true,
	},
	"brand_logo": {
		Types:    []string{"image/jpeg", "image/png", "image/webp", "image/avif"},
		MaxBytes: 4 << 20,
		ReadTTL:  time.Hour,
		Public:   true,
	},
	"site_asset": {
		Types:    []string{"image/jpeg", "image/png", "image/webp", "image/avif", "video/mp4"},
		MaxBytes: 32 << 20,
		ReadTTL:  time.Hour,
		Public:   true,
	},
	"attachment": {
		Types: []string{
			"application/pdf",
			"image/jpeg", "image/png",
			"text/csv",
		},
		MaxBytes: 16 << 20,
		// Short, and not public. An attachment is a supplier invoice or a signed
		// form: the link is a capability, and a capability that lives an hour is
		// an hour of somebody else being able to read it.
		ReadTTL: 5 * time.Minute,
		Public:  false,
	},
	"ad_creative": {
		Types:    []string{"image/jpeg", "image/png", "image/webp", "video/mp4"},
		MaxBytes: 32 << 20,
		ReadTTL:  time.Hour,
		Public:   true,
	},
}

// For returns the rule for a purpose.
func For(purpose string) (Rule, bool) {
	r, ok := rules[purpose]
	return r, ok
}

// Check refuses an upload before a URL exists for it.
//
// The size is the caller's claim and is checked anyway, because refusing at
// this point produces a sentence a merchant can act on. The store enforces it
// again on the signature, which is what actually stops a caller that lied.
func Check(purpose, contentType string, size int64) error {
	r, ok := For(purpose)
	if !ok {
		return fmt.Errorf("there is nothing here that files of that kind belong to")
	}
	// Content types arrive with parameters attached often enough that comparing
	// the whole header would refuse perfectly ordinary uploads.
	base := strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	allowed := false
	for _, t := range r.Types {
		if t == base {
			allowed = true
			break
		}
	}
	if !allowed {
		return fmt.Errorf("%s is not a kind of file that can be used here", describe(base))
	}
	if size <= 0 {
		return fmt.Errorf("an empty file is not an upload")
	}
	if size > r.MaxBytes {
		return fmt.Errorf("that file is larger than the %s allowed here", megabytes(r.MaxBytes))
	}
	return nil
}

// describe turns a content type into something a merchant recognises, because
// "application/vnd.ms-excel is not a kind of file that can be used here" is a
// sentence written for the wrong reader.
func describe(contentType string) string {
	switch {
	case contentType == "image/svg+xml":
		return "an SVG"
	case contentType == "application/pdf":
		return "a PDF"
	case strings.HasPrefix(contentType, "image/"):
		return "that image format"
	case strings.HasPrefix(contentType, "video/"):
		return "that video format"
	case contentType == "":
		return "a file with no type"
	}
	return "that kind of file"
}

func megabytes(n int64) string {
	return fmt.Sprintf("%d MB", n>>20)
}

// Extension picks the suffix for a storage key from the content type, not from
// the filename.
//
// The filename came from a person and can be anything, including a path, a
// leading dot, or ".png" on a file that is not one. The key is derived, so it
// is derived from something the service decided.
func Extension(contentType string) string {
	switch strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0])) {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/avif":
		return ".avif"
	case "video/mp4":
		return ".mp4"
	case "application/pdf":
		return ".pdf"
	case "text/csv":
		return ".csv"
	}
	return ""
}

// SafeFilename is what the download is called, once everything dangerous about
// a name a person typed has been taken off it.
//
// It is presentation only: the storage key never contains it. What it protects
// is the Content-Disposition header, where a newline or a quote is a header
// injection and a path separator is a suggestion about where to write.
func SafeFilename(name string) string {
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		switch {
		case r < 32, r == 127, r == '"', r == '\\':
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(strings.TrimLeft(name, "."))
	if name == "" {
		return "download"
	}
	if len(name) > 120 {
		name = name[:120]
	}
	return name
}
