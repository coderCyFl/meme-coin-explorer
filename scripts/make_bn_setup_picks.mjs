#!/usr/bin/env node
/**
 * Multi-angle Binance setup picks (NOT 24h gainer ranking).
 * Free public REST only. Writes batch onto data/picks.json (append).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BN = "https://data-api.binance.vision";

const CURATED = [
  "BTC","ETH","SOL","BNB","XRP","ADA","DOGE","AVAX","LINK","DOT",
  "NEAR","APT","ARB","OP","SUI","INJ","TIA","SEI","JUP","PYTH",
  "W","ENA","EIGEN","AAVE","UNI","LTC","BCH","ATOM","PEPE","SHIB",
  "FLOKI","BONK","WIF","BOME","MEME","NEIRO","PNUT","ACT","PENGU",
  "TRUMP","TURBO","ORDI","NOT","HMSTR","PEOPLE","ANIME","1000SATS",
  "1MBABYDOGE","WLD","MOVE","FET","RENDER","ONDO","PENDLE",
];

const MEME = new Set(["DOGE","PEPE","SHIB","FLOKI","BONK","WIF","BOME","MEME","NEIRO","PNUT","ACT","PENGU","TRUMP","TURBO","ORDI","NOT","HMSTR","PEOPLE","ANIME","1000SATS","1MBABYDOGE"]);
const MAJORS = new Set(["BTC","ETH","SOL","BNB"]);

// Setup-pick exit (Strategy+QA dry-run 2026-10-30, stamp 20261030e; /workspace/setup-exit-dryrun-20261030.md):
// TP +10% / SL −4% / review 6h / sell_by 12h for normal AND weak tape (weak keeps half size).
// Replay of the 50 sealed buys: EW −2.03% vs −3.15% (+8/−5/24h same trades). 🚀 chase keeps CH.* (unchanged).
export const SETUP_EXIT = { tp: 10, sl: 4, reviewH: 6, sellH: 12 };
// ¼ size gate: setup picks at ¼ until the rolling 7d average SEALED exit-aware return of setup buys (non-chase) > 0.
// "Sealed" = the same record snapshot_outcomes.py writes as the pick's seal: the first horizon in horizons_h
// (record.return_pct, exit-aware: SL/TP walked on 5m bars up to min(horizon, sell_by)). New setup picks
// (exit_rule setup_20261030e) seal at their 12h sell_by; legacy picks keep their recorded seal (24h). No 24h-only filter.
export const QUARTER = { mult: 0.25, windowD: 7 };
export function sealHoursOf(e) {
  const hz = Math.min(...((e.horizons_h && e.horizons_h.length) ? e.horizons_h : [24, 72, 168]));
  const t0 = Date.parse(e.created_at), sb = e.sell_by ? Date.parse(e.sell_by) : NaN;
  const sbH = isFinite(sb) && isFinite(t0) ? Math.round((sb - t0) / 3600e3) : null;
  return sbH != null && sbH > 0 && sbH < hz ? sbH : hz;
}
// First seal horizon per pick — mirrors snapshot_outcomes.py seal_horizons(): legacy picks = min(horizons_h) (24h);
// setup_20261030e non-chase buys add their sell_by hours (12h) as the first seal, so the gate reads the 12h row.
export function sealFirstH(e) {
  const hz = (e.horizons_h && e.horizons_h.length) ? e.horizons_h : [24, 72, 168];
  const m = Math.min(...hz);
  if (e.exit_rule === "setup_20261030e" && e.tier !== "chase" && (e.type || "buy") === "buy" && e.sell_by) {
    const t0 = Date.parse(e.created_at), sb = Date.parse(e.sell_by);
    const sbH = isFinite(sb) && isFinite(t0) ? Math.round((sb - t0) / 3600e3) : null;
    if (sbH != null && sbH > 0 && sbH < m) return sbH;
  }
  return m;
}
export function setupSizeGate(outcomes, picksDoc, nowMs = Date.now()) {
  const idx = new Map();
  for (const b of picksDoc.batches || []) for (const e of b.entries || []) idx.set(e.id, e);
  const since = nowMs - QUARTER.windowD * 86400e3;
  const seal = new Map(); // pick_id → seal record (first horizon written by snapshot_outcomes)
  for (const r of (outcomes && outcomes.records) || []) {
    if (r.return_pct == null) continue;
    const e = idx.get(r.pick_id);
    if (!e || e.type !== "buy" || e.tier === "chase") continue;
    const firstH = sealFirstH(e);
    if (r.horizon_h !== firstH) continue;
    if (!(Date.parse(e.created_at) >= since)) continue;
    seal.set(r.pick_id, { r, e });
  }
  const rets = [], byH = {};
  for (const { r, e } of seal.values()) {
    rets.push(+r.return_pct);
    const h = sealHoursOf(e);
    byH[h + "h"] = (byH[h + "h"] || 0) + 1;
  }
  const ew = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
  const on = ew != null && ew > 0;
  return {
    size: on ? "full" : "quarter",
    rolling7d_sealed_ew_pct: ew == null ? null : +ew.toFixed(2),
    n: rets.length,
    seal_hours: byH,
    rule: "setup picks ¼ size until rolling 7d avg sealed exit-aware return_pct (non-chase buys; seal = snapshot_outcomes first-horizon record, 12h sell_by for setup_20261030e, legacy 24h) > 0; 🚀 chase always full",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.json();
}

function parseKlines(arr) {
  return arr.map((c) => ({
    t: c[0],
    o: +c[1], h: +c[2], l: +c[3], c: +c[4],
    v: +c[5], qv: +c[7], n: +c[8],
  })).filter((b) => b.c > 0);
}

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** Features from 1d (~8 bars) + 1h (~48 bars) + ticker. */
function features(base, symbol, ticker, daily, hourly, btcDaily) {
  const chg24 = +ticker.priceChangePercent || 0;
  const price = +ticker.lastPrice || 0;
  const volQ = +ticker.quoteVolume || 0;
  const hi = +ticker.highPrice || price;
  const lo = +ticker.lowPrice || price;

  const d = daily.slice(-8);
  const h = hourly.slice(-48);
  const closedD = d.length > 1 ? d.slice(0, -1) : d; // exclude incomplete today if want; keep all for simplicity
  const retsD = [];
  for (let i = 1; i < d.length; i++) retsD.push((d[i].c / d[i - 1].c - 1) * 100);
  const volD = d.map((b) => b.qv);
  const volAvg7 = avg(volD.slice(0, -1)) || avg(volD) || 1;
  const volToday = volQ || volD[volD.length - 1]; // rolling 24h, not partial UTC day candle
  const volCreep = volToday / volAvg7;

  // Prior 3d avg vol vs earlier 3d
  const vRecent = avg(volD.slice(-4, -1)) || 1;
  const vPrior = avg(volD.slice(-7, -4)) || vRecent;
  const volRegime = vRecent / vPrior;

  // Compression: recent 3d range vs prior 3d range
  const range = (bars) => {
    if (!bars.length) return 0;
    const hh = Math.max(...bars.map((b) => b.h));
    const ll = Math.min(...bars.map((b) => b.l));
    const mid = (hh + ll) / 2 || 1;
    return ((hh - ll) / mid) * 100;
  };
  const rangeRecent = range(d.slice(-4));
  const rangePrior = range(d.slice(-7, -3)) || rangeRecent || 1;
  const compression = rangePrior / Math.max(rangeRecent, 0.01); // >1 = tighter now

  // Mild breakout: price near recent high but not extended 24h
  const recentHigh = Math.max(...d.slice(-5).map((b) => b.h), hi);
  const recentLow = Math.min(...d.slice(-5).map((b) => b.l), lo);
  const midRange = (recentHigh + recentLow) / 2 || price;
  const posInRange = (price - recentLow) / Math.max(recentHigh - recentLow, 1e-12); // 0..1
  const nearMidLow = posInRange < 0.55;

  // Higher lows on 1h
  const lowsH = h.slice(-24).map((b) => b.l);
  let higherLows = 0;
  if (lowsH.length >= 8) {
    const a = avg(lowsH.slice(0, 8)), b = avg(lowsH.slice(8, 16)), c = avg(lowsH.slice(16));
    if (b > a * 1.001 && c >= b * 0.998) higherLows = 1;
    else if (c > a * 1.002) higherLows = 0.5;
  }

  // 7d return vs BTC
  const ret7 = d.length >= 2 ? (d[d.length - 1].c / d[0].c - 1) * 100 : 0;
  let btcRet7 = 0;
  if (btcDaily && btcDaily.length >= 2) btcRet7 = (btcDaily[btcDaily.length - 1].c / btcDaily[0].c - 1) * 100;
  const relStrength = ret7 - btcRet7; // negative = lagged BTC

  // Mean-reversion candidate: red/flat 24h but volume up and near low half of range
  const meanRev = chg24 < 1 && chg24 > -8 && nearMidLow && volCreep > 1.15;

  // Accumulation: flat price, rising volume regime, compression
  const calmAccum = Math.abs(chg24) < 3 && volRegime > 1.1 && compression > 1.15 && posInRange < 0.65;

  // Rotation: lagged BTC over 7d, volume tick-up, not dumping hard today
  const rotation = relStrength < -3 && volCreep > 1.1 && chg24 > -5 && chg24 < 6;

  // Breakout setup: compression then mild break with volume
  const breakout = compression > 1.2 && posInRange > 0.55 && posInRange < 0.92 && volCreep > 1.2 && chg24 < 8;

  // Already pumping hard
  const alreadyUp = chg24 >= 8;
  const extended = chg24 >= 12 || (chg24 >= 6 && posInRange > 0.9);

  // Historical precursor echo: days that pumped >8% — what preceded?
  let precursorEcho = 0;
  for (let i = 2; i < retsD.length; i++) {
    if (retsD[i] > 8) {
      const volBefore = volD[i] / Math.max(avg(volD.slice(Math.max(0, i - 3), i)) || 1, 1);
      const retBefore = retsD[i - 1];
      if (volBefore > 1.15 && retBefore < 5) precursorEcho += 1;
    }
  }

  // Turnover quality: quote vol vs typical (log scale)
  const turnoverQ = clamp(Math.log10(Math.max(volQ, 1)) / 8, 0, 1); // ~1e8 => 1

  return {
    base, symbol, price, chg24, volQ, hi, lo,
    volCreep, volRegime, compression, posInRange, nearMidLow,
    higherLows, ret7, btcRet7, relStrength,
    meanRev, calmAccum, rotation, breakout, alreadyUp, extended,
    precursorEcho, turnoverQ, rangeRecent,
  };
}

