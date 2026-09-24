// Shared contract between the MAIN-world bridge and the panel.
// Type-only module: it must never be imported for runtime values, because
// content scripts are built as self-contained files and cannot load chunks.

export type PlaylistOrder = 'newest' | 'oldest' | 'manual';

export interface Video {
  videoId: string;
  /** Per-entry id inside a playlist. Needed to remove one specific entry. */
  setVideoId: string | null;
  title: string;
  channel: string;
  channelId: string;
  seconds: number;
  lengthText: string;
  thumb: string;
  playable: boolean;
  views: string;
  published: string;
  /** Percent of the video already watched, 0 when unknown. */
  watched: number;
  index: number;
  /** Position in the order YouTube returned the list. */
  pos: number;
}

export interface PlaylistRecord {
  playlistId: string;
  title: string;
  order: PlaylistOrder;
  videos: Video[];
  syncedAt: number;
}

export interface PlaylistSummary {
  playlistId: string;
  title: string;
  count: string | null;
}

export interface RemoveItem {
  videoId: string;
  setVideoId: string | null;
}

export interface FetchProgress {
  count: number;
  batch: Video[];
  title: string;
  order: PlaylistOrder;
  done?: boolean;
}

export interface EditProgress {
  done: number;
  total: number;
}

export interface EditResult {
  done: number;
  failed: number;
}

export type BridgeRequest =
  | { type: 'ping'; payload?: undefined }
  | { type: 'listPlaylists'; payload?: undefined }
  | { type: 'fetchPlaylist'; payload: { playlistId: string } }
  | { type: 'removeVideos'; payload: { playlistId: string; items: RemoveItem[] } }
  | { type: 'addVideos'; payload: { playlistId: string; videoIds: string[] } };

export interface BridgeResults {
  ping: { ok: true; loggedIn: boolean };
  listPlaylists: PlaylistSummary[];
  fetchPlaylist: PlaylistRecord;
  removeVideos: EditResult;
  addVideos: EditResult;
}

export interface BridgeProgress {
  fetchPlaylist: FetchProgress;
  removeVideos: EditProgress;
  addVideos: EditProgress;
  ping: never;
  listPlaylists: never;
}

/** Envelope on the wire (window.postMessage). */
export type WireRequest = BridgeRequest & { ytpm: 1; id: number };
export type WireReply =
  | { ytpm: 1; id: number; ok: true; result: unknown }
  | { ytpm: 1; id: number; ok: false; error: string }
  | { ytpm: 1; id: number; progress: unknown };

/** Messages the panel sends to the isolated-world content script. */
export type PanelToHost = { ytpm: 1; type: 'close' } | { ytpm: 1; type: 'navigate'; url: string };
