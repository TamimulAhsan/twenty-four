package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/twentyfour/platform/services/media/internal/objects"
	"github.com/twentyfour/platform/services/media/internal/store"
)

// sweeper removes reservations nobody finished.
//
// A row exists from the moment a URL is signed, which is before any bytes
// arrive. Most of those become files. Some do not: the tab was closed, the
// network went, the person changed their mind. Without this the index slowly
// becomes a list of uploads that were started, which is a different and much
// less useful thing than a list of files that exist.
//
// It also deletes the object, because a signed PUT can succeed while the caller
// never comes back to confirm. That is the case that leaves bytes nothing has a
// name for, and nothing else in the platform is in a position to find them.
type sweeper struct {
	st      *store.Store
	objects objects.Store
	every   time.Duration
	after   time.Duration
}

func (s *sweeper) run(ctx context.Context) {
	t := time.NewTicker(s.every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.pass(ctx)
		}
	}
}

func (s *sweeper) pass(ctx context.Context) {
	abandoned, err := s.st.Abandoned(ctx, s.after, 200)
	if err != nil {
		slog.Error("find abandoned uploads", "err", err)
		return
	}
	for _, o := range abandoned {
		// Delete first. If this fails the row stays, and the next pass tries
		// again; the other order would forget the key and leave the bytes
		// permanently unreachable and permanently paid for.
		if err := s.objects.Delete(ctx, o.StorageKey); err != nil && !objects.NotFound(err) {
			slog.Warn("could not remove an abandoned upload", "err", err, "media", o.ID)
			continue
		}
		if err := s.st.Forget(ctx, o.ID); err != nil {
			slog.Error("could not forget an abandoned upload", "err", err, "media", o.ID)
			continue
		}
		slog.Info("abandoned upload swept", "media", o.ID, "purpose", o.Purpose,
			"age", time.Since(o.CreatedAt).Round(time.Minute).String())
	}
}