/**
 * Multi-angle setup score. Penalize already-pumping as primary.
 * Returns { setupScore, chaseScore, angle, tip, parts }
 */
function scoreSetup(f) {
  const parts = {
    vol_creep: 0,
    compression: 0,
    relative: 0,
    higher_lows: 0,
    rotation: 0,
    accumulation: 0,
    breakout: 0,
    precursor_echo: 0,
    turnover: 0,
    chase_penalty: 0,
  };

  // Volume creep while not extended
  if (f.volCreep > 1.1 && f.chg24 < 6) parts.vol_creep = clamp((f.volCreep - 1) * 28, 0, 22);
  // Volatility compression
  if (f.compression > 1.1) parts.compression = clamp((f.compression - 1) * 18, 0, 16);
  // Relative lag vs BTC then interest
  if (f.relStrength < -2 && f.volCreep > 1.05) parts.relative = clamp(-f.relStrength * 1.8, 0, 18);
  // Higher lows on 1h
  parts.higher_lows = f.higherLows * 12;
  // Rotation / lag catch-up
  if (f.rotation) parts.rotation = 16 + clamp(-f.relStrength, 0, 8);
  // Calm accumulation
  if (f.calmAccum) parts.accumulation = 18;
  // Mild breakout (not chase)
  if (f.breakout) parts.breakout = 14;
  // Echo of past pump precursors
  parts.precursor_echo = clamp(f.precursorEcho * 6, 0, 12);
  // Liquidity/turnover quality
  parts.turnover = f.turnoverQ * 10;

  // Heavy penalty if already the green-candle leader
  if (f.alreadyUp) parts.chase_penalty = -35 - Math.min(20, (f.chg24 - 8) * 2);
  else if (f.chg24 > 5) parts.chase_penalty = -12;
  if (f.extended) parts.chase_penalty -= 15;
  // Dumping hard with no structure
  if (f.chg24 < -10 && !f.higherLows) parts.chase_penalty -= 10;

  const setupScore = clamp(
    Object.values(parts).reduce((a, b) => a + b, 0),
    0, 100
  );

  // Chase score for 「已在升／勿追」list
  const chaseScore = clamp(
    Math.min(40, Math.max(0, f.chg24) * 3.5) +
    Math.min(30, Math.log10(Math.max(f.volQ, 1)) * 4) +
    (f.posInRange > 0.85 ? 15 : 0),
    0, 100
  );

  // Pick primary angle for narrative diversity
  const angleScores = [
    ["accumulation", parts.accumulation + (f.calmAccum ? 5 : 0), "量增價穩 · 靜靜吸籌"],
    ["rotation", parts.rotation + (f.rotation ? 5 : 0), "滯後大盤 · 輪動候選"],
    ["compression", parts.compression + parts.breakout, "波幅收窄後輕突破"],
    ["mean_reversion", f.meanRev ? 20 + parts.vol_creep : parts.vol_creep, "偏低估位 · 量能回暖"],
    ["higher_lows", parts.higher_lows + parts.vol_creep * 0.3, "小時線抬高低位"],
    ["relative", parts.relative, "相對 BTC 偏弱後回神"],
  ];
  angleScores.sort((a, b) => b[1] - a[1]);
  const angle = angleScores[0][0];
  const tipCore = angleScores[0][2];

  // Forward-looking tip — why watch NOW, not because already up
  let tip = tipCore;
  if (f.alreadyUp) tip = `已急升 ${f.chg24.toFixed(1)}% · 宜勿追（只供對照）`;
  else if (angle === "accumulation") tip = `24h 只 ${f.chg24 >= 0 ? "+" : ""}${f.chg24.toFixed(1)}%，但成交較 7 日均${f.volCreep >= 1 ? "高" : "低"} ${Math.abs(f.volCreep * 100 - 100).toFixed(0)}% · 靜吸`;
  else if (angle === "rotation") tip = `7 日跑輸 BTC ${(-f.relStrength).toFixed(1)} pt，量能開始回 · 輪動留意`;
  else if (angle === "compression") tip = `近幾日波幅收窄 ${(f.compression).toFixed(1)}×，輕觸上沿 · 唔係已爆升`;
  else if (angle === "mean_reversion") tip = `仍近區間中低位，量回暖 · 睇反彈多過追升`;
  else if (angle === "higher_lows") tip = `1h 抬高低位而 24h 未瘋 · 結構轉好`;
  else tip = `相對大盤偏弱後量能回 · 提早留意`;

  return { setupScore: Math.round(setupScore * 10) / 10, chaseScore: Math.round(chaseScore * 10) / 10, angle, tip, parts };
}

