// bridge.ts — runs in the page's MAIN world so it can read `ytcfg` and call
// YouTube's internal InnerTube API with the user's own session. It answers
// postMessage requests from the panel iframe. Nothing leaves the browser.

import type {
  BridgeProgress,
  BridgeRequest,
  BridgeResults,
  EditResult,
  PlaylistOrder,
  PlaylistRecord,
  PlaylistSummary,
  RemoveItem,
  Video,
  WireReply,
  WireRequest,
} from '../shared/types';

// InnerTube responses are large, undocumented and change shape. We walk them
// by renderer key instead of hard-coding paths, so `any` here is deliberate.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

declare global {
  interface Window {
    ytcfg?: { get?: (key: string) => Json };
    __ytpmBridge?: boolean;
  }
}

const YT = 'https://www.youtube.com';
const cfg = (key: string): Json => window.ytcfg?.get?.(key);

// ---------- auth ----------
function cookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(name + '='))
    ?.slice(name.length + 1);
}

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authHeader(): Promise<string | null> {
  const sapisid = cookie('SAPISID') ?? cookie('__Secure-3PAPISID');
  if (!sapisid) return null;
  const ts = Math.floor(Date.now() / 1000);
  return `SAPISIDHASH ${ts}_${await sha1(`${ts} ${sapisid} ${YT}`)}`;
}

async function innertube(endpoint: string, body: Record<string, unknown>): Promise<Json> {
  const key = cfg('INNERTUBE_API_KEY');
  const context = cfg('INNERTUBE_CONTEXT');
  if (!key || !context) throw new Error('YouTube config not ready — reload the page and try again.');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Origin': YT,
    'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0),
    'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
    'X-Youtube-Client-Version': String(cfg('INNERTUBE_CLIENT_VERSION') ?? '2.20240101.00.00'),
  };
  const pageId = cfg('DELEGATED_SESSION_ID');
  if (pageId) headers['X-Goog-PageId'] = String(pageId);
  const auth = await authHeader();
  if (auth) headers['Authorization'] = auth;

  const res = await fetch(`${YT}/youtubei/v1/${endpoint}?key=${key}&prettyPrint=false`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ context, ...body }),
  });
  if (!res.ok) throw new Error(`YouTube returned ${res.status} for ${endpoint}`);
  return res.json();
}

// ---------- JSON helpers ----------
function* walk(node: Json, key: string): Generator<Json> {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item, key);
    return;
  }
  if (key in node) yield node[key];
  for (const v of Object.values(node)) if (v && typeof v === 'object') yield* walk(v, key);
}

const runsText = (t: Json): string =>
  t?.simpleText ?? t?.runs?.map((r: Json) => r.text).join('') ?? t?.content ?? '';

const first = <T>(it: Iterable<T>): T | undefined => {
  for (const x of it) return x;
  return undefined;
};

/** Token shapes vary; look inside continuationItemRenderer first, then anywhere. */
function firstContinuation(json: Json): string | null {
  for (const c of walk(json, 'continuationItemRenderer'))
    for (const cmd of walk(c, 'continuationCommand')) if (cmd?.token) return cmd.token;
  for (const cmd of walk(json, 'continuationCommand')) if (cmd?.token) return cmd.token;
  return null;
}

function parseVideo(r: Json, pos: number): Video {
  const overlays: Json[] = r.thumbnailOverlays ?? [];
  const resume = overlays.find((o) => o.thumbnailOverlayResumePlaybackRenderer);
  const info: string[] = r.videoInfo?.runs?.map((x: Json) => x.text) ?? [];
  const title = runsText(r.title) || '[Unavailable]';
  return {
    videoId: r.videoId,
    setVideoId: r.setVideoId ?? null,
    title,
    channel: runsText(r.shortBylineText),
    channelId: r.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ?? '',
    seconds: Number(r.lengthSeconds ?? 0),
    lengthText: runsText(r.lengthText),
    thumb: r.thumbnail?.thumbnails?.[0]?.url ?? '',
    playable: r.isPlayable !== false && !/^\[(deleted|private) video\]$/i.test(title),
    views: info.find((t) => /view/i.test(t)) ?? '',
    published: info.find((t) => /ago|Streamed|Premiere/i.test(t)) ?? '',
    watched: resume?.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched ?? 0,
    index: Number(runsText(r.index)) || 0,
    pos,
  };
}

function detectOrder(json: Json, playlistId: string): PlaylistOrder {
  if (playlistId === 'WL' || playlistId === 'LL') return 'newest';
  for (const menu of walk(json, 'sortFilterSubMenuRenderer')) {
    const sel = (menu.subMenuItems ?? []).find((i: Json) => i.selected);
    if (!sel) continue;
    const t = String(sel.title ?? '').toLowerCase();
    if (/newest/.test(t)) return 'newest';
    if (/oldest/.test(t)) return 'oldest';
    return 'manual';
  }
  return 'manual';
}

// ---------- jobs ----------
/** Undocumented browse param that makes YouTube include deleted/private entries. */
const SHOW_UNAVAILABLE = 'wgYCCAA=';

