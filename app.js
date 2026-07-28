/* ===========================================================================
   HL Leaderboard — Hyperliquid PnL / positions / trades dashboard.

   Fully client-side: the Hyperliquid info API sends
   `access-control-allow-origin: *`, so the browser can query it directly.
   No backend, no API keys, nothing to leak.

   ---------------------------------------------------------------------------
   Data model notes (each verified against the live API before writing this):

   1. EQUITY IS NOT PERP + SPOT.  Under unified margin the spot USDC balance IS
      the collateral backing the perp positions -- `spot.total` tracks the perp
      account value almost exactly, with `hold` ~= `total`.  Adding them would
      double-count every balance.  `portfolio` -> accountValueHistory is
      Hyperliquid's own authoritative equity figure and already aggregates every
      venue, so that is the single source for equity.

   2. POSITIONS LIVE ON MANY CLEARINGHOUSES.  Builder-deployed HIP-3 perp DEXes
      (xyz, flx, vntl, ...) each have their own clearinghouse; `clearinghouseState`
      without a `dex` returns ONLY the main order book.  A trader whose funds sit
      on `xyz` looks completely empty unless every dex is queried.  The dex list
      is fetched from `perpDexs` at runtime so new venues appear automatically.

   3. pnlHistory IS REBASED TO ZERO per period, so the last point IS the period
      PnL, and it is already net of deposits and withdrawals.
   =========================================================================== */

const API = "https://api.hyperliquid.xyz/info";

/* ---------------------------------------------------------------------------
   Robinhood Chain (EVM, chain id 4663).

   Not everyone in this group trades on Hyperliquid -- some trade tokens on
   Robinhood Chain instead, and a Hyperliquid-only view shows them as unfunded.

   Both sources below send `access-control-allow-origin: *`, so this stays a
   backend-free static site. BasedBot's API is deliberately NOT used: it sends
   no CORS header, so a browser cannot call it. Prices are instead derived
   straight from each token's Uniswap-V3-style pool, which agrees with
   BasedBot's own price to ~0.3%.
   --------------------------------------------------------------------------- */
const RH = {
  name: "Robinhood Chain",
  short: "RH Chain",
  blockscout: "https://robinhoodchain.blockscout.com/api/v2",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  // function selectors. Both AMM generations are in use on this chain: V3-style
  // pools answer slot0(), V2-style pairs revert on it and answer getReserves().
  sel: {
    token0: "0x0dfe1681",
    token1: "0xd21220a7",
    slot0: "0x3850c7bd",
    getReserves: "0x0902f1ac",
  },
  // Dust threshold: below this a holding is noise, not a position.
  dustUsd: 0.01,
};

const TRADERS = [
  { name: "Alberic", address: "0x3df4eb23d7d13e9624c68d7b9c0ec6bb718f0ad0" },
  { name: "Axel",    address: "0x96C19c774bD7D35b1D457492002028DCE719946B" },
  { name: "Nico",    address: "0x5ef3582E18F43eD152522Ca099AC768DeC492733" },
  { name: "Pierre",  address: "0x9BFc3ebC18C87987D5D3136E27EEB238139920Ef" },
  { name: "Sacha",   address: "0x4618f6327bda26e10cd338df651e910a9b0aaef1" },
  { name: "Nelson",  address: "0xea0C29b4FD5DC0F45256f986352c9600b8ec03D1" },
  { name: "Ronan",   address: "0x6a1fa415f652FFCf75C96800148c9774c8Fd6903" },
];

const PERIOD_LABEL = { day: "24H", week: "7D", month: "30D", allTime: "All" };
const REFRESH_MS = 30_000;
const RESCAN_EVERY = 10;   // full multi-dex rescan every Nth refresh

/* ------------------------------------------------------------------ state -- */
const state = {
  period: "allTime",
  metric: "pnl",
  sort: { key: "pnl", dir: "desc" },
  dexes: null,          // null until perpDexs resolves
  byAddress: new Map(), // address -> trader record
  route: { view: "board", address: null },
  refreshCount: 0,
  timer: null,
};

/* -------------------------------------------------------------------- api -- */
async function info(body, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429 && attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(400 * (attempt + 1));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dex list, fetched once. `""` is the main order book. */
async function loadDexes() {
  if (state.dexes) return state.dexes;
  try {
    const list = await info({ type: "perpDexs" });
    // Entries are objects with a `name`; the main dex is a null entry.
    const names = list.map((d) => (d && d.name ? String(d.name) : "")).filter((n, i, a) => a.indexOf(n) === i);
    if (!names.includes("")) names.unshift("");
    state.dexes = names;
  } catch {
    state.dexes = [""];  // degrade to the main book rather than showing nothing
  }
  return state.dexes;
}

/* ------------------------------------------------- Robinhood Chain source -- */
const bsGate = makeGate(4);

async function bsGet(path, retries = 2) {
  return bsGate(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(RH.blockscout + path);
        if (res.ok) return await res.json();
        if (res.status !== 429 || attempt >= retries) throw new Error(`blockscout ${res.status}`);
      } catch (err) {
        if (attempt >= retries) throw err;
      }
      await sleep(400 * (attempt + 1));
    }
  });
}

/**
 * Tiny concurrency gate. The public RPC throttles bursts, and unlimited
 * parallelism silently lost prices for whole tokens (they showed "no price"
 * despite having a perfectly good pool).
 */
function makeGate(max) {
  let active = 0;
  const waiting = [];
  const release = () => { active--; waiting.shift()?.(); };
  return async (fn) => {
    if (active >= max) await new Promise((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { release(); }
  };
}
const rpcGate = makeGate(6);

async function ethCall(to, data, retries = 2) {
  return rpcGate(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(RH.rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        });
        if (res.ok) {
          const j = await res.json();
          return j.result && j.result !== "0x" ? j.result : null;
        }
        if (attempt >= retries) return null;
      } catch {
        if (attempt >= retries) return null;
      }
      await sleep(250 * (attempt + 1));
    }
  });
}

/** Tokens repeat across wallets, so pool lookups and prices are cached. */
const rhPoolCache = new Map();   // token -> {pool, tokenIsToken0} | null
const rhPriceCache = new Map();  // token -> price in WETH

const addrFromWord = (word) => "0x" + word.slice(-40).toLowerCase();

/**
 * Find a token's WETH pool. The pool holds most of the float, so it is near the
 * top of the holder list -- but so is the burn address, hence the contract
 * filter, and each candidate is confirmed by its token0/token1 pair.
 */
async function rhFindPool(token) {
  const key = token.toLowerCase();
  if (rhPoolCache.has(key)) return rhPoolCache.get(key);

  let found = null;
  try {
    const holders = await bsGet(`/tokens/${token}/holders`);
    const candidates = (holders.items ?? [])
      .filter((h) => h.address?.is_contract)
      .map((h) => h.address.hash)
      .slice(0, 6);

    // Probe every candidate at once; the pool is usually the first holder, but
    // testing serially costs a round trip per miss.
    const probes = await Promise.all(candidates.map(async (cand) => {
      const [w0, w1] = await Promise.all([ethCall(cand, RH.sel.token0), ethCall(cand, RH.sel.token1)]);
      if (!w0 || !w1) return null;
      const a0 = addrFromWord(w0), a1 = addrFromWord(w1);
      if (a0 === key && a1 === RH.weth) return { pool: cand, tokenIsToken0: true };
      if (a1 === key && a0 === RH.weth) return { pool: cand, tokenIsToken0: false };
      return null;
    }));
    found = probes.find(Boolean) ?? null;
  } catch { /* leave found null — the token just won't be priced */ }

  rhPoolCache.set(key, found);
  return found;
}

/**
 * Token price denominated in WETH, read straight from its pool.
 *
 * Tries V3 (sqrtPriceX96) first, then falls back to a V2 pair's reserves —
 * both generations are live on this chain, and assuming V3 silently dropped
 * whole holdings (Axel's SBS is a V2 pair worth a few hundred dollars).
 */
async function rhTokenPriceWeth(token, decimals) {
  const key = token.toLowerCase();
  if (rhPriceCache.has(key)) return rhPriceCache.get(key);

  let price = null;
  const found = await rhFindPool(token);

  if (found) {
    // token1-per-token0, in human units, whichever shape the pool is.
    let human = null;

    const slot0 = await ethCall(found.pool, RH.sel.slot0);
    if (slot0 && slot0.length >= 66) {
      const sqrtPriceX96 = Number(BigInt("0x" + slot0.slice(2, 66)));
      if (sqrtPriceX96 > 0) {
        const r = sqrtPriceX96 / 2 ** 96;
        const d0 = found.tokenIsToken0 ? decimals : 18;
        const d1 = found.tokenIsToken0 ? 18 : decimals;
        human = r * r * 10 ** (d0 - d1);
      }
    } else {
      const res = await ethCall(found.pool, RH.sel.getReserves);
      if (res && res.length >= 130) {
        const r0 = Number(BigInt("0x" + res.slice(2, 66)));
        const r1 = Number(BigInt("0x" + res.slice(66, 130)));
        const d0 = found.tokenIsToken0 ? decimals : 18;
        const d1 = found.tokenIsToken0 ? 18 : decimals;
        const h0 = r0 / 10 ** d0, h1 = r1 / 10 ** d1;
        if (h0 > 0 && h1 > 0) human = h1 / h0;
      }
    }

    if (human != null && human > 0 && Number.isFinite(human)) {
      price = found.tokenIsToken0 ? human : 1 / human;
    }
  }

  rhPriceCache.set(key, price);
  return price;
}

