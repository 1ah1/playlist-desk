// about.ts — creator, source and support links shown in the panel.
export const AUTHOR_URL = 'https://x.com/SpartA1ah1';
export const SOURCE_URL = 'https://github.com/1ah1/playlist-desk';

/** PayPal.me link. Empty = no PayPal button. */
export const PAYPAL_URL = '';

/** Crypto addresses shown with a Copy button. Entries still containing "…" are hidden. */
export const WALLETS: { name: string; address: string }[] = [
  { name: 'Bitcoin (BTC)', address: 'bc1q6mve0p934u0e5g3pfxtqrdgugxkqauxrdtl6c6' },
  { name: 'Ethereum & EVM chains — ETH, USDC, USDT on Base, BSC, Arbitrum, Polygon', address: '0x6C9Db6c3fde11614b649D9D02cDf991f08Fc4e35' },
  { name: 'Tron — TRX, USDT (TRC-20)', address: 'TSaoa1rUCUGkHRcwxo2kDe6PBtRc6XP5M8' },
];
