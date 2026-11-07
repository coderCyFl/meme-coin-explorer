#!/usr/bin/env node
/**
 * AI Watch A — build data/ai_targets.json (≤25 unique union).
 * Node 18+ built-in fetch; no packages. Uses js/strategy.js + Binance same-site filters.
 *
 *   node tools/top_coins.mjs
 *   node tools/top_coins.mjs --out data/ai_targets.json
 *   node tools/top_coins.mjs --fixtures /path/to/fixtures.json   # offline union test
 *
 * Buckets (each top 10): EarlyScore, Binance 24h gainers (USDT excl stables/leveraged),
 * memes by 24h volume (from data/meme_coins.json ∩ live spot). Deterministic dedupe + 25 cap.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = globalThis;
const Strategy = createRequire(import.meta.url)(ROOT + "/js/strategy.js");

const REST = "https://data-api.binance.vision/api/v3";
const STABLES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USDE", "XUSD", "USD1", "PAXG", "WBTC", "BFUSD", "EURI"]);
const MIN_QUOTE_VOL = 3e6;
const MAX_SCORE_COINS = 150;
const KLINE_LIMIT = 400;
const PER_BUCKET = 10;
const CAP = 25;
const REASON_ORDER = ["early", "gainer", "meme_volume"];

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1] ?? "true"]] : a), []),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) return r.json();
      if (r.status === 429 || r.status === 418) await sleep(4000 + i * 2000);
      else await sleep(800);
    } catch (_) {
      await sleep(1000);
    }
  }
  throw new Error("fetch failed: " + url);
}

function baseOf(sym) {
  return sym.endsWith("USDT") ? sym.slice(0, -4) : sym;
}
function spotEligible(t, { volumeFloor = false } = {}) {
  if (!t.symbol.endsWith("USDT")) return false;
  const base = baseOf(t.symbol);
  if (!base || STABLES.has(base)) return false;
  if (/(UP|DOWN|BULL|BEAR)$/.test(base) && base.length > 4) return false;
  if (!(+t.lastPrice > 0)) return false;
  if (volumeFloor && !(+t.quoteVolume >= MIN_QUOTE_VOL)) return false;
  return true;
}
function change24(t) {
  const o = +t.openPrice, c = +t.lastPrice;
  return o > 0 ? c / o - 1 : 0;
}

/** Pure merge: three buckets → ≤CAP entries + truncation disclosure. */
export function mergeTargets({ early = [], gainer = [], meme_volume = [] }, { perBucket = PER_BUCKET, cap = CAP } = {}) {
  const take = (arr) => arr.slice(0, perBucket);
  const buckets = {
    early: take(early),
    gainer: take(gainer),
    meme_volume: take(meme_volume),
  };
  const bySym = new Map();
  for (const reason of REASON_ORDER) {
    for (const row of buckets[reason]) {
      const symbol = row.symbol;
      if (!symbol) continue;
      const cur = bySym.get(symbol) || {
        symbol,
        base: row.base || baseOf(symbol),
        reason: [],
        score: null,
        change_24h: null,
        volume_24h: null,
      };
      if (!cur.reason.includes(reason)) cur.reason.push(reason);
      if (row.score != null && (cur.score == null || row.score > cur.score)) cur.score = row.score;
      if (row.change_24h != null && (cur.change_24h == null || Math.abs(row.change_24h) > Math.abs(cur.change_24h))) {
        cur.change_24h = row.change_24h;
      }
      if (row.volume_24h != null && (cur.volume_24h == null || row.volume_24h > cur.volume_24h)) {
        cur.volume_24h = row.volume_24h;
      }
      bySym.set(symbol, cur);
    }
  }
  const merged = [...bySym.values()].sort((a, b) => {
    const rc = b.reason.length - a.reason.length;
    if (rc) return rc;
    const sc = (b.score ?? -1) - (a.score ?? -1);
    if (sc) return sc;
    const ch = (b.change_24h ?? -Infinity) - (a.change_24h ?? -Infinity);
    if (ch) return ch;
    const vol = (b.volume_24h ?? 0) - (a.volume_24h ?? 0);
    if (vol) return vol;
    return a.symbol.localeCompare(b.symbol);
  });
  const before = merged.length;
  const entries = merged.slice(0, cap).map((e) => ({
    symbol: e.symbol,
    base: e.base,
    reason: e.reason.slice(),
    score: e.score,
    change_24h: e.change_24h,
    volume_24h: e.volume_24h,
  }));
  const dropped = merged.slice(cap).map((e) => e.symbol);
  return {
    entries,
    policy: {
      cap,
      per_bucket: perBucket,
      buckets: REASON_ORDER.slice(),
      dedupe:
        "Walk buckets early→gainer→meme_volume; merge reasons; sort by reason_count desc, score desc, change_24h desc, volume_24h desc, symbol asc; truncate to cap.",
      candidate_slots: perBucket * REASON_ORDER.length,
      unique_before_cap: before,
      truncation:
        dropped.length > 0
          ? { before_cap: before, dropped, note: `Dropped ${dropped.length} after unique merge exceeded cap ${cap}.` }
          : null,
    },
  };
}