/** 20261030g: angles never issued as setup buys (rotation 0W/7L sealed). */
const STOPPED_ANGLES = new Set(["rotation"]);
/** 20261030g: angles bought at ¼ size regardless of the 7d gate (higher_lows 1W/5L, 12h replay EW −2.43%). */
const QUARTER_ANGLES = new Set(["higher_lows"]);

/** Diversify: hard multi-angle mix — max 1 per angle first, never pad same angle via catch-all. */
function diversifyPicks(scored, n = 6) {
  // 20261030g (Strategy+QA): rotation stopped as a buy angle — sealed 0W/7L (12h replay EW −2.11%). Dropped, not padded.
  const ANGLE_ORDER = ["accumulation", "compression", "mean_reversion", "higher_lows", "relative"];
  const SOFT = 2; // never more than 2 of same angle
  const setups = scored.filter((s) => !s.f.alreadyUp && !s.f.extended && s.setupScore >= 28 && !MAJORS.has(s.base) && !STOPPED_ANGLES.has(s.angle))
    .sort((a, b) => b.setupScore - a.setupScore);
  const out = [];
  const usedAngle = new Map();
  const used = new Set();
  const angN = (a) => usedAngle.get(a) || 0;
  const add = (s) => {
    out.push(s);
    used.add(s.symbol);
    usedAngle.set(s.angle, angN(s.angle) + 1);
  };

  for (const ang of ANGLE_ORDER) {
    if (out.length >= n) break;
    const s = setups.find((x) => !used.has(x.symbol) && x.angle === ang);
    if (s) add(s);
  }

  while (out.length < n) {
    let next = setups.find((x) => !used.has(x.symbol) && angN(x.angle) === 0);
    if (!next) next = setups.find((x) => !used.has(x.symbol) && angN(x.angle) < SOFT);
    if (!next) break;
    add(next);
  }

  if (out.length < n) {
    // Same MEGA/MAJORS skip as Pass 1–2 — do not let BTC/ETH/SOL/BNB back in via relaxed fill
    const relaxed = scored.slice().sort((a, b) => b.setupScore - a.setupScore);
    for (const s of relaxed) {
      if (out.length >= n) break;
      if (used.has(s.symbol)) continue;
      if (MAJORS.has(s.base)) continue;
      if (STOPPED_ANGLES.has(s.angle)) continue;
      if (s.f.chg24 >= 8) continue;
      if (angN(s.angle) >= SOFT) continue;
      add(s);
    }
  }
  return out.slice(0, n);
}