/** Walk Blockscout's next_page_params until exhausted. */
async function bsPaged(path, maxPages = 12) {
  const out = [];
  let params = null;
  for (let page = 0; page < maxPages; page++) {
    const qs = params
      ? (path.includes("?") ? "&" : "?") +
        Object.entries(params).filter(([, v]) => v != null)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
      : "";
    let d;
    try { d = await bsGet(path + qs); } catch { break; }
    const items = d.items ?? [];
    out.push(...items);
    if (!items.length || !d.next_page_params) break;
    params = d.next_page_params;
  }
  return out;
}

/**
 * Rebuild every swap this wallet made on Robinhood Chain from on-chain data,
 * and derive cost basis, realised and unrealised PnL.
 *
 * Accounting is in ETH — the actual quote asset of every pool here. Blockscout
 * returns `historic_exchange_rate: null`, so there is no trustworthy per-trade
 * USD rate; ETH-denominated PnL is exact and is converted at the current rate
 * only for display.
 *
 * A swap is a transaction where tokens move one way and native ETH the other:
 * buys carry ETH in the transaction's `value`, sells receive ETH back as an
 * internal transaction from the router.
 *
 * Two honesty guards, both learned the hard way:
 *  - Reconstructed quantity is checked against the wallet's real balance. If it
 *    disagrees the history is incomplete and PnL is withheld. (BasedBot's
 *    pool-scoped feed failed exactly this test: 27 sells against 1 buy.)
 *  - Tokens that arrived as plain transfers (airdrops) have unknown cost, not
 *    zero cost. Counting them as free manufactures profit, so their proceeds
 *    are reported separately and excluded from realised PnL.
 */
async function rhSwaps(address) {
  const me = address.toLowerCase();
  const [transfers, txs, internals] = await Promise.all([
    bsPaged(`/addresses/${address}/token-transfers?type=ERC-20`),
    bsPaged(`/addresses/${address}/transactions`),
    bsPaged(`/addresses/${address}/internal-transactions`),
  ]);

  // native ETH spent by us, plus total gas
  const ethOut = new Map();
  let gasEth = 0;
  for (const t of txs) {
    if ((t.from?.hash ?? "").toLowerCase() !== me) continue;
    ethOut.set(t.hash, (ethOut.get(t.hash) ?? 0) + num(t.value) / 1e18);
    gasEth += num(t.fee?.value) / 1e18;
  }

  // native ETH paid to us (sell proceeds arrive this way)
  const ethIn = new Map();
  for (const it of internals) {
    if ((it.to?.hash ?? "").toLowerCase() !== me) continue;
    if (it.success === false) continue;
    const h = it.transaction_hash;
    ethIn.set(h, (ethIn.get(h) ?? 0) + num(it.value) / 1e18);
  }

  // token movements per transaction
  const perTx = new Map();   // hash -> { sort, tokens: Map(addr -> qty) }
  const tokenMeta = new Map();
  for (const x of transfers) {
    const tk = x.token ?? {};
    const ta = (tk.address_hash ?? tk.address ?? "").toLowerCase();
    if (!ta) continue;
    const decimals = parseInt(tk.decimals ?? "18", 10) || 18;
    tokenMeta.set(ta, { symbol: tk.symbol || "?", name: tk.name || "", decimals });

    const raw = (x.total && typeof x.total === "object") ? x.total.value : x.value;
    const amt = num(raw) / 10 ** decimals;
    if (!amt) continue;

    const h = x.transaction_hash;
    if (!perTx.has(h)) {
      perTx.set(h, {
        sort: [num(x.block_number), num(x.log_index)],
        ts: Date.parse(x.timestamp) || 0,
        tokens: new Map(),
      });
    }
    const rec = perTx.get(h);
    const to = (x.to?.hash ?? "").toLowerCase();
    const frm = (x.from?.hash ?? "").toLowerCase();
    const signed = to === me ? amt : frm === me ? -amt : 0;
    if (signed) rec.tokens.set(ta, (rec.tokens.get(ta) ?? 0) + signed);
  }

  // oldest first, so cost basis accumulates in the right order
  const order = [...perTx.entries()].sort((a, b) =>
    a[1].sort[0] - b[1].sort[0] || a[1].sort[1] - b[1].sort[1]);

  const books = new Map();   // token -> ledger
  const blank = () => ({
    qty: 0, costEth: 0, realisedEth: 0, buys: 0, sells: 0,
    uncostedIn: 0, uncostedProceedsEth: 0,
  });
  // Timestamped so the range selector can scope this venue too.
  const realisedEvents = [];
  const volumeEvents = [];   // every swap's ETH notional
  const trades = [];
  let deployedEth = 0;       // gross ETH ever spent buying — the capital at risk

  for (const [hash, rec] of order) {
    const inEth = ethIn.get(hash) ?? 0;
    const outEth = ethOut.get(hash) ?? 0;
    for (const [ta, dq] of rec.tokens) {
      if (!books.has(ta)) books.set(ta, blank());
      const b = books.get(ta);
      const sym = tokenMeta.get(ta)?.symbol ?? "?";

      if (dq > 0) {
        if (outEth > 0) {
          b.qty += dq; b.costEth += outEth; b.buys++;
          deployedEth += outEth;
          volumeEvents.push({ ts: rec.ts, eth: outEth });
          trades.push({ ts: rec.ts, symbol: sym, side: "Buy", qty: dq, eth: outEth, token: ta });
        } else {
          b.qty += dq; b.uncostedIn++;               // airdrop / incoming transfer
          trades.push({ ts: rec.ts, symbol: sym, side: "Received", qty: dq, eth: 0, token: ta });
        }
      } else if (dq < 0) {
        const amt = -dq;
        const avg = b.qty > 0 ? b.costEth / b.qty : 0;
        if (inEth > 0) {
          volumeEvents.push({ ts: rec.ts, eth: inEth });
          if (b.uncostedIn > 0) {
            b.uncostedProceedsEth += inEth;          // cost unknown, not zero
            trades.push({ ts: rec.ts, symbol: sym, side: "Sell", qty: amt, eth: inEth,
                          token: ta, pnlEth: null });
          } else {
            const r = inEth - avg * amt;
            b.realisedEth += r; b.sells++;
            realisedEvents.push({ ts: rec.ts, eth: r });
            trades.push({ ts: rec.ts, symbol: sym, side: "Sell", qty: amt, eth: inEth,
                          token: ta, pnlEth: r });
          }
        } else {
          trades.push({ ts: rec.ts, symbol: sym, side: "Sent", qty: amt, eth: 0, token: ta });
        }
        b.qty -= amt;
        b.costEth -= avg * amt;
        if (b.qty < 1e-12) { b.qty = 0; b.costEth = 0; }
      }
    }
  }

  // gas, with timestamps, so it can be scoped the same way
  const gasEvents = txs
    .filter((t) => (t.from?.hash ?? "").toLowerCase() === me)
    .map((t) => ({ ts: Date.parse(t.timestamp) || 0, eth: num(t.fee?.value) / 1e18 }));

  trades.sort((a, b) => b.ts - a.ts);

  return { books, tokenMeta, gasEth, realisedEvents, gasEvents, volumeEvents, trades,
           deployedEth, txCount: txs.length, transferCount: transfers.length };
}

/**
 * Holdings, value and PnL for one wallet on Robinhood Chain.
 */