async function fetchPlaylist(
  playlistId: string,
  progress: (p: BridgeProgress['fetchPlaylist']) => void,
): Promise<PlaylistRecord> {
  let json = await innertube('browse', { browseId: 'VL' + playlistId, params: SHOW_UNAVAILABLE });
  if (!first(walk(json, 'playlistVideoRenderer'))) json = await innertube('browse', { browseId: 'VL' + playlistId });

  const title =
    runsText(first(walk(json, 'playlistMetadataRenderer'))?.title) ||
    runsText(first(walk(json, 'pageHeaderViewModel'))?.title) ||
    playlistId;
  const order = detectOrder(json, playlistId);

  const videos: Video[] = [];
  const seen = new Set<string>();
  const absorb = (j: Json): Video[] => {
    const batch: Video[] = [];
    for (const r of walk(j, 'playlistVideoRenderer')) {
      if (!r?.videoId) continue;
      const k: string = r.setVideoId || r.videoId;
      if (seen.has(k)) continue;
      seen.add(k);
      const v = parseVideo(r, videos.length);
      videos.push(v);
      batch.push(v);
    }
    return batch;
  };

  let token = firstContinuation(json);
  progress({ count: videos.length, batch: absorb(json), title, order });
  while (token) {
    json = await innertube('browse', { continuation: token });
    const batch = absorb(json);
    token = firstContinuation(json);
    progress({ count: videos.length, batch, title, order, done: !token });
  }
  return { playlistId, title, order, videos, syncedAt: Date.now() };
}

async function listPlaylists(): Promise<PlaylistSummary[]> {
  const out = new Map<string, PlaylistSummary>([
    ['WL', { playlistId: 'WL', title: 'Watch later', count: null }],
    ['LL', { playlistId: 'LL', title: 'Liked videos', count: null }],
  ]);
  let json = await innertube('browse', { browseId: 'FEplaylist_aggregation' });
  for (let hop = 0; hop < 20; hop++) {
    for (const r of walk(json, 'gridPlaylistRenderer')) {
      if (r.playlistId)
        out.set(r.playlistId, { playlistId: r.playlistId, title: runsText(r.title), count: runsText(r.videoCountShortText) || null });
    }
    for (const r of walk(json, 'lockupViewModel')) {
      if (r.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' && r.contentId)
        out.set(r.contentId, {
          playlistId: r.contentId,
          title: r.metadata?.lockupMetadataViewModel?.title?.content ?? r.contentId,
          count: first([...walk(r, 'thumbnailBadgeViewModel')].map((b: Json) => b.text).filter(Boolean)) ?? null,
        });
    }
    const token = firstContinuation(json);
    if (!token) break;
    json = await innertube('browse', { continuation: token });
  }
  return [...out.values()];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type EditAction =
  | { action: 'ACTION_REMOVE_VIDEO'; setVideoId: string }
  | { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID'; removedVideoId: string }
  | { action: 'ACTION_ADD_VIDEO'; addedVideoId: string };

async function editPlaylist(
  playlistId: string,
  actions: EditAction[],
  progress: (p: BridgeProgress['removeVideos']) => void,
): Promise<EditResult> {
  const BATCH = 20;
  let done = 0;
  let failed = 0;
  for (let i = 0; i < actions.length; i += BATCH) {
    const slice = actions.slice(i, i + BATCH);
    try {
      const res = await innertube('browse/edit_playlist', { playlistId, actions: slice });
      if (res.status && res.status !== 'STATUS_SUCCEEDED') failed += slice.length;
    } catch {
      failed += slice.length;
    }
    done += slice.length;
    progress({ done, total: actions.length });
    if (i + BATCH < actions.length) await sleep(350);
  }
  return { done, failed };
}

const removeActions = (items: RemoveItem[]): EditAction[] =>
  items.map((v) =>
    v.setVideoId
      ? { action: 'ACTION_REMOVE_VIDEO', setVideoId: v.setVideoId }
      : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: v.videoId },
  );

type Handler<K extends BridgeRequest['type']> = (
  payload: Extract<BridgeRequest, { type: K }>['payload'],
  progress: (p: BridgeProgress[K]) => void,
) => Promise<BridgeResults[K]>;

const handlers: { [K in BridgeRequest['type']]: Handler<K> } = {
  ping: async () => ({ ok: true, loggedIn: Boolean(cfg('LOGGED_IN')) }),
  listPlaylists: () => listPlaylists(),
  fetchPlaylist: (p, progress) => fetchPlaylist(p.playlistId, progress),
  removeVideos: (p, progress) => editPlaylist(p.playlistId, removeActions(p.items), progress),
  addVideos: (p, progress) =>
    editPlaylist(p.playlistId, p.videoIds.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id })), progress),
};

// ---------- transport ----------
function main() {
  if (window.__ytpmBridge) return;
  window.__ytpmBridge = true;

  window.addEventListener('message', async (ev: MessageEvent<WireRequest>) => {
    const msg = ev.data;
    if (!msg || msg.ytpm !== 1 || !msg.type || !ev.source) return;
    // Only the extension's own iframe may talk to us; inject.ts publishes its origin.
    const allowed = document.documentElement.dataset['ytpmOrigin'];
    if (!allowed || ev.origin !== allowed) return;

    const source = ev.source as Window;
    const reply = (data: Omit<WireReply, 'ytpm' | 'id'>) => source.postMessage({ ytpm: 1, id: msg.id, ...data }, ev.origin);

    const handler = handlers[msg.type] as Handler<typeof msg.type> | undefined;
    if (!handler) return reply({ ok: false, error: `Unknown request: ${msg.type}` });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(msg.payload as any, (progress) => reply({ progress }));
      reply({ ok: true, result });
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

main();
