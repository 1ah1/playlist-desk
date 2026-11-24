# Changelog

## 1.0.3 — 2026-11-24
- Fix: "Duplicates" now finds videos that are also in another playlist (e.g. in both Watch Later and a custom list), and shows which ones under each video. It used to look for repeats inside the open playlist only, which flagged wrong pairs. Sync the other playlists once so they can be compared. Liked videos is not counted.
- Fix: Watch Later sync can no longer index the same video twice.

## 1.0.2 — 2026-10-11
- Fix: YouTube's new compact metadata ("1.2M · 3y ago") dropped view counts and broke the upload-date sort. Re-sync once to pick views back up.

## 1.0.1 — 2026-10-11
- Custom duration range (min / max minutes) alongside the presets, as requested on Reddit.
- Shorts filter. Detected from the thumbnail shape, so re-sync a playlist once to tag older entries.
- Sort by views (most / least) and by upload date (newest / oldest).

## 1.0.0 — 2026-09-24
- First public release.