async function klines(sym) {
  const k = await get(`${REST}/klines?symbol=${sym}&interval=15m&limit=${KLINE_LIMIT}`);
  return Strategy.parseKlines(k);
}

async function buildLive() {
  const memeDoc = JSON.parse(readFileSync(resolve(ROOT, "data/meme_coins.json"), "utf8"));
  const memeSet = new Set((memeDoc.coins || []).map((c) => c.symbol));
  const tick = await get(`${REST}/ticker/24hr?type=MINI`);

  const gainerPool = tick.filter((t) => spotEligible(t)).sort((a, b) => change24(b) - change24(a));
  const gainer = gainerPool.slice(0, PER_BUCKET).map((t) => ({
    symbol: t.symbol,
    base: baseOf(t.symbol),
    change_24h: +change24(t).toFixed(6),
    volume_24h: +(+t.quoteVolume).toFixed(2),
    score: null,
  }));

  const memePool = tick
    .filter((t) => memeSet.has(t.symbol) && spotEligible(t))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume);
  const meme_volume = memePool.slice(0, PER_BUCKET).map((t) => ({
    symbol: t.symbol,
    base: baseOf(t.symbol),
    change_24h: +change24(t).toFixed(6),
    volume_24h: +(+t.quoteVolume).toFixed(2),
    score: null,
  }));

  const scorePool = tick
    .filter((t) => spotEligible(t, { volumeFloor: true }))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, MAX_SCORE_COINS);
  const syms = scorePool.map((t) => t.symbol);
  if (!syms.includes("BTCUSDT")) syms.push("BTCUSDT");
  const bySymTick = Object.fromEntries(scorePool.map((t) => [t.symbol, t]));

  const series = {};
  let done = 0;
  for (let i = 0; i < syms.length; i += 6) {
    await Promise.all(
      syms.slice(i, i + 6).map(async (s) => {
        try {
          series[s] = await klines(s);
        } catch (e) {
          console.error(e.message);
        }
        done++;
        process.stderr.write(`\rscored-fetch ${Math.min(done, syms.length)}/${syms.length}`);
      }),
    );
  }
  process.stderr.write("\n");

  const btc = Strategy.indexSeries(series.BTCUSDT);
  const scored = [];
  for (const t of scorePool) {
    const s = series[t.symbol];
    if (!s || s.n < Strategy.MIN_BARS) continue;
    const r = Strategy.scoreAt(s, s.n - 1, btc, +t.lastPrice);
    if (!r) continue;
    scored.push({
      symbol: t.symbol,
      base: baseOf(t.symbol),
      score: r.score,
      stage: r.stage,
      change_24h: +change24(t).toFixed(6),
      volume_24h: +(+t.quoteVolume).toFixed(2),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const early = scored.slice(0, PER_BUCKET).map(({ symbol, base, score, change_24h, volume_24h }) => ({
    symbol,
    base,
    score,
    change_24h,
    volume_24h,
  }));

  const { entries, policy } = mergeTargets({ early, gainer, meme_volume });
  return {
    updated_at: new Date().toISOString(),
    source: {
      rest: REST,
      meme_coins: "data/meme_coins.json",
      meme_source: memeDoc.source,
      meme_fetched_at: memeDoc.fetched_at,
      strategy_earlyMin: Strategy.PARAMS.earlyMin,
      score_universe: scorePool.length,
      gainer_universe: gainerPool.length,
      meme_live: memePool.length,
    },
    buckets: { early, gainer, meme_volume },
    policy,
    entries,
  };
}

function buildFromFixtures(path) {
  const fx = JSON.parse(readFileSync(path, "utf8"));
  const { entries, policy } = mergeTargets(fx.buckets || fx, { perBucket: fx.per_bucket || PER_BUCKET, cap: fx.cap || CAP });
  return { updated_at: fx.updated_at || new Date().toISOString(), source: { fixtures: path }, buckets: fx.buckets || fx, policy, entries };
}

const outPath = resolve(ROOT, args.out || "data/ai_targets.json");
const doc = args.fixtures ? buildFromFixtures(resolve(ROOT, args.fixtures)) : await buildLive();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      out: outPath,
      entries: doc.entries.length,
      unique_before_cap: doc.policy.unique_before_cap,
      truncation: doc.policy.truncation,
      reasons: Object.fromEntries(REASON_ORDER.map((r) => [r, doc.entries.filter((e) => e.reason.includes(r)).length])),
    },
    null,
    2,
  ),
);
