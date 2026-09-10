package main

import (
	"encoding/json"
	"net/http"
	"strings"

	mediapb "github.com/twentyfour/platform/gen/go/twentyfour/media/v1"
	"github.com/twentyfour/platform/packages/httpx"
)

// Files, in three steps, because the bytes never come through here.
//
// The browser asks for somewhere to put a file, uploads straight to storage,
// and says it finished. That shape is visible in the API on purpose: an
// endpoint that accepted a multipart body would be an endpoint every product
// photograph in the market passes through, and it would be the thing that falls
// over on the day somebody uploads a video.
func (g *gateway) registerMedia(mux *http.ServeMux) {
	mux.Handle("POST /api/media/uploads", g.authenticated(g.requestUpload))
	mux.Handle("POST /api/media/{id}/confirm", g.authenticated(g.confirmUpload))
	mux.Handle("GET /api/media", g.authenticated(g.listMedia))
	mux.Handle("GET /api/media/{id}", g.authenticated(g.getMedia))
	mux.Handle("GET /api/media/{id}/url", g.authenticated(g.mediaURL))
	mux.Handle("DELETE /api/media/{id}", g.authenticated(g.deleteMedia))
}

var mediaPurposes = map[string]mediapb.Purpose{
	"catalog_image": mediapb.Purpose_PURPOSE_CATALOG_IMAGE,
	"brand_logo":    mediapb.Purpose_PURPOSE_BRAND_LOGO,
	"site_asset":    mediapb.Purpose_PURPOSE_SITE_ASSET,
	"attachment":    mediapb.Purpose_PURPOSE_ATTACHMENT,
	"ad_creative":   mediapb.Purpose_PURPOSE_AD_CREATIVE,
}

var mediaPurposeNames = func() map[mediapb.Purpose]string {
	out := make(map[mediapb.Purpose]string, len(mediaPurposes))
	for name, p := range mediaPurposes {
		out[p] = name
	}
	return out
}()

// Which permission a purpose needs.
//
// Uploading a product photograph is editing the catalog; replacing the
// business's logo is editing the business. They are different acts and a
// merchant who can do the first should not automatically be able to do the
// second, which is what a single "media:upload" permission would have meant.
var mediaPermissions = map[string]string{
	"catalog_image": "catalog:item:update",
	"brand_logo":    "tenant:profile:update",
	"site_asset":    "tenant:profile:update",
	"attachment":    "catalog:item:read",
	"ad_creative":   "marketing:campaign:manage",
}

func mediaJSON(o *mediapb.Object) map[string]any {
	return map[string]any{
		"id":          o.GetId(),
		"purpose":     mediaPurposeNames[o.GetPurpose()],
		"filename":    o.GetFilename(),
		"contentType": o.GetContentType(),
		"sizeBytes":   o.GetSizeBytes(),
		"ready":       o.GetReady(),
		"subjectType": o.GetSubjectType(),
		"subjectId":   o.GetSubjectId(),
		"uploadedBy":  o.GetUploadedBy(),
		"createdAt":   o.GetCreatedAt().AsTime(),
	}
}

func (g *gateway) requestUpload(w http.ResponseWriter, r *http.Request, c caller) {
	var in struct {
		Purpose     string `json:"purpose"`
		Filename    string `json:"filename"`
		ContentType string `json:"contentType"`
		SizeBytes   int64  `json:"sizeBytes"`
		SubjectType string `json:"subjectType"`
		SubjectID   string `json:"subjectId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid, "The request body was not valid JSON.")
		return
	}
	purpose, ok := mediaPurposes[strings.ToLower(in.Purpose)]
	if !ok {
		httpx.Fail(w, r, http.StatusBadRequest, httpx.CodeInvalid,
			"Say what the file is for.")
		return
	}
	if !g.requirePermission(w, r, c, mediaPermissions[strings.ToLower(in.Purpose)]) {
		return
	}
	resp, err := g.media.RequestUpload(g.downstream(r, c), &mediapb.RequestUploadRequest{
		Purpose: purpose, Filename: in.Filename, ContentType: in.ContentType,
		SizeBytes: in.SizeBytes, SubjectType: in.SubjectType, SubjectId: in.SubjectID,
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusCreated, map[string]any{
		"file":      mediaJSON(resp.GetObject()),
		"uploadUrl": resp.GetUploadUrl(),
		"expiresAt": resp.GetExpiresAt().AsTime(),
	})
}

func (g *gateway) confirmUpload(w http.ResponseWriter, r *http.Request, c caller) {
	resp, err := g.media.ConfirmUpload(g.downstream(r, c),
		&mediapb.ConfirmUploadRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, mediaJSON(resp.GetObject()))
}

func (g *gateway) listMedia(w http.ResponseWriter, r *http.Request, c caller) {
	q := r.URL.Query()
	resp, err := g.media.ListObjects(g.downstream(r, c), &mediapb.ListObjectsRequest{
		Purpose:     mediaPurposes[strings.ToLower(q.Get("purpose"))],
		SubjectType: q.Get("subjectType"), SubjectId: q.Get("subjectId"),
	})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(resp.GetObjects()))
	for _, o := range resp.GetObjects() {
		out = append(out, mediaJSON(o))
	}
	httpx.JSON(w, r, http.StatusOK, out)
}

func (g *gateway) getMedia(w http.ResponseWriter, r *http.Request, c caller) {
	resp, err := g.media.GetObject(g.downstream(r, c),
		&mediapb.GetObjectRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, mediaJSON(resp.GetObject()))
}

// mediaURL hands back a signed link rather than redirecting to it.
//
// A redirect would be shorter and would put the signed URL in the browser's
// history and in any referrer that follows. The link is a capability, so it is
// returned as data the caller uses once and drops.
func (g *gateway) mediaURL(w http.ResponseWriter, r *http.Request, c caller) {
	resp, err := g.media.GetDownloadUrl(g.downstream(r, c),
		&mediapb.GetDownloadUrlRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, map[string]any{
		"url": resp.GetUrl(), "expiresAt": resp.GetExpiresAt().AsTime(),
	})
}

func (g *gateway) deleteMedia(w http.ResponseWriter, r *http.Request, c caller) {
	// Read it first, so the permission checked is the one that matches what
	// the file is for. Deleting a logo is not the same act as deleting a
	// product photograph, and the request body of a DELETE cannot say which.
	current, err := g.media.GetObject(g.downstream(r, c),
		&mediapb.GetObjectRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	purpose := mediaPurposeNames[current.GetObject().GetPurpose()]
	if !g.requirePermission(w, r, c, mediaPermissions[purpose]) {
		return
	}
	resp, err := g.media.DeleteObject(g.downstream(r, c),
		&mediapb.DeleteObjectRequest{Id: r.PathValue("id")})
	if err != nil {
		g.failGRPC(w, r, err)
		return
	}
	httpx.JSON(w, r, http.StatusOK, mediaJSON(resp.GetObject()))
}
