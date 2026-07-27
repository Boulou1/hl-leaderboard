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

/* --------------------------------------------------------------- fetching -- */
/**
 * Load one trader. `knownDexes` limits the position scan on light refreshes;
 * pass null to scan every venue.
 */
async function loadTrader(trader, knownDexes) {
  const dexes = knownDexes ?? (await loadDexes());

  const [portfolio, fills, ...states] = await Promise.all([
    info({ type: "portfolio", user: trader.address }),
    info({ type: "userFills", user: trader.address }),
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

  const equity = periods.allTime.avHist.length
    ? periods.allTime.avHist[periods.allTime.avHist.length - 1][1]
    : venues.reduce((s, v) => s + v.equity, 0);

  return {
    ...trader,
    ok: true,
    equity,
    unrealised,
    realised,
    feesPaid,
    positions,
    venues,
    fills: fillRows,
    periods,
    // "never traded anywhere" — distinct from "traded and went flat"
    isEmpty: equity === 0 && positions.length === 0 && fillRows.length === 0,
    dexesScanned: dexes,
  };
}

async function loadAll({ full = false } = {}) {
  setStatus("loading", "Refreshing…");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("is-stale"));

  await loadDexes();
  let failures = 0;

  // Sequential-with-small-batches: keeps well inside the info-endpoint rate
  // limit while still loading fast (7 traders x ~12 calls).
  for (const trader of TRADERS) {
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
        equity: 0, unrealised: 0, realised: 0, positions: [], venues: [],
        fills: [], periods: {}, isEmpty: false,
      });
    }
    render();
  }

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

function roiOf(t) {
  const p = periodOf(t);
  const base = p.startEquity > 0 ? p.startEquity : null;
  if (base) return (p.pnl / base) * 100;
  // Account funded mid-window: fall back to current equity less the gain.
  const implied = t.equity - p.pnl;
  return implied > 0 ? (p.pnl / implied) * 100 : 0;
}

/* --------------------------------------------------------- group summary -- */
function renderGroupTiles() {
  const rows = TRADERS.map((t) => state.byAddress.get(t.address)).filter(Boolean);
  const active = rows.filter((t) => t.ok && !t.isEmpty);

  const equity = active.reduce((s, t) => s + t.equity, 0);
  const pnl = active.reduce((s, t) => s + periodOf(t).pnl, 0);
  const volume = active.reduce((s, t) => s + periodOf(t).volume, 0);
  const openPos = active.reduce((s, t) => s + t.positions.length, 0);

  const ranked = [...active].sort((a, b) => periodOf(b).pnl - periodOf(a).pnl);
  const best = ranked[0];
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  const box = $("#group-tiles");
  box.replaceChildren(
    tile("Group equity", el("span", { text: rows.length ? compactUsd(equity) : "—" }),
      `${active.length} of ${TRADERS.length} funded`),
    tile(`Group PnL · ${PERIOD_LABEL[state.period]}`, delta(pnl),
      `${openPos} open position${openPos === 1 ? "" : "s"}`),
    tile("Top performer",
      best ? el("span", { text: best.name }) : el("span", { class: "hint", text: "—" }),
      best ? `${signedUsd(periodOf(best).pnl)} · ${pct(roiOf(best))}` : "no activity yet"),
    tile("Laggard",
      worst ? el("span", { text: worst.name }) : el("span", { class: "hint", text: "—" }),
      worst ? `${signedUsd(periodOf(worst).pnl)} · ${pct(roiOf(worst))}` : "—"),
    tile(`Volume · ${PERIOD_LABEL[state.period]}`, el("span", { text: compactUsd(volume) }), "notional traded"),
  );
}

/* ------------------------------------------------------------ leaderboard -- */
const SORTERS = {
  equity: (t) => t.equity,
  pnl:    (t) => periodOf(t).pnl,
  roi:    (t) => roiOf(t),
  unreal: (t) => t.unrealised,
  real:   (t) => t.realised,
  vol:    (t) => periodOf(t).volume,
};

function renderBoard() {
  const body = $("#board-body");
  const rows = TRADERS.map((t) => state.byAddress.get(t.address) ?? { ...t, pending: true });

  const { key, dir } = state.sort;
  const get = SORTERS[key] ?? SORTERS.pnl;
  const loaded = rows.filter((t) => !t.pending);
  const pending = rows.filter((t) => t.pending);

  // Never-funded accounts always sort last: they are not "worst", just absent.
  const funded = loaded.filter((t) => t.ok && !t.isEmpty);
  const rest = loaded.filter((t) => !(t.ok && !t.isEmpty));
  funded.sort((a, b) => (dir === "asc" ? get(a) - get(b) : get(b) - get(a)));

  const ordered = [...funded, ...rest, ...pending];

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

  const venueTags = dedupe(t.venues.map((v) => dexLabel(v.dex)));

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

  tr.append(
    el("td", { class: "num", text: usd(t.equity) }),
    el("td", { class: "num" }, [delta(p.pnl)]),
    el("td", { class: "num" }, [el("span", { class: `delta ${dirClass(p.pnl)}`, text: pct(roiOf(t)) })]),
    el("td", { class: "num" }, [delta(t.unrealised)]),
    el("td", { class: "num" }, [delta(t.realised)]),
    el("td", { class: "num", text: compactUsd(p.volume) }),
    el("td", { class: "num", text: String(t.positions.length) }),
    el("td", { class: "col-spark" }, [sparkline(p.pnlHist)]),
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

  $("#t-venues").replaceChildren(
    ...(t.venues.length
      ? dedupe(t.venues.map((v) => dexLabel(v.dex))).map((d) => el("span", { class: "tag", text: d }))
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

  $("#t-tiles").replaceChildren(
    tile("Equity", el("span", { text: usd(t.equity) }),
      t.venues.length ? t.venues.map((v) => `${dexLabel(v.dex)} ${usd(v.equity)}`).join(" · ") : "not funded"),
    tile(`PnL · ${PERIOD_LABEL[state.period]}`, delta(p.pnl), pct(roiOf(t)) + " on starting equity"),
    tile("Unrealised", delta(t.unrealised),
      `${t.positions.length} open position${t.positions.length === 1 ? "" : "s"}`),
    tile("Realised", delta(t.realised), `net of ${usd(t.feesPaid)} fees`),
    tile("Realised + unrealised", delta(totalPnl), "lifetime, from fills"),
    tile(`Volume · ${PERIOD_LABEL[state.period]}`, el("span", { text: compactUsd(p.volume) }),
      `${t.fills.length} fill${t.fills.length === 1 ? "" : "s"}`),
  );

  renderChart(t);
  renderPositions(t);
  renderFills(t);
}

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

  // A never-funded account still gets a full all-zero history back; plotting a
  // flat line on a +/-$1 axis is noise, so say so instead.
  const allZero = (hist ?? []).every(([, v]) => num(v) === 0);
  if (!hist || hist.length < 2 || (t.isEmpty && allZero)) {
    wrap.replaceChildren(el("div", { class: "empty",
      text: t.isEmpty ? "Nothing to chart — this wallet has never been funded."
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
  $("#fill-count").textContent = fills.length
    ? `${fills.length} fill${fills.length === 1 ? "" : "s"} · ${signedUsd(t.realised)} realised`
    : "";

  if (!fills.length) {
    box.replaceChildren(el("div", { class: "empty", text: "No trades yet." }));
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
