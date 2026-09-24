// main.ts — the manager panel. Keeps a local index per playlist (IndexedDB),
// filters/sorts it client-side, and sends bulk edits to the bridge.

import { call, tellHost, YT } from './client';
import { db } from './db';
import { AUTHOR_URL, PAYPAL_URL, SOURCE_URL, WALLETS } from './about';
import type { PlaylistRecord, PlaylistSummary, Video } from '../shared/types';

// ---------- state ----------
type Duration = 'any' | 'short' | 'mid' | 'long';
type Sort = 'added-desc' | 'added-asc' | 'length-desc' | 'length-asc' | 'title' | 'channel';

interface Filter {
  q: string;
  dur: Duration;
  unavailable: boolean;
  watched: boolean;
  dupes: boolean;
  channel: string | null;
}

interface PendingRemove {
  playlistId: string;
  record: PlaylistRecord;
  items: Video[];
  timer: ReturnType<typeof setTimeout>;
}

const PAGE = 100;
const UNDO_MS = 10_000;

const params = new URLSearchParams(location.search);
document.documentElement.dataset['theme'] = params.get('theme') === 'dark' ? 'dark' : 'light';

const state = {
  playlists: [] as PlaylistSummary[],
  current: params.get('list') || 'WL',
  record: null as PlaylistRecord | null,
  view: [] as Video[],
  selected: new Set<string>(),
  filter: { q: '', dur: 'any', unavailable: false, watched: false, dupes: false, channel: null } as Filter,
  sort: 'added-desc' as Sort,
  page: 0,
  syncing: false,
};

/** Selection key: a playlist entry id when we have one, else the video id. */
const key = (v: Video): string => v.setVideoId ?? v.videoId;

// ---------- elements ----------
function $<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const el = {
  playlist: $<HTMLSelectElement>('playlistSelect'),
  sync: $<HTMLButtonElement>('syncBtn'),
  status: $('syncStatus'),
  spinner: $('spinner'),
  search: $<HTMLInputElement>('search'),
  sort: $<HTMLSelectElement>('sort'),
  close: $<HTMLButtonElement>('closeBtn'),
  channelSearch: $<HTMLInputElement>('channelSearch'),
  channelList: $<HTMLUListElement>('channelList'),
  checkAll: $<HTMLInputElement>('checkAll'),
  countLabel: $('countLabel'),
  openSelected: $<HTMLButtonElement>('openSelected'),
  empty: $('empty'),
  scroller: $('scroller'),
  rows: $('rows'),
  pageLabel: $('pageLabel'),
  prevPage: $<HTMLButtonElement>('prevPage'),
  nextPage: $<HTMLButtonElement>('nextPage'),
  selbar: $('selbar'),
  selCount: $('selCount'),
  remove: $<HTMLButtonElement>('removeBtn'),
  move: $<HTMLButtonElement>('moveBtn'),
  copy: $<HTMLButtonElement>('copyBtn'),
  export: $<HTMLButtonElement>('exportBtn'),
  clearSel: $<HTMLButtonElement>('clearSel'),
  progress: $('progress'),
  progressText: $('progressText'),
  barFill: $('barFill'),
  dialog: $<HTMLDialogElement>('pickDialog'),
  pickTitle: $('pickTitle'),
  pickSelect: $<HTMLSelectElement>('pickSelect'),
  pickHint: $('pickHint'),
  toast: $('toast'),
  toastText: $('toastText'),
  toastAction: $<HTMLButtonElement>('toastAction'),
  fUnavailable: $<HTMLInputElement>('fUnavailable'),
  fWatched: $<HTMLInputElement>('fWatched'),
  fDupes: $<HTMLInputElement>('fDupes'),
};

// ---------- helpers ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, ms = 2600, action?: { label: string; onClick: () => void }): void {
  el.toastText.textContent = text;
  el.toastAction.hidden = !action;
  if (action) {
    el.toastAction.textContent = action.label;
    el.toastAction.onclick = action.onClick;
  }
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}

function progress(text: string | null, frac = 0): void {
  if (text === null) {
    el.progress.hidden = true;
    return;
  }
  el.progress.hidden = false;
  el.progressText.textContent = text;
  el.barFill.style.width = `${Math.round(frac * 100)}%`;
}

const fmt = (n: number): string => n.toLocaleString('en-US');
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