// ---- 🚀 續升買 chase (Strategy BOT 2026-10-30; mirrors scripts/gainer_core.py chase_ok) ----
// All eligible Binance USDT spot (not just CURATED): 24h +10..+30%, ≤5% below 24h high, last CLOSED 1h quote vol
// ≥ 2x prior-24h hourly avg, that 1h candle up, 24h vol ≥ $1.5M (< $3M = 細盤 → size:bonus). Paper BUY with
// exit_plan +20% half / +50% clear / −10% / sell_by 24h. NOT part of the early-capture scorecard (tier:"chase").
const CH = { c24Min: 10, c24Max: 30, fhMin: -2, vr: 2, minQv: 1.5e6, smallQv: 3e6, tp: 20, tp2: 50, sl: 10, reviewH: 4, sellH: 24, max: 6 };
const CH_STABLE = new Set(["USDC","FDUSD","TUSD","USDP","DAI","BUSD","EUR","EURI","AEUR","XUSD","USD1","BFUSD","USDE","USDEB","U","FRAX","RLUSD","USDS","RWUSD","PYUSD","PAXG","XAUT","WBTC","WBETH","BNSOL"]);
const CH_LEV_OK = new Set(["JUP", "SYRUP", "SUP"]);
async function scanChase(listed) {
  let tokenized = new Set();
  try { tokenized = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "data/gainer_board/tokenized_stocks.json"), "utf8")).bases || []); } catch (_) {}
  const all = await getJson(BN + "/api/v3/ticker/24hr");
  const cands = [];
  for (const x of all) {
    const sym = x.symbol;
    if (!sym.endsWith("USDT") || !listed.has(sym)) continue;
    const base = sym.slice(0, -4);
    if (CH_STABLE.has(base) || tokenized.has(base) || (/(UP|DOWN|BULL|BEAR)$/.test(base) && !CH_LEV_OK.has(base))) continue;
    const last = +x.lastPrice, hi = +x.highPrice, qv = +x.quoteVolume, chg = +x.priceChangePercent;
    if (!(last > 0 && hi > 0) || qv < CH.minQv) continue;
    const fh = (last / hi - 1) * 100;
    if (chg >= CH.c24Min && chg <= CH.c24Max && fh >= CH.fhMin) cands.push({ symbol: sym, base, last, hi, lo: +x.lowPrice, qv, chg, fh });
  }
  const out = [];
  for (const c of cands.sort((a, b) => b.chg - a.chg).slice(0, 30)) {
    try {
      const h = parseKlines(await getJson(BN + `/api/v3/klines?symbol=${c.symbol}&interval=1h&limit=26`));
      await sleep(60);
      if (h.length < 26) continue;
      const j = h.length - 2;                     // last CLOSED 1h bar (h[j+1] is forming)
      const prev = h.slice(j - 24, j).map((b) => b.qv);
      const vr = h[j].qv / (avg(prev) || Infinity);
      const up = h[j].c > h[j].o && c.last >= h[j].o;
      if (vr >= CH.vr && up) out.push({ ...c, vr, c1: (h[j].c / h[j].o - 1) * 100, small: c.qv < CH.smallQv });
    } catch (e) { console.warn("chase kline fail", c.symbol, e.message); }
  }
  return out.sort((a, b) => b.vr - a.vr).slice(0, CH.max);
}