async function loadRobinhood(address) {
  const [summary, balances] = await Promise.all([
    bsGet(`/addresses/${address}`).catch(() => null),
    bsGet(`/addresses/${address}/token-balances`).catch(() => null),
  ]);
  if (!summary) return null;

  const ethUsd = num(summary.exchange_rate);
  const nativeQty = num(summary.coin_balance) / 1e18;
  const nativeUsd = nativeQty * ethUsd;

  const rawList = Array.isArray(balances) ? balances : (balances?.items ?? []);

  // Nothing here at all — skip the (expensive) swap reconstruction entirely.
  if (nativeQty === 0 && rawList.length === 0) {
    return { ethUsd, nativeQty: 0, nativeUsd: 0, tokens: [], closed: [], tokenValue: 0,
             total: 0, unpriced: 0, active: false, realisedEth: 0, unrealisedEth: 0,
             gasEth: 0, uncostedProceedsEth: 0, verified: true, txCount: 0 };
  }

  const swaps = await rhSwaps(address).catch(() => null);

  // Price every holding concurrently — serially this is a round trip per token
  // per pool candidate, which visibly stalls the whole page.
  const tokens = (await Promise.all(rawList.map(async (b) => {
    const t = b.token ?? {};
    const addr = t.address_hash ?? t.address;
    if (!addr) return null;
    const decimals = parseInt(t.decimals ?? "18", 10) || 18;
    const qty = num(b.value) / 10 ** decimals;
    if (qty <= 0) return null;

    // Blockscout prices a few tokens itself; derive the rest from the pool.
    let usd = num(t.exchange_rate);
    let source = usd > 0 ? "blockscout" : null;
    if (!source) {
      const weth = await rhTokenPriceWeth(addr, decimals);
      if (weth != null && ethUsd > 0) { usd = weth * ethUsd; source = "pool"; }
    }

    const book = swaps?.books.get(addr.toLowerCase());
    // Does the swap history actually account for what the wallet holds?
    const verified = book ? Math.abs(book.qty - qty) <= Math.max(1e-6, qty * 0.005) : false;
    const costEth = book && verified && !book.uncostedIn ? book.costEth : null;
    const valueEth = source && ethUsd > 0 ? (qty * usd) / ethUsd : null;

    return {
      symbol: t.symbol || "?", name: t.name || "", address: addr,
      qty, priceUsd: source ? usd : null, value: source ? qty * usd : null, source,
      costEth, valueEth,
      unrealisedEth: costEth != null && valueEth != null ? valueEth - costEth : null,
      realisedEth: book && !book.uncostedIn ? book.realisedEth : null,
      uncosted: !!book?.uncostedIn,
      verified,
    };
  }))).filter(Boolean);

  tokens.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  const tokenValue = tokens.reduce((s, t) => s + (t.value ?? 0), 0);
  const unpriced = tokens.filter((t) => t.value == null).length;

  // Positions closed out entirely: they hold no balance now, so they never
  // appear in token-balances, yet they carry most of the realised PnL.
  const held = new Set(tokens.map((t) => t.address.toLowerCase()));
  const closed = [];
  let realisedEth = 0;
  let uncostedProceedsEth = 0;

  for (const [ta, b] of swaps?.books ?? []) {
    if (b.uncostedIn) { uncostedProceedsEth += b.uncostedProceedsEth; continue; }
    realisedEth += b.realisedEth;
    if (!held.has(ta) && b.sells > 0) {
      const meta = swaps.tokenMeta.get(ta) ?? {};
      closed.push({
        symbol: meta.symbol || "?", name: meta.name || "", address: ta,
        realisedEth: b.realisedEth, buys: b.buys, sells: b.sells,
      });
    }
  }
  closed.sort((a, b) => b.realisedEth - a.realisedEth);

  const unrealisedEth = tokens.reduce((s, t) => s + (t.unrealisedEth ?? 0), 0);
  const gasEth = swaps?.gasEth ?? 0;

  return {
    ethUsd, nativeQty, nativeUsd, tokens, closed, tokenValue,
    total: nativeUsd + tokenValue,
    unpriced,
    // "Used at all?" — distinguishes a real wallet from an untouched address.
    active: nativeQty > 0 || tokens.length > 0,
    realisedEth, unrealisedEth, gasEth, uncostedProceedsEth,
    realisedEvents: swaps?.realisedEvents ?? [],
    gasEvents: swaps?.gasEvents ?? [],
    volumeEvents: swaps?.volumeEvents ?? [],
    trades: swaps?.trades ?? [],
    deployedEth: swaps?.deployedEth ?? 0,
    // PnL is only shown when the reconstruction reproduces every held balance.
    verified: !!swaps && tokens.every((t) => t.verified || t.value == null),
    txCount: swaps?.txCount ?? 0,
  };
}

/* --------------------------------------------------------------- fetching -- */
/**
 * Load one trader. `knownDexes` limits the position scan on light refreshes;
 * pass null to scan every venue.
 */
async function loadTrader(trader, knownDexes) {
  const dexes = knownDexes ?? (await loadDexes());

  const [portfolio, fills, rh, ...states] = await Promise.all([
    info({ type: "portfolio", user: trader.address }),
    info({ type: "userFills", user: trader.address }),
    loadRobinhood(trader.address).catch(() => null),
    ...dexes.map((dex) =>
      info(dex ? { type: "clearinghouseState", user: trader.address, dex }
               : { type: "clearinghouseState", user: trader.address })
        .catch(() => null)),
  ]);

  // ---- positions across every venue -------------------------------------
  const positions = [];
  const venues = [];
  states.forEach((st, i) => {
    if (!st) return;
    const dex = dexes[i];
    const equity = num(st.marginSummary?.accountValue);
    const rows = (st.assetPositions ?? []).map((ap) => ap.position).filter(Boolean);
    if (rows.length || equity > 0) venues.push({ dex, equity, count: rows.length });
    for (const p of rows) positions.push({ ...p, dex });
  });

  const unrealised = positions.reduce((s, p) => s + num(p.unrealizedPnl), 0);

  // ---- realised, from fills (closedPnl is gross; fees are the cost) ------
  const fillRows = Array.isArray(fills) ? fills : [];
  const realised = fillRows.reduce((s, f) => s + num(f.closedPnl) - num(f.fee), 0);
  const feesPaid = fillRows.reduce((s, f) => s + num(f.fee), 0);

  // ---- portfolio: authoritative equity + per-period PnL ------------------
  const pf = Object.fromEntries(Array.isArray(portfolio) ? portfolio : []);
  const periods = {};
  for (const key of ["day", "week", "month", "allTime"]) {
    const p = pf[key] ?? {};
    const pnlHist = (p.pnlHistory ?? []).map(([t, v]) => [t, num(v)]);
    const avHist = (p.accountValueHistory ?? []).map(([t, v]) => [t, num(v)]);
    periods[key] = {
      pnl: pnlHist.length ? pnlHist[pnlHist.length - 1][1] : 0,
      volume: num(p.vlm),
      pnlHist,
      avHist,
      // Return on the period's starting equity. Only meaningful when the
      // account actually held something at the start of the window.
      startEquity: avHist.length ? avHist[0][1] : 0,
    };
  }

  const hlEquity = periods.allTime.avHist.length
    ? periods.allTime.avHist[periods.allTime.avHist.length - 1][1]
    : venues.reduce((s, v) => s + v.equity, 0);

  // Hyperliquid and Robinhood Chain are genuinely separate pools of money, so
  // unlike perp-vs-spot within Hyperliquid these DO add up.
  const rhActive = rh?.active ? rh : null;
  const rhValue = rhActive ? rhActive.total : 0;
  const equity = hlEquity + rhValue;

  // Robinhood Chain PnL, converted from ETH at the current rate for display.
  const rhOk = !!rhActive && rhActive.verified;
  const rhRealised = rhOk ? (rhActive.realisedEth - rhActive.gasEth) * rhActive.ethUsd : 0;
  const rhUnrealised = rhOk ? rhActive.unrealisedEth * rhActive.ethUsd : 0;

  return {
    ...trader,
    ok: true,
    equity,
    hlEquity,
    rh: rhActive,
    rhOk,
    rhRealised,
    rhUnrealised,
    unrealised: unrealised + rhUnrealised,
    realised: realised + rhRealised,
    feesPaid,
    positions,
    venues,
    fills: fillRows,
    periods,
    // True when every dollar of equity is covered by a PnL source.
    pnlCoversAll: rhValue === 0 || rhOk,
    // "never traded anywhere" — distinct from "traded and went flat"
    isEmpty: equity === 0 && positions.length === 0 && fillRows.length === 0
             && !rhActive,
    dexesScanned: dexes,
  };
}