// ---------- playlists ----------
async function loadPlaylists(): Promise<void> {
  try {
    state.playlists = await call('listPlaylists', undefined);
  } catch (e) {
    toast(`Could not list playlists: ${errText(e)}`);
    state.playlists = [
      { playlistId: 'WL', title: 'Watch later', count: null },
      { playlistId: 'LL', title: 'Liked videos', count: null },
    ];
  }
  if (!state.playlists.some((p) => p.playlistId === state.current))
    state.playlists.push({ playlistId: state.current, title: state.current, count: null });
  renderPlaylistSelect();
}

function renderPlaylistSelect(): void {
  el.playlist.innerHTML = state.playlists
    .map((p) => `<option value="${esc(p.playlistId)}">${esc(p.title)}${p.count ? ` (${esc(p.count)})` : ''}</option>`)
    .join('');
  el.playlist.value = state.current;
}

async function loadRecord(): Promise<void> {
  state.record = (await db.get(state.current)) ?? null;
  state.selected.clear();
  state.filter.channel = null;
  apply();
}

async function sync(): Promise<void> {
  await commitPending();
  el.sync.disabled = true;
  state.syncing = true;
  el.spinner.hidden = false;
  // A fresh record fills in page by page; the old index stays in IndexedDB until this finishes.
  const draft: PlaylistRecord = { playlistId: state.current, title: '', order: 'manual', videos: [], syncedAt: Date.now() };
  state.record = draft;
  state.selected.clear();
  let lastPaint = 0;
  try {
    const rec = await call('fetchPlaylist', { playlistId: state.current }, (p) => {
      draft.title = p.title;
      draft.order = p.order;
      draft.videos.push(...p.batch);
      const now = Date.now();
      if (draft.videos.length <= PAGE || now - lastPaint > 700) {
        lastPaint = now;
        apply();
      }
    });
    await db.put(rec);
    state.record = rec;
    toast(`Synced ${fmt(rec.videos.length)} videos from ${rec.title}`);
  } catch (e) {
    toast(`Sync failed: ${errText(e)}`, 5000);
    state.record = (await db.get(state.current)) ?? null; // fall back to the last good index
  } finally {
    state.syncing = false;
    el.spinner.hidden = true;
    el.sync.disabled = false;
    apply();
  }
}

