package rules

import (
	"strings"
	"testing"
)

func TestSVGIsRefusedEverywhere(t *testing.T) {
	// An image to a designer, a document with script in it to a browser.
	// Serving one from a host sharing an origin with the dashboard is
	// cross-site scripting with extra steps, and a sanitiser is a thing that
	// is eventually out of date.
	for purpose := range rules {
		if err := Check(purpose, "image/svg+xml", 1024); err == nil {
			t.Errorf("%s accepted an SVG", purpose)
		}
	}
}

func TestNoRuleUsesAWildcard(t *testing.T) {
	// "image/*" is how SVG gets in without anybody deciding to allow it.
	for purpose, r := range rules {
		for _, ct := range r.Types {
			if strings.Contains(ct, "*") {
				t.Errorf("%s allows %q, which admits whatever the browser decides is an image", purpose, ct)
			}
		}
	}
}

func TestAContentTypeWithParametersIsStillRecognised(t *testing.T) {
	// Browsers send "text/csv; charset=utf-8" often enough that comparing the
	// whole header would refuse perfectly ordinary uploads.
	if err := Check("attachment", "text/csv; charset=utf-8", 100); err != nil {
		t.Fatalf("refused a charset parameter: %v", err)
	}
}

func TestAnUnknownPurposeIsRefusedRatherThanAllowed(t *testing.T) {
	// Fail closed. A purpose nobody wrote rules for has no limits attached, and
	// a caller that can invent one could invent that.
	if err := Check("whatever", "image/png", 10); err == nil {
		t.Fatal("an unknown purpose was allowed to upload")
	}
}

func TestAnEmptyFileIsNotAnUpload(t *testing.T) {
	if err := Check("catalog_image", "image/png", 0); err == nil {
		t.Fatal("zero bytes was accepted")
	}
}

func TestAttachmentsAreNotPublicAndExpireQuickly(t *testing.T) {
	// A supplier invoice is not a logo. The link is a capability, and one that
	// lives an hour is an hour of somebody else being able to read it.
	att, _ := For("attachment")
	logo, _ := For("brand_logo")
	if att.Public {
		t.Fatal("attachments must not be readable by anyone holding the link")
	}
	if att.ReadTTL >= logo.ReadTTL {
		t.Fatalf("an attachment URL lives %s and a logo's %s", att.ReadTTL, logo.ReadTTL)
	}
}

func TestTheExtensionComesFromTheTypeNotTheName(t *testing.T) {
	// The filename came from a person and can claim anything.
	if got := Extension("image/png"); got != ".png" {
		t.Fatalf("got %q", got)
	}
	if got := Extension("application/x-msdownload"); got != "" {
		t.Fatalf("got %q, want nothing for a type no rule allows", got)
	}
}

func TestSafeFilenameStripsWhatWouldBreakAHeader(t *testing.T) {
	cases := map[string]string{
		`../../etc/passwd`:          "passwd",
		"report\r\nSet-Cookie: a=b": "reportSet-Cookie: a=b",
		`say "hello".pdf`:           "say hello.pdf",
		`.hidden`:                   "hidden",
		``:                          "download",
		`C:\Users\x\logo.png`:       "logo.png",
	}
	for in, want := range cases {
		if got := SafeFilename(in); got != want {
			t.Errorf("SafeFilename(%q) = %q, want %q", in, got, want)
		}
	}
}