async function loadAll({ full = false } = {}) {
  setStatus("loading", "Refreshing…");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("is-stale"));

  await loadDexes();
  let failures = 0;

  // Bounded concurrency: fully sequential is slow now that each trader also
  // does Robinhood Chain lookups, but unbounded would trip the Hyperliquid
  // rate limit. Rows still appear as each trader resolves.
  const CONCURRENCY = 3;
  const queue = [...TRADERS];

  const worker = async () => {
    for (;;) {
      const trader = queue.shift();
      if (!trader) return;
      const prev = state.byAddress.get(trader.address);
      const known = full || !prev?.dexesScanned
        ? null
        : dedupe(["", ...prev.venues.map((v) => v.dex)]);
      try {
        state.byAddress.set(trader.address, await loadTrader(trader, known));
      } catch (err) {
        failures++;
        state.byAddress.set(trader.address, {
          ...trader, ok: false, error: String(err.message || err),
          equity: 0, hlEquity: 0, rh: null, unrealised: 0, realised: 0,
          positions: [], venues: [], fills: [], periods: {},
          isEmpty: false, pnlCoversAll: true,
        });
      }
      render();
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-stale"));
  if (failures) setStatus("error", `${failures} of ${TRADERS.length} failed`);
  else setStatus("live", "Live");

  const stamp = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("#updated").textContent = `Updated ${stamp}`;
}

/* ----------------------------------------------------------------- format -- */
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const usd = (n, dp = 2) =>
  "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Signed money. Exact zero carries no sign — "+$0.00" implies a gain. */
const signedUsd = (n, dp = 2) => (n === 0 ? "" : n < 0 ? "−" : "+") + usd(n, dp);

function compactUsd(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";   // must survive: an unsigned "$200" reads as +200
  if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(1) + "K";
  return sign + usd(a, 2);
}

/** Axis-tick money: compact, and no trailing ".00" on whole dollars. */
function axisUsd(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  const trim = (s) => s.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  if (a >= 1e6) return sign + "$" + trim((a / 1e6).toFixed(2)) + "M";
  if (a >= 1e3) return sign + "$" + trim((a / 1e3).toFixed(1)) + "K";
  return sign + "$" + trim(a.toFixed(a > 0 && a < 1 ? 2 : 0));
}

const pct = (n) => (n === 0 ? "" : n < 0 ? "−" : "+") + Math.abs(n).toFixed(2) + "%";

const dirClass = (n) => (n > 0 ? "up" : n < 0 ? "down" : "flat");

/** Truncated display form. The full value is deliberately not rendered. */
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const fmtTime = (ms) =>
  new Date(ms).toLocaleString(undefined,
    { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Market label: strip the `dex:` prefix for display, keep the venue separate. */
function marketParts(coin) {
  const i = String(coin).indexOf(":");
  return i === -1
    ? { venue: null, symbol: String(coin) }
    : { venue: String(coin).slice(0, i), symbol: String(coin).slice(i + 1) };
}

const dexLabel = (dex) => (dex === "" ? "Main" : dex);

const dedupe = (a) => a.filter((v, i, arr) => arr.indexOf(v) === i);

/**
 * Axis domain snapped to human-readable steps (1 / 2 / 2.5 / 5 x 10^n), so ticks
 * read "+$60, +$40, +$20" rather than "+$69, +$48, +$27".
 */
function niceScale(lo, hi, targetTicks = 4) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
    const c = Number.isFinite(lo) ? lo : 0;
    return { lo: c - 1, hi: c + 1, ticks: [c - 1, c, c + 1] };
  }
  const raw = (hi - lo) / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const nLo = Math.floor(lo / step) * step;
  const nHi = Math.ceil(hi / step) * step;
  const ticks = [];
  // Accumulate by index, not by repeated addition, to avoid float drift.
  for (let i = 0; nLo + i * step <= nHi + step * 1e-9; i++) ticks.push(nLo + i * step);
  return { lo: nLo, hi: nHi, ticks };
}

/** Tick label precision: keep cents only when the step is sub-dollar. */
const tickDp = (step) => (Math.abs(step) >= 1 ? 0 : 2);

const initials = (name) => name.slice(0, 2).toUpperCase();

/* -------------------------------------------------------------- dom utils -- */
const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, opts = {}, kids = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  // API-sourced strings go in as text, never as markup.
  if (opts.text != null) node.textContent = String(opts.text);
  for (const [k, v] of Object.entries(opts.attrs ?? {})) {
    if (v != null) node.setAttribute(k, String(v));
  }
  for (const kid of [].concat(kids)) if (kid) node.append(kid);
  return node;
}

/** A signed figure: colour + explicit sign + arrow (never colour alone). */
function delta(value, { compact = false, dp = 2 } = {}) {
  // compactUsd carries its own sign, so feed it the magnitude here.
  const text = compact
    ? (value < 0 ? "−" : "+") + compactUsd(Math.abs(value))
    : signedUsd(value, dp);
  return el("span", { class: `delta ${dirClass(value)}`, text });
}

function setStatus(stateName, text) {
  $("#status-dot").dataset.state = stateName;
  $("#status-text").textContent = text;
}

function tile(label, valueNode, sub) {
  return el("div", { class: "tile" }, [
    el("div", { class: "tile-label", text: label }),
    el("div", { class: "tile-value" }, [valueNode]),
    sub ? el("div", { class: "tile-sub", text: sub }) : null,
  ]);
}

/* ============================== RENDER ==================================== */
function render() {
  $("#th-period").textContent = PERIOD_LABEL[state.period];
  if (state.route.view === "trader") {
    $("#view-board").hidden = true;
    $("#view-trader").hidden = false;
    renderTrader();
  } else {
    $("#view-trader").hidden = true;
    $("#view-board").hidden = false;
    renderGroupTiles();
    renderBoard();
  }
}

const periodOf = (t) => t.periods?.[state.period] ?? { pnl: 0, volume: 0, pnlHist: [], avHist: [], startEquity: 0 };

/** Start of the selected range, in epoch ms. 0 for all-time. */
function periodCutoff() {
  const DAY = 86_400_000;
  const now = Date.now();
  switch (state.period) {
    case "day": return now - DAY;
    case "week": return now - 7 * DAY;
    case "month": return now - 30 * DAY;
    default: return 0;
  }
}

/**
 * Robinhood Chain PnL in USD for the selected range.
 * Realised is scoped to the window; unrealised is a property of what is held
 * right now, so it is range-independent — same convention as the Hyperliquid side.
 */
function rhPnl(t) {
  if (!t.rhOk || !t.rh) return { realised: 0, unrealised: 0, total: 0, gas: 0, volume: 0 };
  const cut = periodCutoff();
  const sum = (evts) => evts.reduce((s, e) => s + (e.ts >= cut ? e.eth : 0), 0);
  const rate = t.rh.ethUsd;
  const gasEth = sum(t.rh.gasEvents);
  const realised = (sum(t.rh.realisedEvents) - gasEth) * rate;
  const unrealised = t.rh.unrealisedEth * rate;
  return {
    realised, unrealised, total: realised + unrealised,
    gas: gasEth * rate,
    volume: sum(t.rh.volumeEvents) * rate,
  };
}

/** Combined PnL across both venues for the selected range. */
const totalPnlOf = (t) => periodOf(t).pnl + rhPnl(t).total;

/** Combined traded notional across both venues for the selected range. */
const volumeOf = (t) => periodOf(t).volume + rhPnl(t).volume;

/**
 * Return on capital, as a percentage.
 *
 * The denominator is the tricky part. Hyperliquid reports starting equity, so
 * that side is easy. On Robinhood Chain there is no deposit record, and
 * inferring the stake as "equity minus PnL" is badly wrong — it ignores
 * deposits and produced a nonsense +1481% for a wallet that had simply been
 * topped up. Capital actually deployed into buys is the honest denominator.
 */
function roiOf(t) {
  const pnl = totalPnlOf(t);
  const p = periodOf(t);
  let base = 0;
  if (p.startEquity > 0) base += p.startEquity;
  else if (!t.rh) base += Math.max(0, t.equity - pnl);
  if (t.rhOk && t.rh) base += t.rh.deployedEth * t.rh.ethUsd;
  return base > 0 ? (pnl / base) * 100 : 0;
}

/* --------------------------------------------------------- group summary -- */
function renderGroupTiles() {
  const rows = TRADERS.map((t) => state.byAddress.get(t.address)).filter(Boolean);
  const active = rows.filter((t) => t.ok && !t.isEmpty);

  const equity = active.reduce((s, t) => s + t.equity, 0);
  const volume = active.reduce((s, t) => s + volumeOf(t), 0);
  const openPos = active.reduce((s, t) => s + t.positions.length + (t.rh?.tokens.length ?? 0), 0);

  // Only traders with a trustworthy PnL figure count toward the group total.
  const withPnl = active.filter((t) => t.pnlCoversAll);
  const rhOnly = active.filter((t) => !t.pnlCoversAll);
  const pnl = withPnl.reduce((s, t) => s + totalPnlOf(t), 0);
  const ranked = [...withPnl].sort((a, b) => totalPnlOf(b) - totalPnlOf(a));
  const best = ranked[0];
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  const box = $("#group-tiles");
  box.replaceChildren(
    tile("Group equity", el("span", { text: rows.length ? compactUsd(equity) : "—" }),
      `${active.length} of ${TRADERS.length} funded`),
    tile(`Group PnL · ${PERIOD_LABEL[state.period]}`, delta(pnl),
      rhOnly.length
        ? `excludes ${rhOnly.map((t) => t.name).join(", ")} — PnL unverified`
        : `across ${withPnl.length} trader${withPnl.length === 1 ? "" : "s"}, both venues`),
    tile("Top performer",
      best ? el("span", { text: best.name }) : el("span", { class: "hint", text: "—" }),
      best ? `${signedUsd(totalPnlOf(best))} · ${pct(roiOf(best))}` : "no activity yet"),
    tile("Laggard",
      worst ? el("span", { text: worst.name }) : el("span", { class: "hint", text: "—" }),
      worst ? `${signedUsd(totalPnlOf(worst))} · ${pct(roiOf(worst))}` : "—"),
    tile(`Volume · ${PERIOD_LABEL[state.period]}`, el("span", { text: compactUsd(volume) }), "notional traded"),
  );
}