// ---------- filtering / sorting ----------
function apply(): void {
  const rec = state.record;
  const f = state.filter;
  const has = Boolean(rec?.videos.length);
  el.empty.hidden = has;
  el.scroller.hidden = !has;
  el.status.textContent = state.syncing
    ? `Loading… ${fmt(rec?.videos.length ?? 0)} so far`
    : rec
      ? `${fmt(rec.videos.length)} videos · synced ${ago(rec.syncedAt)}`
      : 'Not synced';
  for (const b of [el.remove, el.move, el.copy]) b.disabled = state.syncing;

  let list: Video[] = rec?.videos ?? [];
  if (f.dupes) {
    const counts = new Map<string, number>();
    for (const v of list) counts.set(v.videoId, (counts.get(v.videoId) ?? 0) + 1);
    list = list.filter((v) => (counts.get(v.videoId) ?? 0) > 1);
  }
  if (f.unavailable) list = list.filter((v) => !v.playable);
  if (f.watched) list = list.filter((v) => v.watched > 0);
  if (f.dur !== 'any')
    list = list.filter((v) =>
      f.dur === 'short' ? v.seconds > 0 && v.seconds < 240 : f.dur === 'mid' ? v.seconds >= 240 && v.seconds <= 1200 : v.seconds > 1200,
    );
  if (f.channel) list = list.filter((v) => v.channel === f.channel);
  if (f.q) {
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((v) => {
      const hay = `${v.title} ${v.channel}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  // `order` is the sort YouTube used when it returned the list; position stands in for add date.
  const newestFirst = rec?.order === 'newest';
  const byAdded = (a: Video, b: Video) => (newestFirst ? a.pos - b.pos : b.pos - a.pos);
  list = [...list].sort((a, b) => {
    switch (state.sort) {
      case 'added-asc':
        return -byAdded(a, b);
      case 'length-desc':
        return b.seconds - a.seconds;
      case 'length-asc':
        return a.seconds - b.seconds;
      case 'title':
        return a.title.localeCompare(b.title);
      case 'channel':
        return a.channel.localeCompare(b.channel) || a.title.localeCompare(b.title);
      default:
        return byAdded(a, b);
    }
  });

  state.view = list;
  state.page = Math.min(state.page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
  el.countLabel.textContent =
    rec && list.length !== rec.videos.length ? `${fmt(list.length)} of ${fmt(rec.videos.length)} videos` : `${fmt(list.length)} videos`;
  renderChannels();
  renderRows();
  renderSelection();
}

function renderChannels(): void {
  const counts = new Map<string, number>();
  for (const v of state.record?.videos ?? []) if (v.channel) counts.set(v.channel, (counts.get(v.channel) ?? 0) + 1);
  const q = el.channelSearch.value.trim().toLowerCase();
  const items = [...counts.entries()]
    .filter(([name]) => !q || name.toLowerCase().includes(q))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 400);
  el.channelList.innerHTML = items
    .map(
      ([name, n]) =>
        `<li data-ch="${esc(name)}" class="${state.filter.channel === name ? 'on' : ''}"><span class="name">${esc(name)}</span><span class="n">${fmt(n)}</span></li>`,
    )
    .join('');
}

// ---------- paged list (100 per page; filters run over the whole index) ----------
function renderRows(): void {
  const total = state.view.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const start = state.page * PAGE;
  const end = Math.min(total, start + PAGE);
  el.pageLabel.textContent = total ? `${fmt(start + 1)}–${fmt(end)} of ${fmt(total)}` : '';
  el.prevPage.disabled = state.page === 0;
  el.nextPage.disabled = state.page >= pages - 1;

  let html = '';
  for (const v of state.view.slice(start, end)) {
    const k = key(v);
    const sel = state.selected.has(k);
    const sub = v.playable ? esc([v.channel, v.views, v.published].filter(Boolean).join('  ·  ')) : 'Unavailable — deleted or private';
    html += `<div class="row ${sel ? 'sel' : ''} ${v.playable ? '' : 'gone'}" data-k="${esc(k)}">
      <input type="checkbox" ${sel ? 'checked' : ''} aria-label="Select" />
      <div class="thumb">${v.thumb ? `<img loading="lazy" src="${esc(v.thumb)}" alt="" />` : ''}
        ${v.lengthText ? `<span class="len">${esc(v.lengthText)}</span>` : ''}
        ${v.watched ? `<span class="seen" style="width:${v.watched}%"></span>` : ''}</div>
      <div class="meta">
        <div class="title"><a href="${YT}/watch?v=${esc(v.videoId)}&list=${esc(state.current)}" target="_blank" rel="noopener">${esc(v.title)}</a></div>
        <div class="sub">${sub}</div>
      </div></div>`;
  }
  el.rows.innerHTML = html;
}

function gotoPage(n: number): void {
  state.page = n;
  el.scroller.scrollTop = 0;
  renderRows();
}

function renderSelection(): void {
  const n = state.selected.size;
  el.selbar.hidden = n === 0;
  el.openSelected.hidden = n === 0 || n > 30;
  el.selCount.textContent = `${fmt(n)} selected`;
  const visibleSel = state.view.filter((v) => state.selected.has(key(v))).length;
  el.checkAll.checked = state.view.length > 0 && visibleSel === state.view.length;
  el.checkAll.indeterminate = visibleSel > 0 && visibleSel < state.view.length;
}

function syncRowSelection(): void {
  for (const r of el.rows.children) {
    const row = r as HTMLElement;
    const on = state.selected.has(row.dataset['k'] ?? '');
    row.classList.toggle('sel', on);
    (row.firstElementChild as HTMLInputElement).checked = on;
  }
}

// ---------- bulk actions ----------
const selectedVideos = (): Video[] => (state.record?.videos ?? []).filter((v) => state.selected.has(key(v)));
const asRemoveItems = (items: Video[]) => items.map((v) => ({ videoId: v.videoId, setVideoId: v.setVideoId }));

// Remove hides locally first and commits to YouTube after an undo window.
let pendingRemove: PendingRemove | null = null;

async function removeSelected(): Promise<void> {
  const items = selectedVideos();
  const rec = state.record;
  if (!items.length || !rec) return;
  await commitPending(); // one pending batch at a time
  const gone = new Set(items.map(key));
  rec.videos = rec.videos.filter((v) => !gone.has(key(v)));
  await db.put(rec);
  state.selected.clear();
  apply();
  pendingRemove = { playlistId: state.current, record: rec, items, timer: setTimeout(() => void commitPending(), UNDO_MS) };
  toast(`Removed ${fmt(items.length)} video${items.length === 1 ? '' : 's'}`, 0, { label: 'Undo', onClick: () => void undoRemove() });
}

async function undoRemove(): Promise<void> {
  if (!pendingRemove) return;
  const p = pendingRemove;
  pendingRemove = null;
  clearTimeout(p.timer);
  p.record.videos = [...p.record.videos, ...p.items].sort((a, b) => a.pos - b.pos);
  await db.put(p.record);
  if (state.current === p.playlistId) apply();
  toast('Restored — nothing was sent to YouTube');
}

async function commitPending(): Promise<void> {
  if (!pendingRemove) return;
  const p = pendingRemove;
  pendingRemove = null;
  clearTimeout(p.timer);
  el.toast.hidden = true;
  progress(`Removing 0 of ${fmt(p.items.length)}…`, 0);
  try {
    const r = await call('removeVideos', { playlistId: p.playlistId, items: asRemoveItems(p.items) }, (x) =>
      progress(`Removing ${fmt(x.done)} of ${fmt(x.total)}…`, x.done / x.total),
    );
    if (r.failed) toast(`${r.failed} of ${fmt(r.done)} could not be removed — re-sync to check`, 5000);
  } catch (e) {
    toast(`Remove failed: ${errText(e)} — re-sync to check`, 6000);
  } finally {
    progress(null);
  }
}

function pickPlaylist(title: string, hint: string): Promise<string | null> {
  return new Promise((resolve) => {
    el.pickTitle.textContent = title;
    el.pickHint.textContent = hint;
    el.pickSelect.innerHTML = state.playlists
      .filter((p) => p.playlistId !== state.current && p.playlistId !== 'LL')
      .map((p) => `<option value="${esc(p.playlistId)}">${esc(p.title)}</option>`)
      .join('');
    el.dialog.onclose = () => resolve(el.dialog.returnValue === 'ok' ? el.pickSelect.value : null);
    el.dialog.showModal();
  });
}

async function copyOrMove(move: boolean): Promise<void> {
  await commitPending();
  const items = selectedVideos();
  const rec = state.record;
  if (!items.length || !rec) return;
  const target = await pickPlaylist(move ? 'Move to' : 'Copy to', `${fmt(items.length)} videos selected`);
  if (!target) return;
  const targetName = state.playlists.find((p) => p.playlistId === target)?.title ?? target;
  const ids = [...new Set(items.map((v) => v.videoId))];
  progress(`Adding to ${targetName}…`, 0);
  try {
    const add = await call('addVideos', { playlistId: target, videoIds: ids }, (p) =>
      progress(`Adding ${fmt(p.done)} of ${fmt(p.total)} to ${targetName}…`, p.done / p.total),
    );
    if (add.failed) {
      toast(`${add.failed} could not be added — nothing was removed`, 5000);
      return;
    }
    if (move) {
      const r = await call('removeVideos', { playlistId: state.current, items: asRemoveItems(items) }, (p) =>
        progress(`Removing ${fmt(p.done)} of ${fmt(p.total)}…`, p.done / p.total),
      );
      const gone = new Set(items.map(key));
      rec.videos = rec.videos.filter((v) => !gone.has(key(v)));
      await db.put(rec);
      toast(r.failed ? `Moved, but ${r.failed} failed to remove` : `Moved ${fmt(ids.length)} videos to ${targetName}`);
    } else {
      toast(`Copied ${fmt(ids.length)} videos to ${targetName}`);
    }
    state.selected.clear();
  } catch (e) {
    toast(`${move ? 'Move' : 'Copy'} failed: ${errText(e)}`, 5000);
  } finally {
    progress(null);
    apply();
  }
}

function exportCsv(): void {
  const items = state.selected.size ? selectedVideos() : state.view;
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = ['title,channel,duration,url,available'];
  for (const v of items) lines.push([q(v.title), q(v.channel), q(v.lengthText), q(`${YT}/watch?v=${v.videoId}`), String(v.playable)].join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `${(state.record?.title || 'playlist').replace(/[^\w-]+/g, '_')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function closePanel(): Promise<void> {
  await commitPending();
  tellHost({ type: 'close' });
}

function selectAllInView(): void {
  for (const v of state.view) state.selected.add(key(v));
  renderRows();
  renderSelection();
}

// ---------- events ----------
const resetPage = () => {
  state.page = 0;
  apply();
};

el.playlist.addEventListener('change', async () => {
  await commitPending();
  state.current = el.playlist.value;
  await loadRecord();
});
el.sync.addEventListener('click', () => void sync());
el.close.addEventListener('click', () => void closePanel());
el.sort.addEventListener('change', () => {
  state.sort = el.sort.value as Sort;
  resetPage();
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filter.q = el.search.value.trim();
    el.scroller.scrollTop = 0;
    resetPage();
  }, 120);
});
document.querySelectorAll<HTMLInputElement>('input[name=dur]').forEach((r) =>
  r.addEventListener('change', () => {
    state.filter.dur = r.value as Duration;
    resetPage();
  }),
);
el.fUnavailable.addEventListener('change', () => {
  state.filter.unavailable = el.fUnavailable.checked;
  resetPage();
});
el.fWatched.addEventListener('change', () => {
  state.filter.watched = el.fWatched.checked;
  resetPage();
});
el.fDupes.addEventListener('change', () => {
  state.filter.dupes = el.fDupes.checked;
  resetPage();
});
el.channelSearch.addEventListener('input', renderChannels);
el.channelList.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-ch]');
  if (!li) return;
  const ch = li.dataset['ch'] ?? null;
  state.filter.channel = state.filter.channel === ch ? null : ch;
  resetPage();
});

