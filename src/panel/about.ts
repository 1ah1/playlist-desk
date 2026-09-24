// about.ts — creator, source and support links shown in the panel.
export const AUTHOR_URL = 'https://x.com/SpartA1ah1';
export const SOURCE_URL = 'https://github.com/1ah1/playlist-desk';

/** PayPal.me link. Empty = no PayPal button. */
export const PAYPAL_URL = '';

/** Crypto addresses shown with a Copy button. Entries still containing "…" are hidden. */
export const WALLETS: { name: string; address: string }[] = [
  { name: 'USDT (TRC-20, Tron)', address: 'T…' },
  { name: 'USDC (Base)', address: '0x…' },
];