/* ------------------------------------------------------------ leaderboard -- */
const SORTERS = {
  equity: (t) => t.equity,
  pnl:    (t) => totalPnlOf(t),
  roi:    (t) => roiOf(t),
  unreal: (t) => t.unrealised,
  real:   (t) => t.realised,
  vol:    (t) => volumeOf(t),
};

function renderBoard() {
  const body = $("#board-body");
  const rows = TRADERS.map((t) => state.byAddress.get(t.address) ?? { ...t, pending: true });

  const { key, dir } = state.sort;
  const get = SORTERS[key] ?? SORTERS.pnl;
  const loaded = rows.filter((t) => !t.pending);
  const pending = rows.filter((t) => t.pending);

  // Three bands, in order: traders with a real PnL figure, then traders who are
  // funded but have no PnL source (Robinhood-Chain-only), then never-funded.
  // A missing PnL is not a zero and must not rank as one.
  const funded = loaded.filter((t) => t.ok && !t.isEmpty);
  const rest = loaded.filter((t) => !(t.ok && !t.isEmpty));
  const hasPnl = (t) => t.pnlCoversAll;
  const ranked = funded.filter(hasPnl);
  const unranked = funded.filter((t) => !hasPnl(t));
  ranked.sort((a, b) => (dir === "asc" ? get(a) - get(b) : get(b) - get(a)));
  unranked.sort((a, b) => b.equity - a.equity);

  const ordered = [...ranked, ...unranked, ...rest, ...pending];

  body.replaceChildren(...ordered.map((t, i) => boardRow(t, i)));

  document.querySelectorAll("#board th.sortable").forEach((th) => {
    if (th.dataset.sort === key) th.dataset.dir = dir;
    else th.removeAttribute("data-dir");
  });
}

function boardRow(t, index) {
  const tr = el("tr");

  if (t.pending) {
    tr.append(
      el("td", { class: "col-rank", text: "·" }),
      el("td", {}, [el("div", { class: "trader-cell" }, [
        el("span", { class: "avatar", text: initials(t.name) }),
        el("div", {}, [el("div", { class: "trader-name", text: t.name })]),
      ])]),
      ...Array.from({ length: 7 }, () => el("td", { class: "num" }, [el("span", { class: "skeleton" })])),
      el("td", { class: "col-spark" }),
    );
    return tr;
  }

  if (!t.ok) {
    tr.className = "is-empty";
    tr.append(
      el("td", { class: "col-rank", text: "!" }),
      el("td", {}, [el("div", { class: "trader-cell" }, [
        el("span", { class: "avatar", text: initials(t.name) }),
        el("div", {}, [
          el("div", { class: "trader-name", text: t.name }),
          el("span", { class: "trader-addr", text: shortAddr(t.address) }),
        ]),
      ])]),
      el("td", { class: "num", attrs: { colspan: 8 }, text: `Failed to load — ${t.error}` }),
    );
    return tr;
  }

  const p = periodOf(t);
  const isEmpty = t.isEmpty;

  tr.className = "row-link" + (isEmpty ? " is-empty" : "");
  tr.tabIndex = 0;
  tr.setAttribute("role", "link");
  tr.setAttribute("aria-label", `${t.name}, view positions and trades`);
  const open = () => { location.hash = `#/t/${t.address}`; };
  tr.addEventListener("click", open);
  tr.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });

  // "Idle" = funded but flat, which reports as no venue on every clearinghouse.
  const hlTags = t.venues.length
    ? dedupe(t.venues.map((v) => dexLabel(v.dex)))
    : t.hlEquity > 0 ? ["Idle"] : [];
  const venueTags = [...hlTags, ...(t.rh ? [RH.short] : [])];

  tr.append(
    el("td", { class: "col-rank", text: isEmpty ? "–" : String(index + 1) }),
    el("td", {}, [
      el("div", { class: "trader-cell" }, [
        el("span", { class: "avatar", text: initials(t.name) }),
        el("div", {}, [
          el("div", { class: "trader-name", text: t.name }),
          el("span", { class: "trader-addr", text: shortAddr(t.address) }),
        ]),
      ]),
    ]),
  );

  if (isEmpty) {
    tr.append(el("td", { class: "num", attrs: { colspan: 8 }, text: "Not funded yet — no balance or trades on any venue" }));
    return tr;
  }

  // PnL is only withheld when equity exists that no source can account for —
  // e.g. Robinhood Chain holdings whose swap history failed verification.
  const noPnl = !t.pnlCoversAll;
  const naCell = (title) => el("td", { class: "num" }, [
    el("span", { class: "hint", attrs: { title }, text: "—" }),
  ]);
  const why = "Swap history could not be reconciled against the wallet balance, so PnL is withheld";

  const pnl = totalPnlOf(t);

  tr.append(el("td", { class: "num", text: usd(t.equity) }));

  if (noPnl) {
    tr.append(naCell(why), naCell(why), naCell(why), naCell(why));
  } else {
    tr.append(
      el("td", { class: "num" }, [delta(pnl)]),
      el("td", { class: "num" }, [el("span", { class: `delta ${dirClass(pnl)}`, text: pct(roiOf(t)) })]),
      el("td", { class: "num" }, [delta(t.unrealised)]),
      el("td", { class: "num" }, [delta(t.realised)]),
    );
  }

  tr.append(
    el("td", { class: "num", text: compactUsd(volumeOf(t)) }),
    el("td", { class: "num", text: String(t.positions.length + (t.rh?.tokens.length ?? 0)) }),
    el("td", { class: "col-spark" }, [
      p.pnlHist.length > 1 ? sparkline(p.pnlHist) : el("span", { class: "hint", text: "—" }),
    ]),
  );

  if (venueTags.length) tr.querySelector(".trader-cell > div").append(
    el("span", { class: "tag", text: venueTags.join(" · ") }),
  );

  return tr;
}

/* -------------------------------------------------------------- sparkline -- */
/** One series per row, coloured by its own sign — no categorical palette. */
function sparkline(hist, w = 88, h = 26) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  if (!hist || hist.length < 2) return svg;

  const vals = hist.map(([, v]) => v);
  const min = Math.min(0, ...vals);
  const max = Math.max(0, ...vals);
  const span = max - min || 1;
  const pad = 3;
  const x = (i) => (i / (hist.length - 1)) * (w - 2) + 1;
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);

  const last = vals[vals.length - 1];
  const stroke = last > 0 ? "var(--profit)" : last < 0 ? "var(--loss)" : "var(--text-muted)";

  // zero baseline, recessive
  if (min < 0 && max > 0) {
    const zero = document.createElementNS(NS, "line");
    zero.setAttribute("x1", "0"); zero.setAttribute("x2", String(w));
    zero.setAttribute("y1", String(y(0))); zero.setAttribute("y2", String(y(0)));
    zero.setAttribute("stroke", "var(--baseline)");
    zero.setAttribute("stroke-width", "1");
    zero.setAttribute("stroke-dasharray", "2 2");
    svg.append(zero);
  }

  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" "));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", stroke);
  path.setAttribute("stroke-width", "1.75");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);

  // 4px rounded data-end marks the latest value
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", String(x(vals.length - 1).toFixed(2)));
  dot.setAttribute("cy", String(y(last).toFixed(2)));
  dot.setAttribute("r", "2");
  dot.setAttribute("fill", stroke);
  svg.append(dot);

  return svg;
}

