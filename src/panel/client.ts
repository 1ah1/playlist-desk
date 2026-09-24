// client.ts — typed RPC to the MAIN-world bridge through the parent window.

import type { BridgeProgress, BridgeRequest, BridgeResults, PanelToHost, WireReply } from '../shared/types';

export const YT = 'https://www.youtube.com';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: unknown) => void;
}
const pending = new Map<number, Pending>();
let seq = 0;

export function call<K extends BridgeRequest['type']>(
  type: K,
  payload: Extract<BridgeRequest, { type: K }>['payload'],
  onProgress?: (p: BridgeProgress[K]) => void,
): Promise<BridgeResults[K]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: onProgress as ((p: unknown) => void) | undefined,
    });
    window.parent.postMessage({ ytpm: 1, id, type, payload }, YT);
  });
}

window.addEventListener('message', (ev: MessageEvent<WireReply>) => {
  if (ev.origin !== YT || ev.data?.ytpm !== 1) return;
  const p = pending.get(ev.data.id);
  if (!p) return;
  if ('progress' in ev.data) return p.onProgress?.(ev.data.progress);
  pending.delete(ev.data.id);
  ev.data.ok ? p.resolve(ev.data.result) : p.reject(new Error(ev.data.error));
});

export const tellHost = (msg: Omit<PanelToHost, 'ytpm'>) => window.parent.postMessage({ ytpm: 1, ...msg }, YT);
