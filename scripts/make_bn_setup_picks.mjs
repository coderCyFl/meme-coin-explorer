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
  const volToday = volD[volD.length - 1] || volQ;
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
  else if (angle === "accumulation") tip = `24h 只 ${f.chg24 >= 0 ? "+" : ""}${f.chg24.toFixed(1)}%，但成交較 7 日均高 ${(f.volCreep * 100 - 100).toFixed(0)}% · 靜吸`;
  else if (angle === "rotation") tip = `7 日跑輸 BTC ${(-f.relStrength).toFixed(1)} pt，量能開始回 · 輪動留意`;
  else if (angle === "compression") tip = `近幾日波幅收窄 ${(f.compression).toFixed(1)}×，輕觸上沿 · 唔係已爆升`;
  else if (angle === "mean_reversion") tip = `仍近區間中低位，量回暖 · 睇反彈多過追升`;
  else if (angle === "higher_lows") tip = `1h 抬高低位而 24h 未瘋 · 結構轉好`;
  else tip = `相對大盤偏弱後量能回 · 提早留意`;

  return { setupScore: Math.round(setupScore * 10) / 10, chaseScore: Math.round(chaseScore * 10) / 10, angle, tip, parts };
}

/** Diversify: hard multi-angle mix — max 1 per angle first, never pad same angle via catch-all. */
function diversifyPicks(scored, n = 6) {
  const ANGLE_ORDER = ["accumulation", "rotation", "compression", "mean_reversion", "higher_lows", "relative"];
  const SOFT = 2; // never more than 2 of same angle
  const setups = scored.filter((s) => !s.f.alreadyUp && !s.f.extended && s.setupScore >= 28)
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
    const relaxed = scored.slice().sort((a, b) => b.setupScore - a.setupScore);
    for (const s of relaxed) {
      if (out.length >= n) break;
      if (used.has(s.symbol)) continue;
      if (s.f.chg24 >= 8) continue;
      if (angN(s.angle) >= SOFT) continue;
      add(s);
    }
  }
  return out.slice(0, n);
}

async function main() {
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

  const picks = diversifyPicks(scored, 6);
  const chasing = scored.filter((s) => s.f.alreadyUp || s.f.extended)
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
  const batchId = "batch-004";

  const btcPx = +tickers.get("BTCUSDT")?.lastPrice || btcDaily.at(-1)?.c;
  const solPx = +tickers.get("SOLUSDT")?.lastPrice;

  const entries = picks.map((p, i) => ({
    id: `${day}-004-${p.base}`,
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
    flags: ["Binance USDT spot", "multi-angle setup", "not 24h gainer rank", `angle:${p.angle}`],
    evidence: {
      source: "binance-klines-1d-1h",
      symbol: p.symbol,
      note: "Setup scored from public OHLCV precursors; primary list excludes hard 24h pumps.",
    },
    horizons_h: [24, 72, 168],
  }));

  // avoid entries = chasing (label as avoid chase)
  for (const p of chasing) {
    entries.push({
      id: `${day}-004-AVOID-${p.base}`,
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

  const picksPath = path.join(ROOT, "data/picks.json");
  const doc = JSON.parse(fs.readFileSync(picksPath, "utf8"));
  doc.batches = (doc.batches || []).filter((b) => b.id !== batchId);
  doc.batches.push({
    id: batchId,
    created_at: isoHK,
    x_window: null,
    method: "scripts/make_bn_setup_picks.mjs multi-angle OHLCV precursors (vol creep, compression, RS vs BTC, rotation, accumulation); excludes hard 24h pumps from primary",
    benchmarks: {
      BTC: { chain: "binance", address: "binance:BTCUSDT", pair_address: "BTCUSDT", price_usd: btcPx },
      SOL: { chain: "binance", address: "binance:SOLUSDT", pair_address: "SOLUSDT", price_usd: solPx },
    },
    entries,
  });
  doc.description = "Append-only AI pick log. batch-003+ = multi-angle Binance setup (not 24h gainer rank).";
  fs.writeFileSync(picksPath, JSON.stringify(doc, null, 1) + "\n");
  console.log("wrote", batchId, "buys", picks.length, "avoids", chasing.length);

  // summary for parent
  fs.writeFileSync(path.join(ROOT, "data/raw/setup_last.json"), JSON.stringify({
    at: isoHK,
    picks: picks.map((p) => ({ base: p.base, chg24: p.f.chg24, setup: p.setupScore, angle: p.angle, tip: p.tip })),
    chasing: chasing.map((p) => ({ base: p.base, chg24: p.f.chg24 })),
    overlapTop6Gainers: overlap,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
