#!/usr/bin/env node
/**
 * Backtest the Early Score on REAL Binance candles, with a train/test split.
 * Used by the strategy bot to prove a change before it ships. Node 18+ (built-in fetch), no packages.
 *
 *   node tools/backtest.mjs                       # 10 days, top 80 coins, current PARAMS
 *   node tools/backtest.mjs --days 21 --coins 120
 *   node tools/backtest.mjs --set '{"earlyMin":75,"late24h":0.2}'
 *   node tools/backtest.mjs --out data/strategy/run.json
 *
 * Train = first half of the period (tune here). Test = second half (judge here — never tune on it).
 */
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = globalThis;
const Strategy = createRequire(import.meta.url)(ROOT + "/js/strategy.js");

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const DAYS = +(args.days || 10), COINS = +(args.coins || 80), STAKE = 0.10;
if (args.set) Strategy.setParams(JSON.parse(args.set));

const REST = "https://data-api.binance.vision/api/v3";
const STABLES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USDE", "XUSD", "USD1", "PAXG", "WBTC", "BFUSD", "EURI"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return r.json(); if (r.status === 429 || r.status === 418) await sleep(5000); } catch (_) { await sleep(1000); }
  }
  throw new Error("fetch failed: " + url);
}
async function klines(sym, bars) {
  const rows = []; let end = Date.now();
  while (rows.length < bars) {
    const k = await get(`${REST}/klines?symbol=${sym}&interval=15m&limit=1000&endTime=${end}`);
    if (!k.length) break;
    rows.unshift(...k); end = k[0][0] - 1;
    if (k.length < 1000) break;
  }
  return Strategy.parseKlines(rows.slice(-bars));
}

const tick = await get(`${REST}/ticker/24hr?type=MINI`);
const syms = tick.filter((t) => t.symbol.endsWith("USDT") && !STABLES.has(t.symbol.slice(0, -4)) && !/(UP|DOWN|BULL|BEAR)$/.test(t.symbol.slice(0, -4)) && +t.quoteVolume >= 3e6)
  .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, COINS).map((t) => t.symbol);
if (!syms.includes("BTCUSDT")) syms.push("BTCUSDT");
const BARS = DAYS * 96 + Strategy.MIN_BARS + 20;
const series = {};
let done = 0;
for (let i = 0; i < syms.length; i += 6) {
  await Promise.all(syms.slice(i, i + 6).map(async (s) => { try { series[s] = await klines(s, BARS); } catch (e) { console.error(e.message); } }));
  done += 6; process.stderr.write(`\rfetched ${Math.min(done, syms.length)}/${syms.length}`);
}
process.stderr.write("\n");
const btc = Strategy.indexSeries(series.BTCUSDT);
const t0 = Math.min(...Object.values(series).map((s) => s.t[Strategy.MIN_BARS] || Infinity)), t1 = Date.now(), mid = t0 + (t1 - t0) / 2;

function summarise(name, bt) {
  const days = new Map();
  for (const x of bt.trades) { const k = new Date(x.t).toISOString().slice(0, 10); days.set(k, (days.get(k) || 0) + x.ret * STAKE); }
  const daily = [...days.values()], ai = Strategy.allIn(bt.trades, 1000, STAKE);
  return { period: name, signals: bt.n, win_rate: +(bt.win * 100).toFixed(1), avg_per_trade_pct: +(bt.avg * 100).toFixed(3),
    median_pct: +(bt.median * 100).toFixed(3), random_entry_avg_pct: +(bt.baseline.avg * 100).toFixed(3),
    edge_vs_random_pct: +((bt.avg - bt.baseline.avg) * 100).toFixed(3), hit_target1_pct: +(bt.hitT1 * 100).toFixed(1),
    avg_day_10pct_stake: +(daily.reduce((a, b) => a + b, 0) / (daily.length || 1) * 100).toFixed(2),
    days_20pct_plus: daily.filter((d) => d >= 0.2).length, days: daily.length,
    allin_1000_to: +ai.end.toFixed(0), allin_max_drawdown_pct: +(ai.maxDD * 100).toFixed(1) };
}
const train = summarise("train", Strategy.backtest(series, btc, { to: mid }));
const test = summarise("test", Strategy.backtest(series, btc, { from: mid }));
const all = summarise("all", Strategy.backtest(series, btc));
const pass = test.signals >= 30 && test.avg_per_trade_pct > 0 && test.edge_vs_random_pct > 0;
console.table([train, test, all]);
console.log(`\nVERDICT: ${pass ? "PASS" : "FAIL"} — needs ≥30 test signals, positive average, and better than random entries on the TEST half.`);
console.log("PARAMS:", JSON.stringify(Strategy.PARAMS));
if (args.out) {
  mkdirSync(dirname(resolve(ROOT, args.out)), { recursive: true });
  writeFileSync(resolve(ROOT, args.out), JSON.stringify({ generated_at: new Date().toISOString(), days: DAYS, coins: syms.length, params: Strategy.PARAMS, train, test, all, verdict: pass ? "PASS" : "FAIL" }, null, 2));
  console.log("saved", args.out);
}