/* ==================== TRADER DETAIL ====================================== */
function renderTrader() {
  const t = state.byAddress.get(state.route.address);
  if (!t) {
    $("#t-name").textContent = "Loading…";
    $("#t-addr").textContent = "";
    $("#t-tiles").replaceChildren();
    $("#positions").replaceChildren(el("div", { class: "empty", text: "Loading…" }));
    $("#fills").replaceChildren();
    $("#chart-wrap").replaceChildren();
    return;
  }

  $("#t-name").textContent = t.name;
  $("#t-addr").textContent = shortAddr(t.address);

  const detailTags = [
    ...dedupe(t.venues.map((v) => dexLabel(v.dex))),
    ...(t.rh ? [RH.short] : []),
  ];
  $("#t-venues").replaceChildren(
    ...(detailTags.length
      ? detailTags.map((d) => el("span", { class: "tag", text: d }))
      : [el("span", { class: "tag", text: "no venue" })]),
  );

  if (!t.ok) {
    $("#t-tiles").replaceChildren();
    $("#chart-wrap").replaceChildren(el("div", { class: "error-box", text: `Failed to load: ${t.error}` }));
    $("#positions").replaceChildren();
    $("#fills").replaceChildren();
    return;
  }

  const p = periodOf(t);
  const totalPnl = t.unrealised + t.realised;

  // With no open position the collateral sits free in spot and every perp
  // clearinghouse reports 0, so "no venue" must not be read as "no money".
  const parts = t.venues.map((v) => `${dexLabel(v.dex)} ${usd(v.equity)}`);
  if (t.rh) parts.push(`${RH.short} ${usd(t.rh.total)}`);
  const equitySub = parts.length
    ? parts.join(" · ")
    : t.equity > 0
      ? "idle collateral — no open position"
      : "not funded";

  const naTile = (label, sub) => tile(label, el("span", { class: "hint", text: "—" }), sub);
  const rp = rhPnl(t);
  const pnl = totalPnlOf(t);
  const bothVenues = t.rh && (t.hlEquity > 0 || t.fills.length);
  const openCount = t.positions.length + (t.rh?.tokens.length ?? 0);
  const feeNote = t.rh
    ? `net of ${usd(t.feesPaid + rp.gas)} fees & gas`
    : `net of ${usd(t.feesPaid)} fees`;

  $("#t-tiles").replaceChildren(
    tile("Equity", el("span", { text: usd(t.equity) }), equitySub),
    t.pnlCoversAll
      ? tile(`PnL · ${PERIOD_LABEL[state.period]}`, delta(pnl),
          bothVenues ? `${pct(roiOf(t))} · both venues combined` : pct(roiOf(t)) + " on starting equity")
      : naTile(`PnL · ${PERIOD_LABEL[state.period]}`, "swap history unverified"),
    t.pnlCoversAll
      ? tile("Unrealised", delta(t.unrealised),
          `${openCount} open position${openCount === 1 ? "" : "s"}`)
      : naTile("Unrealised", "swap history unverified"),
    t.pnlCoversAll
      ? tile("Realised", delta(t.realised), feeNote)
      : naTile("Realised", "swap history unverified"),
    t.pnlCoversAll
      ? tile("Realised + unrealised", delta(t.realised + t.unrealised), "lifetime")
      : naTile("Realised + unrealised", "—"),
    tile(`Volume · ${PERIOD_LABEL[state.period]}`, el("span", { text: compactUsd(volumeOf(t)) }),
      t.rh ? `${t.rh.txCount} on-chain tx · ${t.fills.length} fills` : `${t.fills.length} fill${t.fills.length === 1 ? "" : "s"}`),
  );

  renderChart(t);
  renderRobinhood(t);
  renderPositions(t);
  renderFills(t);
}

/* -------------------------------------------------- Robinhood Chain panel -- */
function renderRobinhood(t) {
  const panel = $("#rh-panel");
  const rh = t.rh;

  if (!rh) { panel.hidden = true; return; }
  panel.hidden = false;

  const rp = rhPnl(t);
  $("#rh-count").textContent = t.rhOk
    ? `${usd(rh.total)} · ${signedUsd(rp.total)} PnL`
    : `${usd(rh.total)} · PnL unverified`;

  const eth = (v, dp = 4) => `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(dp)} Ξ`;

  const tbl = el("table", { class: "grid" });
  const head = ["Asset", "Quantity", "Price", "Value", "Cost", "Unrealised", "Realised", "Source"];
  tbl.append(el("thead", {}, [el("tr", {}, head.map((h, i) =>
    el("th", { class: i >= 1 && i <= 6 ? "num" : "", attrs: { scope: "col" }, text: h })))]));

  const body = [];

  // native ETH first — usually the largest single holding
  if (rh.nativeQty > 0) {
    body.push(el("tr", {}, [
      el("td", {}, [el("strong", { text: "ETH" }), el("span", { class: "tag", text: "native" })]),
      el("td", { class: "num", text: rh.nativeQty.toLocaleString(undefined, { maximumFractionDigits: 6 }) }),
      el("td", { class: "num", text: usd(rh.ethUsd) }),
      el("td", { class: "num", text: usd(rh.nativeUsd) }),
      el("td", { class: "num", text: "—" }),
      el("td", { class: "num", text: "—" }),
      el("td", { class: "num", text: "—" }),
      el("td", {}, [el("span", { class: "hint", text: "explorer" })]),
    ]));
  }

  for (const tok of rh.tokens) {
    const priced = tok.value != null;
    const costUsd = tok.costEth != null ? tok.costEth * rh.ethUsd : null;
    const unrealUsd = tok.unrealisedEth != null ? tok.unrealisedEth * rh.ethUsd : null;
    const realUsd = tok.realisedEth != null ? tok.realisedEth * rh.ethUsd : null;

    body.push(el("tr", { class: priced && tok.value < RH.dustUsd ? "is-dust" : "" }, [
      el("td", {}, [
        el("strong", { text: tok.symbol }),
        tok.name && tok.name !== tok.symbol ? el("span", { class: "sub-name", text: tok.name }) : null,
        tok.uncosted ? el("span", { class: "tag", attrs: { title: "Arrived as a transfer — cost basis unknown" }, text: "airdrop" }) : null,
      ]),
      el("td", { class: "num", text: tok.qty.toLocaleString(undefined, { maximumFractionDigits: 4 }) }),
      el("td", { class: "num", text: priced ? "$" + tok.priceUsd.toPrecision(4) : "—" }),
      el("td", { class: "num", text: priced ? usd(tok.value) : "—" }),
      el("td", { class: "num", text: costUsd != null ? usd(costUsd) : "—" }),
      el("td", { class: "num" }, [unrealUsd != null ? delta(unrealUsd) : el("span", { class: "hint", text: "—" })]),
      el("td", { class: "num" }, [realUsd ? delta(realUsd) : el("span", { class: "hint", text: "—" })]),
      el("td", {}, [el("span", {
        class: "hint",
        text: tok.source === "pool" ? "DEX pool" : tok.source === "blockscout" ? "explorer" : "no price",
      })]),
    ]));
  }

  // fully-exited positions carry realised PnL but hold no balance
  for (const c of rh.closed) {
    if (Math.abs(c.realisedEth) < 1e-9) continue;
    body.push(el("tr", { class: "is-closed" }, [
      el("td", {}, [
        el("strong", { text: c.symbol }),
        el("span", { class: "tag", text: "closed" }),
      ]),
      el("td", { class: "num", text: "0" }),
      el("td", { class: "num", text: "—" }),
      el("td", { class: "num", text: "—" }),
      el("td", { class: "num", text: "—" }),
      el("td", { class: "num", text: "—" }),
      el("td", { class: "num" }, [delta(c.realisedEth * rh.ethUsd)]),
      el("td", {}, [el("span", { class: "hint", text: `${c.buys}B / ${c.sells}S` })]),
    ]));
  }

  tbl.append(el("tbody", {}, body));
  $("#rh-holdings").replaceChildren(tbl);

  const bits = [
    `Swaps are rebuilt from on-chain history (${rh.txCount} transactions) and priced against each token's DEX pool.`,
    `PnL is accounted in ETH — the quote asset of every pool here — and shown in dollars at the current rate (${usd(rh.ethUsd)}/ETH).`,
    `Realised ${eth(rp.total > 0 || rp.realised ? rh.realisedEth : 0)} gross, less ${eth(rh.gasEth)} gas.`,
  ];
  if (rh.verified) {
    bits.push("Every holding reconciles against the reconstructed history, so the cost basis is sound.");
  } else {
    bits.push("The reconstruction does not reproduce every balance, so PnL is withheld rather than shown wrong.");
  }
  if (rh.uncostedProceedsEth > 0) {
    bits.push(`${eth(rh.uncostedProceedsEth)} of proceeds came from tokens that arrived as transfers — ` +
              `their cost is unknown, not zero, so they are excluded from realised PnL.`);
  }
  if (rh.unpriced) bits.push(`${rh.unpriced} token${rh.unpriced === 1 ? "" : "s"} had no pool and could not be valued.`);
  $("#rh-note").textContent = bits.join(" ");
}

/** Percentage without a +/- sign — for shares of a total, which are never negative. */
const pctPlain = (n) => `${n.toFixed(1)}%`;