el.prevPage.addEventListener('click', () => gotoPage(state.page - 1));
el.nextPage.addEventListener('click', () => gotoPage(state.page + 1));

let lastClicked: string | null = null;
el.rows.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('a')) return;
  const row = target.closest<HTMLElement>('.row');
  if (!row) return;
  const k = row.dataset['k'] ?? '';
  if (e.shiftKey && lastClicked !== null) {
    const a = state.view.findIndex((v) => key(v) === lastClicked);
    const b = state.view.findIndex((v) => key(v) === k);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (const v of state.view.slice(lo, hi + 1)) state.selected.add(key(v));
  } else if (state.selected.has(k)) {
    state.selected.delete(k);
  } else {
    state.selected.add(k);
  }
  lastClicked = k;
  syncRowSelection();
  renderSelection();
});

el.checkAll.addEventListener('change', () => {
  for (const v of state.view) el.checkAll.checked ? state.selected.add(key(v)) : state.selected.delete(key(v));
  renderRows();
  renderSelection();
});
el.clearSel.addEventListener('click', () => {
  state.selected.clear();
  renderRows();
  renderSelection();
});
el.remove.addEventListener('click', () => void removeSelected());
el.move.addEventListener('click', () => void copyOrMove(true));
el.copy.addEventListener('click', () => void copyOrMove(false));
el.export.addEventListener('click', exportCsv);
el.openSelected.addEventListener('click', () => {
  for (const v of selectedVideos()) window.open(`${YT}/watch?v=${v.videoId}`, '_blank', 'noopener');
});

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
  if (e.key === 'Escape' && !el.dialog.open && !$<HTMLDialogElement>('supportDialog').open) {
    typing ? target.blur() : void closePanel();
    return;
  }
  if (typing) return;
  if (e.key === '/') {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  }
  if (e.key === 'Delete' && state.selected.size && !state.syncing) void removeSelected();
  if (e.key === 'ArrowRight' && !el.nextPage.disabled) gotoPage(state.page + 1);
  if (e.key === 'ArrowLeft' && !el.prevPage.disabled) gotoPage(state.page - 1);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectAllInView();
  }
});

