// db.ts — one IndexedDB store, one record per playlist.

import type { PlaylistRecord } from '../shared/types';

const DB = 'playlist-desk';
const STORE = 'playlists';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'playlistId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  get: (playlistId: string) => tx<PlaylistRecord | undefined>('readonly', (s) => s.get(playlistId)),
  put: (record: PlaylistRecord) => tx<IDBValidKey>('readwrite', (s) => s.put(record)),
  all: () => tx<PlaylistRecord[]>('readonly', (s) => s.getAll()),
};