/* ------------------------------------------------------------------ chart -- */
function renderChart(t) {
  const p = periodOf(t);
  const isPnl = state.metric === "pnl";
  const hist = isPnl ? p.pnlHist : p.avHist;

  $("#chart-title").textContent = isPnl
    ? `Profit & loss · ${PERIOD_LABEL[state.period]}`
    : `Account equity · ${PERIOD_LABEL[state.period]}`;

  const wrap = $("#chart-wrap");
  const tableBox = $("#chart-table");

  // Hyperliquid returns a full all-zero history even for accounts that never
  // used it, so plotting a flat line on a +/-$1 axis is noise. This chart is
  // Hyperliquid-only; a Robinhood-Chain trader has nothing to plot here.
  const allZero = (hist ?? []).every(([, v]) => num(v) === 0);
  const noHl = t.hlEquity === 0 && !t.fills.length && !t.positions.length;
  if (!hist || hist.length < 2 || (allZero && (t.isEmpty || noHl))) {
    wrap.replaceChildren(el("div", { class: "empty",
      text: t.rh
        ? `No Hyperliquid history — this wallet trades on ${RH.name}. See holdings below.`
        : t.isEmpty ? "Nothing to chart — this wallet has never been funded."
                    : "No history for this range yet." }));
    tableBox.replaceChildren();
    return;
  }

  const NS = "http://www.w3.org/2000/svg";
  const W = 1000, H = 260;
  const m = { top: 16, right: 16, bottom: 26, left: 62 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;

  const vals = hist.map(([, v]) => v);
  let dLo = Math.min(...vals), dHi = Math.max(...vals);
  if (isPnl) { dLo = Math.min(dLo, 0); dHi = Math.max(dHi, 0); }
  const padY = (dHi - dLo) * 0.08;
  // Equity is a balance and cannot go negative, so never pad the axis below zero.
  const padLo = isPnl ? dLo - padY : Math.max(0, dLo - padY);
  const scale = niceScale(padLo, dHi + padY, 4);
  if (!isPnl) {
    scale.ticks = scale.ticks.filter((v) => v >= 0);
    scale.lo = Math.max(0, scale.lo);
  }
  const lo = scale.lo, hi = scale.hi;
  const tickStep = scale.ticks.length > 1 ? scale.ticks[1] - scale.ticks[0] : 1;

  const X = (i) => m.left + (i / (hist.length - 1)) * iw;
  const Y = (v) => m.top + ih - ((v - lo) / (hi - lo)) * ih;

  const last = vals[vals.length - 1];
  const stroke = isPnl
    ? (last > 0 ? "var(--profit)" : last < 0 ? "var(--loss)" : "var(--text-muted)")
    : "var(--accent)";

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label",
    `${isPnl ? "Profit and loss" : "Account equity"} for ${t.name} over ${PERIOD_LABEL[state.period]}. ` +
    `Latest ${isPnl ? signedUsd(last) : usd(last)}.`);

  const add = (tag, attrs, cls) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (cls) n.setAttribute("class", cls);
    svg.append(n);
    return n;
  };

  // ---- y grid + ticks (recessive) ----
  const dp = tickDp(tickStep);
  for (const v of scale.ticks) {
    const y = Y(v);
    add("line", { x1: m.left, x2: m.left + iw, y1: y, y2: y }, "gridline");
    const lab = add("text", { x: m.left - 9, y: y + 3.5, "text-anchor": "end" }, "axis-label");
    lab.textContent = isPnl
      ? (v === 0 ? "$0" : signedUsd(v, dp))
      : axisUsd(v);
  }

  // ---- zero line for PnL ----
  if (isPnl && lo < 0 && hi > 0) add("line", { x1: m.left, x2: m.left + iw, y1: Y(0), y2: Y(0) }, "zeroline");

  // ---- x ticks ----
  const xTickCount = Math.min(5, hist.length);
  for (let i = 0; i < xTickCount; i++) {
    const idx = Math.round((i / (xTickCount - 1 || 1)) * (hist.length - 1));
    const lab = add("text", {
      x: X(idx), y: H - 8,
      "text-anchor": i === 0 ? "start" : i === xTickCount - 1 ? "end" : "middle",
    }, "axis-label");
    lab.textContent = new Date(hist[idx][0]).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // ---- area + line ----
  const gid = `g-${Math.random().toString(36).slice(2, 8)}`;
  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "linearGradient");
  grad.setAttribute("id", gid);
  grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
  const s1 = document.createElementNS(NS, "stop");
  s1.setAttribute("offset", "0%"); s1.setAttribute("stop-color", stroke); s1.setAttribute("stop-opacity", "0.22");
  const s2 = document.createElementNS(NS, "stop");
  s2.setAttribute("offset", "100%"); s2.setAttribute("stop-color", stroke); s2.setAttribute("stop-opacity", "0");
  grad.append(s1, s2); defs.append(grad); svg.append(defs);

  const linePts = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(2)},${Y(v).toFixed(2)}`).join(" ");
  const baseY = isPnl && lo < 0 && hi > 0 ? Y(0) : m.top + ih;
  add("path", { d: `${linePts} L${X(vals.length - 1).toFixed(2)},${baseY} L${X(0).toFixed(2)},${baseY} Z`, fill: `url(#${gid})`, stroke: "none" });
  add("path", { d: linePts, stroke }, "series-line");

  // latest-value dot
  add("circle", { cx: X(vals.length - 1), cy: Y(last), r: 3.5, fill: stroke });

  // ---- crosshair layer: readers aim at a date, never at a 2px line ----
  const cross = add("line", { x1: 0, x2: 0, y1: m.top, y2: m.top + ih, opacity: 0 }, "crosshair");
  const dot = add("circle", { cx: 0, cy: 0, r: 4.5, fill: stroke, opacity: 0 }, "focus-dot");
  const hit = add("rect", { x: m.left, y: m.top, width: iw, height: ih }, "hit-layer");

  const tip = el("div", { class: "tooltip" });
  // span, not div: the colour key and the value share one line.
  const tipVal = el("span", { class: "tt-value" });
  const tipLab = el("div", { class: "tt-label" });
  const key = el("span", { class: "tt-key" });
  key.style.background = stroke;
  tip.append(el("div", {}, [key, tipVal]), tipLab);

  wrap.replaceChildren(svg, tip);

  const show = (clientX) => {
    const box = svg.getBoundingClientRect();
    const rel = ((clientX - box.left) / box.width) * W;   // viewBox units
    const frac = (rel - m.left) / iw;
    const idx = Math.max(0, Math.min(hist.length - 1, Math.round(frac * (hist.length - 1))));
    const [ts, v] = hist[idx];

    cross.setAttribute("x1", X(idx)); cross.setAttribute("x2", X(idx)); cross.setAttribute("opacity", "1");
    dot.setAttribute("cx", X(idx)); dot.setAttribute("cy", Y(v)); dot.setAttribute("opacity", "1");

    tipVal.textContent = isPnl ? signedUsd(v) : usd(v);
    tipVal.className = "tt-value" + (isPnl ? ` delta ${dirClass(v)}` : "");
    tipLab.textContent = fmtTime(ts);

    tip.dataset.show = "1";
    const px = (X(idx) / W) * box.width;
    const py = (Y(v) / H) * box.height;
    const tw = tip.offsetWidth || 130;
    tip.style.left = `${Math.max(4, Math.min(box.width - tw - 4, px - tw / 2))}px`;
    tip.style.top = `${Math.max(0, py - tip.offsetHeight - 12)}px`;
  };
  const hide = () => {
    tip.dataset.show = "0";
    cross.setAttribute("opacity", "0");
    dot.setAttribute("opacity", "0");
  };

  hit.addEventListener("pointermove", (e) => show(e.clientX));
  hit.addEventListener("pointerdown", (e) => show(e.clientX));
  hit.addEventListener("pointerleave", hide);

  // keyboard parity: same details on focus as on hover
  let kb = hist.length - 1;
  hit.setAttribute("tabindex", "0");
  hit.addEventListener("focus", () => {
    const box = svg.getBoundingClientRect();
    show(box.left + (X(kb) / W) * box.width);
  });
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    kb = Math.max(0, Math.min(hist.length - 1, kb + (e.key === "ArrowRight" ? 1 : -1)));
    const box = svg.getBoundingClientRect();
    show(box.left + (X(kb) / W) * box.width);
  });

  // ---- table view: every tooltip value reachable without hovering ----
  const tbl = el("table", { class: "grid" });
  tbl.append(el("thead", {}, [el("tr", {}, [
    el("th", { attrs: { scope: "col" }, text: "Time" }),
    el("th", { class: "num", attrs: { scope: "col" }, text: isPnl ? "PnL" : "Equity" }),
  ])]));
  tbl.append(el("tbody", {}, hist.slice().reverse().map(([ts, v]) =>
    el("tr", {}, [
      el("td", { text: fmtTime(ts) }),
      el("td", { class: "num" }, [isPnl ? delta(v) : el("span", { text: usd(v) })]),
    ]))));
  tableBox.replaceChildren(tbl);
}

