# HL Leaderboard

A live PnL leaderboard for a group of Hyperliquid wallets. Click any trader to see
their open positions, realised/unrealised PnL, and full trade history.

**Live:** https://boulou1.github.io/hl-leaderboard/

Static site — plain HTML/CSS/JS, no build step, no backend, no API keys. The
Hyperliquid info API returns `access-control-allow-origin: *`, so the browser
queries it directly. Everything is read-only.

## Running locally

```bash
python3 -m http.server 4173 --directory .
```

Then open <http://localhost:4173>.

## Adding or removing a trader

Edit the `TRADERS` array at the top of [`app.js`](app.js):

```js
const TRADERS = [
  { name: "Alberic", address: "0x3df4…" },
];
```

Nothing else needs changing. A wallet with no balance and no trades renders as
"Not funded yet" and starts showing data automatically once it is funded.

## Deploying

Push to `main`; GitHub Pages publishes automatically.

**Bump `?v=N` on both `styles.css` and `app.js` in `index.html` on every deploy.**
Pages serves assets with `cache-control: max-age=600`, so without it browsers run
stale code for up to 10 minutes after a push.

## Data model — three things that are easy to get wrong

These were each verified against the live API, and getting any of them wrong
produces numbers that look plausible but are false.

**1. Equity is not perp + spot.** Under unified margin the spot USDC balance *is*
the collateral backing the perp positions — `spot.total` tracks the perp account
value almost exactly, with `hold ≈ total`. Adding them double-counts every
balance. The dashboard uses `portfolio → accountValueHistory`, which is
Hyperliquid's own account-value figure and already aggregates every venue.

**2. Positions live on many clearinghouses.** Builder-deployed HIP-3 perp DEXes
(`xyz`, `flx`, `vntl`, …) each have their own clearinghouse. `clearinghouseState`
*without* a `dex` argument returns only the main order book, so a trader whose
funds sit on `xyz` looks completely empty. The dashboard scans every venue from
`perpDexs`, so new DEXes are picked up automatically.

**3. `cumFunding` is sign-inverted relative to cash flow.** A *positive*
`cumFunding.sinceOpen` means funding was **paid** (confirmed against `userFunding`,
where the same amount appears negative). It is displayed as a cost.

`pnlHistory` is rebased to zero at the start of each period, so its last point is
the period PnL, already net of deposits and withdrawals.

## Accessibility

Profit/loss uses `#1baf7a` / `#d03b3b`, validated against this page's dark surface:
CVD separation ΔE 9.9 (deuteranopia, target ≥ 8), normal-vision ΔE 31.9
(floor ≥ 15), both ≥ 3:1 contrast. Because red/green is the worst possible
colourblind pair, **colour never carries meaning alone** — every signed figure also
shows an explicit `+`/`−` and a ▲/▼ arrow. The chart has a keyboard-navigable
crosshair (arrow keys) and a table view for every plotted value.

## Privacy

Names are shown; addresses are truncated to `0x3df4…0ad0` in the UI, and
`robots.txt` plus a `noindex` meta tag keep the page out of search results.

Note that truncation is cosmetic: because the browser queries the API directly, the
full addresses are present in `app.js` and therefore visible in page source. Hiding
them entirely would require a server-side proxy. The addresses are public on-chain
regardless — what this avoids is a search-indexable name → wallet mapping.
