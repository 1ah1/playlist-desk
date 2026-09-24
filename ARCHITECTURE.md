# Architecture

## Why an extension, and why the main world

The YouTube Data API returns an empty list for Watch Later (`WL`) and has since 2016,
so any Watch Later tool has to work from inside a signed-in browser session. The page
itself talks to an internal JSON API called InnerTube; the extension talks to the same
API, the same way, from the same origin.

Content scripts normally run in an *isolated world* that cannot see page globals.
`bridge.ts` is declared with `"world": "MAIN"` so it can read `ytcfg` — the config
object the page exposes with the API key, client version, and session context. Those
values are required on every request.

```
┌──────────────────────── youtube.com tab ────────────────────────┐
│                                                                  │
│  bridge.ts (MAIN world)          inject.ts (isolated world)      │
│   • reads ytcfg                   • Playlists button             │
│   • SAPISIDHASH auth              • mounts <iframe>              │
│   • InnerTube calls               • publishes extension origin   │
│         ▲  postMessage                  │                        │
│         │  (origin-checked)             ▼                        │
│  ┌──────┴──────────── <iframe chrome-extension://…/panel/> ────┐ │
│  │  main.ts  ── client.ts (typed RPC) ── db.ts (IndexedDB)     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## Authentication

InnerTube authenticates browser requests with the session cookies plus an
`Authorization: SAPISIDHASH <ts>_<sha1(ts + " " + SAPISID + " " + origin)>` header.
The bridge computes it with `crypto.subtle` from the `SAPISID` cookie, which is
readable from page JavaScript. No credentials are stored, copied, or sent anywhere
except youtube.com.

## Message protocol

The panel is an extension page, so it is cross-origin to YouTube. It talks to the
bridge with `window.parent.postMessage` and the bridge replies with
`event.source.postMessage`. Both sides check `event.origin`:

- `inject.ts` writes the extension's origin to `<html data-ytpm-origin>` at startup.
- `bridge.ts` ignores any message whose origin does not match that value.
- `client.ts` ignores any reply not from `https://www.youtube.com`.

Every request carries an `id`; long jobs stream `{ id, progress }` frames before the
final `{ id, ok, result }`. The shapes are in `src/shared/types.ts`, which is a
type-only module: content scripts are built as self-contained files and must not
import runtime code.

## Reading a playlist

1. `browse` with `browseId: "VL" + playlistId` and the undocumented `params` that
   YouTube's own "show unavailable videos" toggle uses, so deleted/private entries
   are included.
2. Collect every `playlistVideoRenderer` in the response.
3. Find the continuation token, `browse` again with `{ continuation }`, repeat until
   there is none. Each page is streamed to the panel so the first 100 videos render
   while the rest load.

The playlist's selected sort option (`sortFilterSubMenuRenderer`) is read at the same
time and stored as `order`, because position is the only proxy for "date added" the
API gives us and its direction depends on that setting.

### Parsing by key, not by path

InnerTube responses are deeply nested and their structure shifts between A/B layouts
(`gridPlaylistRenderer` vs `lockupViewModel`, several places a continuation token can
live). Hard-coded paths break on every change. The bridge instead uses a generator that
walks the whole tree and yields every value under a given key. Layout changes that
move a renderer survive; only changes to the renderer's own fields need a patch.

## Editing

`browse/edit_playlist` takes a list of actions:

- `ACTION_REMOVE_VIDEO` with `setVideoId` (the entry id; needed when the same video
  appears twice)
- `ACTION_REMOVE_VIDEO_BY_VIDEO_ID` as a fallback
- `ACTION_ADD_VIDEO` with `addedVideoId`

Actions go in batches of 20 with a short pause between batches. Move = add to the
target, then remove from the source only if every add succeeded.

## Undo

Removal is two-phase. The panel drops the rows from its local index immediately and
starts a 10 s timer; the API call happens when the timer fires. Undo restores the
rows and cancels the call. Anything that would leave a pending batch behind — closing
the panel, switching playlists, syncing, starting a move — commits it first.

## Local index

One IndexedDB record per playlist: `{ playlistId, title, order, videos[], syncedAt }`.
Five thousand entries is about a megabyte. Search, filters and sorting run over the
full array; the list is rendered 100 rows at a time so the DOM stays small.

## Build

Vite with three entries — the two content scripts and the panel HTML. Content scripts
are emitted as single files with no chunk imports (Chrome loads them as classic
scripts). `manifest.json` lives in `public/` and is copied through unchanged.