/* -------------------------------------------------------------- positions -- */
function renderPositions(t) {
  const box = $("#positions");
  $("#pos-count").textContent = t.positions.length
    ? `${t.positions.length} open · ${signedUsd(t.unrealised)} unrealised`
    : "";

  if (!t.positions.length) {
    box.replaceChildren(el("div", { class: "empty", text: "No open positions." }));
    return;
  }

  const head = ["Market", "Venue", "Side", "Size", "Notional", "Entry", "Mark", "Liq.", "Lev.", "Funding", "Unrealised", "Return"];
  const tbl = el("table", { class: "grid" });
  tbl.append(el("thead", {}, [el("tr", {}, head.map((h, i) =>
    el("th", { class: i >= 3 ? "num" : "", attrs: { scope: "col" }, text: h })))]));

  const rows = [...t.positions].sort((a, b) => Math.abs(num(b.positionValue)) - Math.abs(num(a.positionValue)));

  tbl.append(el("tbody", {}, rows.map((p) => {
    const szi = num(p.szi);
    const long = szi >= 0;
    const notional = num(p.positionValue);
    const mark = szi !== 0 ? notional / Math.abs(szi) : 0;
    const upnl = num(p.unrealizedPnl);
    const roe = num(p.returnOnEquity) * 100;
    const { symbol } = marketParts(p.coin);
    const lev = p.leverage ?? {};

    return el("tr", {}, [
      el("td", {}, [el("strong", { text: symbol })]),
      el("td", {}, [el("span", { class: "tag", text: dexLabel(p.dex) })]),
      el("td", {}, [el("span", { class: long ? "side-long" : "side-short", text: long ? "LONG" : "SHORT" })]),
      el("td", { class: "num", text: Math.abs(szi).toLocaleString(undefined, { maximumFractionDigits: 6 }) }),
      el("td", { class: "num", text: usd(notional) }),
      el("td", { class: "num", text: usd(num(p.entryPx), 4) }),
      el("td", { class: "num", text: usd(mark, 4) }),
      el("td", { class: "num", text: p.liquidationPx ? usd(num(p.liquidationPx), 4) : "—" }),
      el("td", { class: "num", text: `${lev.value ?? "—"}× ${lev.type === "isolated" ? "iso" : "cross"}` }),
      el("td", { class: "num" }, [delta(-num(p.cumFunding?.sinceOpen), { dp: 4 })]),
      el("td", { class: "num" }, [delta(upnl)]),
      el("td", { class: "num" }, [el("span", { class: `delta ${dirClass(roe)}`, text: pct(roe) })]),
    ]);
  })));

  box.replaceChildren(tbl);
}

/* ------------------------------------------------------------------ fills -- */
function renderFills(t) {
  const box = $("#fills");
  const fills = t.fills ?? [];
  const swaps = t.rh?.trades ?? [];

  $("#fill-count").textContent = (fills.length || swaps.length)
    ? `${fills.length + swaps.length} trade${fills.length + swaps.length === 1 ? "" : "s"}` +
      ` · ${signedUsd(t.realised)} realised`
    : "";

  // Robinhood Chain swaps: a token/ETH swap, not a perp fill, so it gets its
  // own table rather than being forced into the perp columns.
  if (swaps.length) renderSwapTable(t, swaps);
  else $("#swaps-panel").hidden = true;

  if (!fills.length) {
    box.replaceChildren(el("div", { class: "empty",
      text: swaps.length ? "No Hyperliquid fills — see Robinhood Chain swaps above."
                         : "No trades yet." }));
    return;
  }

  const head = ["Time", "Market", "Action", "Size", "Price", "Value", "Fee", "Realised"];
  const tbl = el("table", { class: "grid" });
  tbl.append(el("thead", {}, [el("tr", {}, head.map((h, i) =>
    el("th", { class: i >= 3 ? "num" : "", attrs: { scope: "col" }, text: h })))]));

  const rows = [...fills].sort((a, b) => b.time - a.time).slice(0, 250);

  tbl.append(el("tbody", {}, rows.map((f) => {
    const { symbol, venue } = marketParts(f.coin);
    const sz = num(f.sz), px = num(f.px);
    const closed = num(f.closedPnl);
    const isClose = /close|liquidat/i.test(f.dir ?? "");
    const isBuy = /long|buy|bid/i.test(f.dir ?? "");

    return el("tr", {}, [
      el("td", { text: fmtTime(f.time) }),
      el("td", {}, [
        el("strong", { text: symbol }),
        venue ? el("span", { class: "tag", text: venue }) : null,
      ]),
      el("td", {}, [el("span", { class: isBuy ? "side-long" : "side-short", text: f.dir ?? "—" })]),
      el("td", { class: "num", text: sz.toLocaleString(undefined, { maximumFractionDigits: 6 }) }),
      el("td", { class: "num", text: usd(px, 4) }),
      el("td", { class: "num", text: usd(sz * px) }),
      el("td", { class: "num", text: usd(num(f.fee), 4) }),
      el("td", { class: "num" }, [isClose ? delta(closed) : el("span", { class: "hint", text: "—" })]),
    ]);
  })));

  box.replaceChildren(tbl);
}

/** Robinhood Chain swap history, reconstructed from on-chain transfers. */
function renderSwapTable(t, swaps) {
  const panel = $("#swaps-panel");
  panel.hidden = false;
  const rate = t.rh.ethUsd;

  $("#swaps-count").textContent =
    `${swaps.length} swap${swaps.length === 1 ? "" : "s"} · newest first`;

  const head = ["Time", "Token", "Side", "Quantity", "ETH", "Value", "Realised"];
  const tbl = el("table", { class: "grid" });
  tbl.append(el("thead", {}, [el("tr", {}, head.map((h, i) =>
    el("th", { class: i >= 3 ? "num" : "", attrs: { scope: "col" }, text: h })))]));

  tbl.append(el("tbody", {}, swaps.slice(0, 250).map((s) => {
    const isBuy = s.side === "Buy" || s.side === "Received";
    return el("tr", {}, [
      el("td", { text: s.ts ? fmtTime(s.ts) : "—" }),
      el("td", {}, [el("strong", { text: s.symbol })]),
      el("td", {}, [el("span", { class: isBuy ? "side-long" : "side-short", text: s.side })]),
      el("td", { class: "num", text: s.qty.toLocaleString(undefined, { maximumFractionDigits: 4 }) }),
      el("td", { class: "num", text: s.eth ? s.eth.toFixed(6) : "—" }),
      el("td", { class: "num", text: s.eth ? usd(s.eth * rate) : "—" }),
      el("td", { class: "num" }, [
        s.pnlEth != null ? delta(s.pnlEth * rate) : el("span", { class: "hint", text: "—" }),
      ]),
    ]);
  })));

  $("#swaps").replaceChildren(tbl);
}

/* =============================== ROUTING ================================= */
function readRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const m = h.match(/^t\/(0x[0-9a-fA-F]{40})$/);
  if (m) {
    const addr = TRADERS.find((t) => t.address.toLowerCase() === m[1].toLowerCase())?.address;
    if (addr) { state.route = { view: "trader", address: addr }; return; }
  }
  state.route = { view: "board", address: null };
}

function onRouteChange() {
  readRoute();
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* ================================ WIRING ================================= */
function wire() {
  $("#period").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-period]");
    if (!b) return;
    state.period = b.dataset.period;
    for (const btn of $("#period").querySelectorAll("button")) {
      btn.setAttribute("aria-pressed", String(btn === b));
    }
    render();
  });

  $("#metric").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-metric]");
    if (!b) return;
    state.metric = b.dataset.metric;
    for (const btn of $("#metric").querySelectorAll("button")) {
      btn.setAttribute("aria-pressed", String(btn === b));
    }
    render();
  });

  document.querySelectorAll("#board th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort = state.sort.key === key
        ? { key, dir: state.sort.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" };
      renderBoard();
    });
  });

  $("#refresh").addEventListener("click", async () => {
    const btn = $("#refresh");
    btn.disabled = true;
    try { await loadAll({ full: true }); } finally { btn.disabled = false; }
  });

  window.addEventListener("hashchange", onRouteChange);

  // Pause polling when the tab is hidden; refresh immediately on return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopTimer();
    else { loadAll(); startTimer(); }
  });
}

function startTimer() {
  stopTimer();
  state.timer = setInterval(() => {
    state.refreshCount++;
    loadAll({ full: state.refreshCount % RESCAN_EVERY === 0 });
  }, REFRESH_MS);
}
function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/* ================================= BOOT ================================== */
wire();
readRoute();
render();
loadAll({ full: true }).then(startTimer);