// ---------- boot ----------
function renderAbout(): void {
  $<HTMLAnchorElement>('aboutAuthor').href = AUTHOR_URL;
  $<HTMLAnchorElement>('aboutSource').href = SOURCE_URL;

  const dialog = $<HTMLDialogElement>('supportDialog');
  const open = $<HTMLButtonElement>('aboutDonate');
  const paypal = $<HTMLAnchorElement>('paypalBtn');
  const list = $<HTMLUListElement>('walletList');
  const wallets = WALLETS.filter((w) => w.address && !w.address.includes('…'));
  const hasPaypal = Boolean(PAYPAL_URL) && !PAYPAL_URL.includes('YOUR_HANDLE');

  open.hidden = !hasPaypal && wallets.length === 0;
  paypal.hidden = !hasPaypal;
  paypal.href = PAYPAL_URL;
  list.innerHTML = wallets
    .map(
      (w) => `<li><div><div class="wname">${esc(w.name)}</div><code>${esc(w.address)}</code></div>
        <button class="btn ghost" type="button" data-copy="${esc(w.address)}">Copy</button></li>`,
    )
    .join('');
  list.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset['copy'] ?? '');
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    } catch {
      toast('Copy failed — select the address and copy manually');
    }
  });
  open.addEventListener('click', () => dialog.showModal());
  $<HTMLButtonElement>('supportClose').addEventListener('click', () => dialog.close());
}

void (async () => {
  renderAbout();
  el.sort.value = state.sort;
  await loadPlaylists();
  await loadRecord();
  if (!state.record) el.search.placeholder = 'Sync a playlist first';
})();