// ---- One batch per Asia/Shanghai day. `--force` (or env PICKS_FORCE=1) bypasses. ----
const PICKS_PATH = path.join(ROOT, "data/picks.json");
const FORCE = process.argv.includes("--force") || process.env.PICKS_FORCE === "1";
const shDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** Returns the last batch if its created_at falls on today's Asia/Shanghai date, else null. */
function todaysBatch() {
  const doc = JSON.parse(fs.readFileSync(PICKS_PATH, "utf8"));
  const last = (doc.batches || []).at(-1);
  if (!last || !last.created_at) return null;
  const t = new Date(last.created_at);
  if (Number.isNaN(t.getTime())) return null;
  return shDate(t) === shDate(new Date()) ? last : null;
}
function skipIfToday(when) {
  if (FORCE) return false;
  const b = todaysBatch();
  if (!b) return false;
  console.log(`SKIP (${when}): today's batch already exists — ${b.id} created_at ${b.created_at} (Asia/Shanghai ${shDate(new Date())}). Nothing written. Use --force to add another.`);
  return true;
}

async function main() {
  if (skipIfToday("start")) return;
  if (FORCE) console.log("--force: same-day check bypassed");
  console.log("exchangeInfo…");
  const info = await getJson(BN + "/api/v3/exchangeInfo");
  const listed = new Set(
    (info.symbols || [])
      .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT" && s.isSpotTradingAllowed)
      .map((s) => s.symbol)
  );
  const symbols = CURATED.map((b) => b + "USDT").filter((s) => listed.has(s));
  console.log("symbols", symbols.length);

  // tickers in chunks
  const tickers = new Map();
  for (let i = 0; i < symbols.length; i += 40) {
    const slice = symbols.slice(i, i + 40);
    const q = encodeURIComponent(JSON.stringify(slice));
    const arr = await getJson(BN + "/api/v3/ticker/24hr?symbols=" + q);
    for (const t of arr) tickers.set(t.symbol, t);
    await sleep(80);
  }

  console.log("BTC daily…");
  const btcDaily = parseKlines(await getJson(BN + "/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=8"));

  const scored = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const base = symbol.replace(/USDT$/, "");
    const ticker = tickers.get(symbol);
    if (!ticker) continue;
    try {
      const daily = parseKlines(await getJson(BN + `/api/v3/klines?symbol=${symbol}&interval=1d&limit=8`));
      await sleep(60);
      const hourly = parseKlines(await getJson(BN + `/api/v3/klines?symbol=${symbol}&interval=1h&limit=48`));
      await sleep(60);
      const f = features(base, symbol, ticker, daily, hourly, btcDaily);
      const sc = scoreSetup(f);
      scored.push({ ...sc, f, base, symbol });
      process.stdout.write(`\r${i + 1}/${symbols.length} ${base} setup=${sc.setupScore} angle=${sc.angle} chg=${f.chg24.toFixed(1)}   `);
    } catch (e) {
      console.warn("\nfail", symbol, e.message);
    }
  }
  console.log("\n");

  // Market-regime gate: in a risk-off tape, fewer + relatively-strong longs only, half size.
  const btcT = tickers.get("BTCUSDT");
  const btc24 = btcT ? +btcT.priceChangePercent : 0;
  const breadth = scored.length ? scored.filter((s) => s.f.chg24 > 0).length / scored.length : 0.5;
  const weak = btc24 < -2 || breadth < 0.3;
  const regime = {
    state: weak ? "weak" : "normal",
    btc24h_pct: +btc24.toFixed(2),
    breadth_up_pct: +(breadth * 100).toFixed(1),
    sizing: weak ? "half" : "full",
    rule: "weak if BTC 24h < -2% or <30% of scanned coins green; weak => max 4 buys ranked by RS vs BTC, half size",
  };
  console.log("regime", regime);
  let picks = diversifyPicks(scored, 6);
  if (weak) picks = picks.filter((p) => p.setupScore >= 28).sort((a, b) => b.f.relStrength - a.f.relStrength).slice(0, 4); // no relaxed fill in weak tape
  let chaseHits = [];
  try { chaseHits = await scanChase(listed); } catch (e) { console.warn("chase scan failed (non-fatal):", e.message); }
  console.log("=== 🚀 續升買 ===");
  for (const c of chaseHits) console.log(c.base, "chg24", c.chg.toFixed(2), "fh", c.fh.toFixed(2), "vr", c.vr.toFixed(2), c.small ? "細盤" : "");
  const chaseSyms = new Set(chaseHits.map((c) => c.symbol));
  const chasing = scored.filter((s) => (s.f.alreadyUp || s.f.extended) && !chaseSyms.has(s.symbol))
    .sort((a, b) => b.chaseScore - a.chaseScore)
    .slice(0, 4);

  console.log("=== 今日跟買 (setups) ===");
  for (const p of picks) {
    console.log(p.base, "chg24", p.f.chg24.toFixed(2), "setup", p.setupScore, p.angle, "|", p.tip);
  }
  console.log("=== 已在升／勿追 ===");
  for (const p of chasing) {
    console.log(p.base, "chg24", p.f.chg24.toFixed(2), "chase", p.chaseScore);
  }

  // Assert: not all top 24h gainers
  const byChg = [...scored].sort((a, b) => b.f.chg24 - a.f.chg24).slice(0, 6).map((s) => s.symbol);
  const pickSyms = picks.map((p) => p.symbol);
  const overlap = pickSyms.filter((s) => byChg.includes(s)).length;
  console.log("overlap with top6 24h gainers:", overlap, "/", picks.length);
  if (overlap >= picks.length - 1 && picks.length >= 4) {
    console.error("FAIL: picks look like 24h gainer list");
    process.exit(2);
  }

  const now = new Date();
  const hk = new Date(now.getTime() + 8 * 3600e3);
  const isoHK = hk.toISOString().replace("Z", "+08:00").replace(/\.\d{3}/, "");
  const day = isoHK.slice(0, 10).replace(/-/g, "");
  // Auto-increment: never clobber an existing batch id (append-only log).
  const picksPathEarly = path.join(ROOT, "data/picks.json");
  const docEarly = JSON.parse(fs.readFileSync(picksPathEarly, "utf8"));
  const existingNums = (docEarly.batches || [])
    .map((b) => Number(String(b.id || "").replace(/^batch-/, "")))
    .filter((n) => Number.isFinite(n));
  const nextN = (existingNums.length ? Math.max(...existingNums) : 0) + 1;
  const batchNum = String(nextN).padStart(3, "0");
  const batchId = `batch-${batchNum}`;

  const btcPx = +tickers.get("BTCUSDT")?.lastPrice || btcDaily.at(-1)?.c;
  const solPx = +tickers.get("SOLUSDT")?.lastPrice;

  let sizeGate = { size: "quarter", rolling7d_sealed_ew_pct: null, seal_hours: {}, n: 0, rule: "no outcomes → ¼ (fail-safe)" };
  try {
    const outc = JSON.parse(fs.readFileSync(path.join(ROOT, "data/outcomes.json"), "utf8"));
    sizeGate = setupSizeGate(outc, docEarly, now.getTime());
  } catch (e) { console.warn("size gate: outcomes unreadable, default ¼:", e.message); }
  console.log("setup size gate", sizeGate);

  const qtrOf = (p) => sizeGate.size === "quarter" || QUARTER_ANGLES.has(p.angle);
  const entries = picks.map((p, i) => ({
    id: `${day}-${batchNum}-${p.base}`,
    batch: batchId,
    type: "buy",
    created_at: isoHK,
    chain: "binance",
    token_address: "binance:" + p.symbol,
    pair_address: p.symbol,
    dex: "binance-spot",
    symbol: p.base,
    name: p.base + " (Binance)",
    url: `https://www.binance.com/en/trade/${p.base}_USDT`,
    entry_price_usd: p.f.price,
    entry_snapshot: {
      liquidity_usd: 1e12,
      volume24h_usd: p.f.volQ,
      market_cap_usd: null,
      fdv_usd: null,
      pair_age_h: null,
      chg24h_pct: p.f.chg24,
      high24h: p.f.hi,
      low24h: p.f.lo,
      vol_creep: +p.f.volCreep.toFixed(3),
      rel_vs_btc_7d: +p.f.relStrength.toFixed(2),
      compression: +p.f.compression.toFixed(3),
      angle: p.angle,
    },
    model_score: Math.round(p.setupScore),
    score_parts: p.parts,
    conviction: Math.round(p.setupScore),
    rationale: p.tip + `（角度：${p.angle}。唔係因為 24h 已經升最多；用 1d+1h OHLCV 睇量能／壓縮／相對 BTC／輪動。）`,
    tip: p.tip,
    angle: p.angle,
    flags: ["Binance USDT spot", "multi-angle setup", "not 24h gainer rank", `angle:${p.angle}`]
      .concat(weak ? ["regime:weak", "size:half"] : [])
      .concat(qtrOf(p) ? ["size:quarter"] : [])
      .concat(QUARTER_ANGLES.has(p.angle) ? ["size:quarter_angle"] : []),
    size: qtrOf(p) ? "quarter" : (weak ? "half" : "full"),
    exitRegime: weak ? "weak" : "normal",
    exit_rule: "setup_20261030e",
    suggested_exit_h: SETUP_EXIT.reviewH,
    suggested_second_h: SETUP_EXIT.sellH,
    take_profit_pct: SETUP_EXIT.tp,
    stop_loss_pct: SETUP_EXIT.sl,
    evidence: {
      source: "binance-klines-1d-1h",
      symbol: p.symbol,
      note: "Setup scored from public OHLCV precursors; primary list excludes hard 24h pumps.",
    },
    horizons_h: [SETUP_EXIT.sellH, 24, 72, 168], // 12h seal at sell_by (20261030f); 24/72/168 kept for the board
  }));

  // 🚀 續升買 entries — paper BUY (not watch-only), momentum exit, not halved by the weak-tape gate.
  for (const c of chaseHits) {
    if (entries.some((e) => e.pair_address === c.symbol)) continue;
    entries.push({
      id: `${day}-${batchNum}-CHASE-${c.base}`, batch: batchId, type: "buy", tier: "chase", exitRegime: "momentum",
      created_at: isoHK, chain: "binance", token_address: "binance:" + c.symbol, pair_address: c.symbol, dex: "binance-spot",
      symbol: c.base, name: c.base + " (Binance)", url: `https://www.binance.com/en/trade/${c.base}_USDT`,
      entry_price_usd: c.last,
      entry_snapshot: { liquidity_usd: 1e12, volume24h_usd: c.qv, market_cap_usd: null, fdv_usd: null, pair_age_h: null,
        chg24h_pct: +c.chg.toFixed(3), high24h: c.hi, low24h: c.lo, from_high_pct: +c.fh.toFixed(2), vol_ratio_1h: +c.vr.toFixed(2),
        c1h_pct: +c.c1.toFixed(2), angle: "chase", tier: "chase" },
      model_score: null, score_parts: null, conviction: null,
      rationale: `🚀 續升買：24h +${c.chg.toFixed(1)}%、離 24h 高 ${c.fh.toFixed(1)}%、1h 成交 ${c.vr.toFixed(1)}x、1h 仲升緊 → 紙上跟買。`,
      tip: "🚀 續升買 · 可追", angle: "chase",
      flags: ["Binance USDT spot", "tier:chase", "angle:chase", c.small ? "size:bonus" : "size:full"],
      size: c.small ? "bonus" : "full",
      suggested_exit_h: CH.reviewH, suggested_second_h: CH.sellH,
      take_profit_pct: CH.tp, take_profit2_pct: CH.tp2, stop_loss_pct: CH.sl,
      evidence: { source: "binance-24hr-ticker+klines-1h", symbol: c.symbol, note: "gainer_core.chase_ok mirror; separate from early-capture scorecard" },
      horizons_h: [24, 72, 168],
    });
  }

  // Explicit exit plan on every buy: target price, stop price, when to review, latest sell time.
  // Derived from the same TP/SL % and review/second hours above (no change to sizing or pick count).
  const roundPx = (x) => +Number(x).toPrecision(6);
  const addH = (h) => new Date(now.getTime() + h * 3600e3 + 8 * 3600e3).toISOString().replace("Z", "+08:00").replace(/\.\d{3}/, "");
  for (const e of entries) {
    const tp = e.take_profit_pct, sl = e.stop_loss_pct;
    e.target_price_usd = roundPx(e.entry_price_usd * (1 + tp / 100));
    e.stop_price_usd = roundPx(e.entry_price_usd * (1 - sl / 100));
    e.review_at = addH(e.suggested_exit_h);
    e.sell_by = addH(e.suggested_second_h);
    e.exit_plan = `目標 +${tp}%（$${e.target_price_usd}）· 止蝕 −${sl}%（$${e.stop_price_usd}）· ${e.suggested_exit_h}h 檢討 · 最遲 ${e.suggested_second_h}h 沽`;
    if (e.size === "quarter") e.exit_plan += (e.flags || []).includes("size:quarter_angle") && sizeGate.size !== "quarter" ? " · ¼注（結構類未轉正）" : " · ¼注（近 7d 跟買未轉正）";
    if (e.tier === "chase") {
      e.target2_price_usd = roundPx(e.entry_price_usd * (1 + e.take_profit2_pct / 100));
      e.exit_plan = `+${tp}% 放一半（$${e.target_price_usd}）· +${e.take_profit2_pct}% 清（$${e.target2_price_usd}）· 止蝕 −${sl}%（$${e.stop_price_usd}）· ${e.suggested_exit_h}h 檢討 · 最遲 ${e.suggested_second_h}h 沽`;
    }
  }
  // Hard check: never write a buy without target, stop and sell timing.
  for (const e of entries) {
    const bad = ["entry_price_usd", "take_profit_pct", "stop_loss_pct", "suggested_exit_h", "suggested_second_h", "target_price_usd", "stop_price_usd"]
      .filter((k) => !(Number.isFinite(e[k]) && e[k] > 0));
    if (!e.review_at || !e.sell_by) bad.push("review_at/sell_by");
    if (!(e.target_price_usd > e.entry_price_usd && e.stop_price_usd < e.entry_price_usd)) bad.push("target/stop vs entry");
    if (bad.length) {
      console.error("FAIL: buy entry", e.id, "missing/invalid exit fields:", bad.join(","));
      process.exit(3);
    }
  }

  // avoid entries = chasing (label as avoid chase)
  for (const p of chasing) {
    entries.push({
      id: `${day}-${batchNum}-AVOID-${p.base}`,
      batch: batchId,
      type: "avoid",
      created_at: isoHK,
      chain: "binance",
      token_address: "binance:" + p.symbol,
      pair_address: p.symbol,
      dex: "binance-spot",
      symbol: p.base,
      name: p.base + " (Binance)",
      url: `https://www.binance.com/en/trade/${p.base}_USDT`,
      entry_price_usd: p.f.price,
      entry_snapshot: {
        liquidity_usd: 1e12,
        volume24h_usd: p.f.volQ,
        chg24h_pct: p.f.chg24,
        high24h: p.f.hi,
        low24h: p.f.lo,
        angle: "already_up",
      },
      model_score: Math.round(p.chaseScore),
      score_parts: { chase: p.chaseScore },
      conviction: Math.round(p.chaseScore),
      rationale: `已在升 ${p.f.chg24.toFixed(1)}% · 勿追高。只放對照清單。`,
      tip: `已急升 · 勿追`,
      angle: "already_up",
      flags: ["already pumping", "do not chase"],
      evidence: { source: "binance-24hr-ticker", symbol: p.symbol },
      horizons_h: [24, 72, 168],
    });
  }

  // Re-read from disk right before writing (file may have changed during the ~20s fetch) and recheck.
  if (skipIfToday("pre-write")) return;
  const picksPath = PICKS_PATH;
  const doc = JSON.parse(fs.readFileSync(picksPath, "utf8"));
  if ((doc.batches || []).some((b) => b.id === batchId)) {
    console.error(`FAIL: ${batchId} appeared in data/picks.json while fetching — not overwriting (append-only). Re-run.`);
    process.exit(4);
  }
  doc.batches = doc.batches || [];
  doc.batches.push({
    id: batchId,
    created_at: isoHK,
    x_window: null,
    method: "scripts/make_bn_setup_picks.mjs multi-angle OHLCV precursors (vol creep, compression, RS vs BTC, accumulation); rotation stopped + higher_lows ¼ (20261030g); excludes hard 24h pumps from primary",
    regime,
    setup_size_gate: sizeGate,
    setup_exit: SETUP_EXIT,
    benchmarks: {
      BTC: { chain: "binance", address: "binance:BTCUSDT", pair_address: "BTCUSDT", price_usd: btcPx },
      SOL: { chain: "binance", address: "binance:SOLUSDT", pair_address: "SOLUSDT", price_usd: solPx },
    },
    entries,
  });
  doc.description = "Append-only AI pick log. batch-003+ = multi-angle Binance setup (not 24h gainer rank).";
  fs.writeFileSync(picksPath, JSON.stringify(doc, null, 1) + "\n");
  console.log("wrote", batchId, "buys", picks.length, "chase", chaseHits.length, "avoids", chasing.length);

  // summary for parent
  fs.mkdirSync(path.join(ROOT, "data/raw"), { recursive: true }); // data/raw is gitignored → absent on CI checkout
  fs.writeFileSync(path.join(ROOT, "data/raw/setup_last.json"), JSON.stringify({
    at: isoHK,
    picks: picks.map((p) => ({ base: p.base, chg24: p.f.chg24, setup: p.setupScore, angle: p.angle, tip: p.tip })),
    chasing: chasing.map((p) => ({ base: p.base, chg24: p.f.chg24 })),
    overlapTop6Gainers: overlap,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
