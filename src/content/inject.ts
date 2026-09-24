// inject.ts — isolated world. Adds a "Playlists" button to YouTube's masthead
// and mounts the manager panel (an extension page in an iframe) over the site.

import type { PanelToHost } from '../shared/types';

const ORIGIN = new URL(chrome.runtime.getURL('')).origin;
const BTN_ID = 'ytpm-open';
const FRAME_ID = 'ytpm-frame';

// Lets bridge.ts verify that messages really come from our iframe.
document.documentElement.dataset['ytpmOrigin'] = ORIGIN;

const currentList = () => new URL(location.href).searchParams.get('list') ?? '';
const isDark = () => document.documentElement.hasAttribute('dark');

function openPanel(): void {
  if (document.getElementById(FRAME_ID)) return;
  const frame = document.createElement('iframe');
  frame.id = FRAME_ID;
  const q = new URLSearchParams({ theme: isDark() ? 'dark' : 'light', list: currentList() });
  frame.src = `${chrome.runtime.getURL('panel/index.html')}?${q}`;
  frame.allow = 'clipboard-write';
  Object.assign(frame.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    border: '0',
    zIndex: '2147483646',
    background: isDark() ? '#0f0f0f' : '#fff',
  });
  document.documentElement.appendChild(frame);
  document.documentElement.style.overflow = 'hidden';
}

function closePanel(): void {
  document.getElementById(FRAME_ID)?.remove();
  document.documentElement.style.overflow = '';
}

window.addEventListener('message', (ev: MessageEvent<PanelToHost>) => {
  if (ev.origin !== ORIGIN || ev.data?.ytpm !== 1) return;
  if (ev.data.type === 'close') closePanel();
  if (ev.data.type === 'navigate') {
    closePanel();
    location.href = ev.data.url;
  }
});

function paint(btn: HTMLButtonElement): void {
  btn.style.color = isDark() ? '#f1f1f1' : '#0f0f0f';
  btn.style.background = isDark() ? '#272727' : '#f2f2f2';
}

/** Mount into the masthead; with `fallback` mount a floating button instead. */
function mountButton(fallback = false): boolean {
  if (document.getElementById(BTN_ID)) return true;
  const host = document.querySelector('ytd-masthead #end, #masthead #end, ytm-masthead #end');
  if (!host && !fallback) return false;

  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.textContent = 'Playlists';
  btn.title = 'Open Playlist Desk (Alt+P)';
  Object.assign(btn.style, {
    font: '500 14px Roboto, Arial, sans-serif',
    border: '0',
    borderRadius: '18px',
    height: '36px',
    padding: '0 14px',
    marginRight: '8px',
    cursor: 'pointer',
  });
  paint(btn);
  btn.addEventListener('click', openPanel);

  if (host) {
    host.prepend(btn);
  } else {
    Object.assign(btn.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: '2147483645',
      background: '#065fd4',
      color: '#fff',
      boxShadow: '0 2px 8px rgba(0,0,0,.35)',
      marginRight: '0',
    });
    document.documentElement.appendChild(btn);
  }
  return true;
}

// YouTube is a SPA: try for ~6 s, then fall back to the floating button.
let tries = 0;
const timer = setInterval(() => {
  if (mountButton()) return clearInterval(timer);
  if (++tries > 12) {
    clearInterval(timer);
    mountButton(true);
  }
}, 500);
document.addEventListener('yt-navigate-finish', () => setTimeout(() => mountButton(), 300));

// Keep the button's colors in sync if the user flips YouTube's theme.
new MutationObserver(() => {
  const btn = document.getElementById(BTN_ID) as HTMLButtonElement | null;
  if (btn && btn.style.position !== 'fixed') paint(btn);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    document.getElementById(FRAME_ID) ? closePanel() : openPanel();
  }
});
