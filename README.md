# HL Leaderboard

A live leaderboard for a group of wallets across **two venues** — Hyperliquid perps
and Robinhood Chain tokens. Click any trader for their positions, PnL and trades
(Hyperliquid) or their token holdings and value (Robinhood Chain).

The group does not all trade in one place, which is the main thing this dashboard
has to get right: a Hyperliquid-only view shows the Robinhood Chain traders as
completely unfunded.

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

## Robinhood Chain (chain id 4663)

Balances come from the [Blockscout explorer](https://robinhoodchain.blockscout.com)
and prices are read straight from each token's on-chain DEX pool via the public RPC.
Both send `access-control-allow-origin: *`, so this stays a static site.

**Why not BasedBot?** `basedbot.app/api` is public and has exactly the right data
(pool addresses, prices, and per-wallet trades via `?maker=`), but it sends **no
CORS header** on either the GET or the OPTIONS preflight — verified on
`/api/prices` and `/api/token/{t}/trades`. A browser on a different origin cannot
read the response, so it is unusable from a static page. Pricing from the pool
directly agrees with BasedBot's own price to ~0.3% and has no third-party
dependency.

**Both AMM generations are live on this chain.** V3-style pools answer `slot0()`;
V2-style pairs revert on it and answer `getReserves()`. Assuming V3 silently
dropped whole holdings — Axel's SBS is a V2 pair worth a few hundred dollars and
showed as "no price" until the fallback was added.

Pools are found by taking the token's top holders from the explorer, keeping the
contracts (the burn address is often holder #1), and confirming each candidate's
`token0()`/`token1()` pair against WETH.

### PnL, rebuilt from on-chain history

Every swap is reconstructed by joining, per transaction hash:

| Source | Gives |
|---|---|
| `/addresses/{a}/token-transfers` | which token moved, and which way |
| `/addresses/{a}/transactions` | native ETH spent (a buy) and gas |
| `/addresses/{a}/internal-transactions` | native ETH received (a sell) |

A buy is a transaction where ETH leaves in the transaction's `value` and tokens
arrive; a sell is the reverse, with proceeds paid back as an internal transaction
from the router. Cost basis is weighted-average per token, realised PnL is booked
on each sell, and both are scoped by the range selector via per-event timestamps.

**Accounting is in ETH**, the quote asset of every pool here, and converted at the
current rate only for display. Blockscout returns `historic_exchange_rate: null`,
so there is no trustworthy per-trade USD rate — ETH-denominated PnL is exact and
needs no price history.

Three guards, each protecting against a wrong number that looked right:

1. **Reconstruction is verified against reality.** The quantity implied by the
   swaps must match the wallet's actual token balance. If it doesn't, PnL is
   withheld and shown as `—`. This is the test BasedBot's pool-scoped feed fails:
   it reports 27 SBS sells against 1 buy — 20.9M more sold than ever bought — which
   yielded a completely credible-looking **−$1,551 realised** in an early draft.
   Reading the chain directly finds **2** buys, quantities balance to zero, and the
   real figure is a **profit**.
2. **Airdrops have unknown cost, not zero cost.** Tokens that arrive as plain
   transfers are tagged and their proceeds excluded from realised PnL. Booking them
   as free manufactured a fake "+$246 profit" for a wallet that had simply been sent
   spam tokens.
3. **Return uses capital deployed, not equity minus PnL.** There is no deposit
   record on-chain, so inferring the stake from current equity ignores top-ups — it
   produced a nonsense **+1481%**. Gross ETH ever spent on buys is the honest
   denominator (+35% for the same wallet).

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
