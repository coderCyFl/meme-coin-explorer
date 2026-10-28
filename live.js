/* Binance-first live marks: public REST+WS (no API key).
 * Dex poll kept only for legacy paper positions that are not on Binance. */
(() => {
  "use strict";
  const BN_REST = "https://data-api.binance.vision";
  const BN_WS = "wss://data-stream.binance.vision/stream";
  const DEX_POLL_MS = 4000;
  const UI_THROTTLE_MS = 400;
  const KLINE_TTL_MS = 60_000;

  // Curated USDT spot bases — majors + meme-ish. Only shown if TRADING.
  const CURATED_BASES = [
    "BTC", "ETH", "BNB", "XRP", "ADA", "DOGE", "AVAX", "LINK", "DOT", "SOL",
    "NEAR", "APT", "ARB", "OP", "SUI", "INJ", "TIA", "SEI", "JUP", "PYTH",
    "W", "ENA", "EIGEN", "AAVE", "UNI", "LTC", "BCH", "ATOM", "PEPE", "SHIB",
    "FLOKI", "BONK", "WIF", "BOME", "MEME", "NEIRO", "PNUT", "ACT", "PENGU",
    "TRUMP", "TURBO", "ORDI", "NOT", "HMSTR", "PEOPLE", "ANIME", "1000SATS",
    "1MBABYDOGE", "WLD", "MOVE", "FET", "RENDER", "ONDO", "PENDLE",
  ];

  const MINT_TO_BN = {
    "solana:So11111111111111111111111111111111111111112": "SOLUSDT",
    "solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONKUSDT",
    "solana:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIFUSDT",
    "solana:ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82": "BOMEUSDT",
    "solana:6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN": "TRUMPUSDT",
    "ethereum:0x6982508145454ce325ddbe47a25d4ec3d2311933": "PEPEUSDT",
    "ethereum:0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce": "SHIBUSDT",
    "ethereum:0xcf0c122c6b73ff809c693db761e7baebe62b6a2e": "FLOKIUSDT",
    "bsc:0xba2ae424d960c26247dd6c32edc70b295c744c43": "DOGEUSDT",
  };

  /** Real coin logos with CDN fallbacks. Letter avatar last — no emoji mascots. */
  const LOGO_ALIAS = {
    "1000SATS": "1000sats", "1MBABYDOGE": "babydoge", BOME: "bome", WIF: "wif",
    BONK: "bonk", PEPE: "pepe", SHIB: "shib", FLOKI: "floki", NEIRO: "neiro",
    PNUT: "pnut", PENGU: "pengu", TRUMP: "trump", RENDER: "render", FET: "fet",
  };
  function logoCandidates(base) {
    const raw = String(base || "").toUpperCase();
    if (!raw) return [];
    const lower = (LOGO_ALIAS[raw] || raw).toLowerCase();
    // Binance's own asset logo (data/bn_assets.json, loaded by market.js) first, then static guesses.
    const own = window.MCE && window.MCE.market && window.MCE.market.assetLogo ? window.MCE.market.assetLogo(raw) : "";
    return [
      ...(own ? [own] : []),
      "https://bin.bnbstatic.com/static/assets/logos/" + encodeURIComponent(raw) + ".png",
      "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/" + encodeURIComponent(lower) + ".png",
      "https://assets.coincap.io/assets/icons/" + encodeURIComponent(lower) + "@2x.png",
    ];
  }
  function logoUrl(base) {
    const c = logoCandidates(base);
    return c[0] || "";
  }
  function letterAvatar(base, className) {
    const s = document.createElement("span");
    s.className = (className || "coin-logo") + " letter";
    s.textContent = String(base || "?").slice(0, 2).toUpperCase();
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  function coinLogoEl(base, className = "coin-logo", size = 40) {
    const wrap = document.createElement("span");
    wrap.className = "coin-logo-wrap";
    const urls = logoCandidates(base);
    const img = document.createElement("img");
    img.className = className;
    img.alt = base || "";
    img.width = size;
    img.height = size;
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    let i = 0;
    const tryNext = () => {
      if (i >= urls.length) {
        img.remove();
        if (!wrap.querySelector(".letter")) wrap.append(letterAvatar(base, className));
        return;
      }
      img.src = urls[i++];
    };
    img.onerror = tryNext;
    wrap.append(img);
    tryNext();
    return wrap;
  }
  const ICON_EMOJI = {};

  const marks = new Map();
  const board = new Map();
  const klineCache = new Map(); // symbol -> { t, closes }
  const watchers = new Set();
  let bnListed = null;
  // Tokenized single stocks / ETFs ("bStocks": NVDAB, SOXSB …) — from exchangeInfo metadata (permissionSets
  // marker, same as scripts/gainer_core.py), else data/gainer_board/tokenized_stocks.json. Never "ends with B".
  const BN_TOKENIZED_MARKER = "TRD_GRP_261";
  let bnTokenized = new Set();
  let bnTokenizedSrc = "none";
  let boardSymbols = [];
  let boardReady = false;
  let boardLoading = null;
  let ws = null;
  let wsStreams = new Set();
  let dexTimer = null;
  let dexTargets = [];
  let running = false;
  let lastUi = 0;
  let liveModeOn = false;
  let getPositions = () => ({ spot: [], lev: [] });
  let extraSyms = new Set(); // e.g. 急升榜 coins outside the curated board → WS miniTicker too

  const keyOf = (chain, pair) => chain + ":" + pair;
  const mintKey = (chain, token) => (chain && token ? String(chain).toLowerCase() + ":" + String(token) : "");

  function setMark(chain, pair, patch) {
    const k = keyOf(chain, pair);
    const prev = marks.get(k) || {};
    const next = { ...prev, ...patch, chain, pair, t: Date.now() };
    marks.set(k, next);
    return next;
  }
  function getMark(chain, pair) { return marks.get(keyOf(chain, pair)) || null; }

  function notify(force) {
    const now = Date.now();
    if (!force && now - lastUi < UI_THROTTLE_MS) return;
    lastUi = now;
    for (const fn of watchers) {
      try { fn(marks, board); } catch (e) { console.warn(e); }
    }
  }

  async function ensureExchangeInfo() {
    if (bnListed) return bnListed;
    try {
      const r = await fetch(BN_REST + "/api/v3/exchangeInfo", { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      bnTokenized = new Set((j.symbols || [])
        .filter((s) => (s.permissionSets || []).some((ps) => (ps || []).includes(BN_TOKENIZED_MARKER)))
        .map((s) => s.baseAsset));
      if (bnTokenized.size) bnTokenizedSrc = "exchangeInfo:" + BN_TOKENIZED_MARKER;
      bnListed = new Set(
        (j.symbols || [])
          .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT" && s.isSpotTradingAllowed)
          .map((s) => s.symbol)
      );
    } catch (e) {
      console.warn("Binance exchangeInfo failed", e);
      bnListed = new Set();
    }
    if (!bnTokenized.size) {
      try {
        const r2 = await fetch("data/gainer_board/tokenized_stocks.json", { cache: "no-cache" });
        if (r2.ok) { bnTokenized = new Set((await r2.json()).bases || []); bnTokenizedSrc = "maintained-list"; }
      } catch (_) { /* keep empty */ }
    }
    return bnListed;
  }

  function binancePairFor(pos) {
    if (pos.chain === "binance" && pos.pair) {
      const sym = String(pos.pair).toUpperCase();
      if (!bnListed || bnListed.has(sym)) return sym;
      return null;
    }
    const mk = mintKey(pos.chain, pos.token);
    const mapped = MINT_TO_BN[mk];
    if (mapped === null) return null;
    if (mapped && (!bnListed || bnListed.has(mapped))) return mapped;
    return null;
  }

  function classify(pos) {
    const bn = binancePairFor(pos);
    if (bn) return { kind: "binance", bn };
    return { kind: "dex" };
  }

  function sourceLabel(chain, pair) {
    const m = getMark(chain, pair);
    if (!m) return "";
    if (m.source === "binance") return "Binance 即時";
    if (m.source === "dex") return "Dex 即時（舊倉）";
    return "";
  }

  function applyBnTick(sym, px, extra) {
    if (!sym || !(px > 0)) return;
    const row = board.get(sym) || { symbol: sym, base: sym.replace(/USDT$/, "") };
    const prev = row.price;
    Object.assign(row, extra || {}, { price: px, t: Date.now() });
    if (prev != null && prev !== px) row._flash = px > prev ? "up" : "down";
    row.logo = logoUrl(row.base);
    board.set(sym, row);
    setMark("binance", sym, {
      bn: sym, price: px, source: "binance", symbol: row.base,
      liq: 1e12, chg24: row.chg24, volQuote: row.volQuote,
      high: row.high, low: row.low, _flash: row._flash || null,
    });
    for (const [, m] of marks) {
      if (m.bn === sym && !(m.chain === "binance" && m.pair === sym)) {
        const p0 = m.price;
        setMark(m.chain, m.pair, {
          price: px, source: "binance", symbol: m.symbol,
          _flash: p0 != null && p0 !== px ? (px > p0 ? "up" : "down") : null,
        });
      }
    }
  }

  function rebuildWs(neededBn) {
    const next = new Set(neededBn);
    const same = next.size === wsStreams.size && [...next].every((s) => wsStreams.has(s));
    if (same && ws && ws.readyState <= 1) return;
    wsStreams = next;
    if (ws) { try { ws.close(); } catch {} ws = null; }
    if (!next.size) return;
    const streams = [...next].map((s) => s.toLowerCase() + "@miniTicker").join("/");
    try { ws = new WebSocket(BN_WS + "?streams=" + streams); } catch (e) { console.warn("WS open failed", e); return; }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const d = msg.data || msg;
        const sym = d.s;
        const px = parseFloat(d.c || d.p);
        if (!sym || !(px > 0)) return;
        const chg = d.o != null && parseFloat(d.o) > 0
          ? ((px / parseFloat(d.o)) - 1) * 100
          : (d.P != null ? parseFloat(d.P) : undefined);
        const qv = d.q != null ? parseFloat(d.q) : undefined;
        applyBnTick(sym, px, {
          chg24: Number.isFinite(chg) ? chg : board.get(sym)?.chg24,
          volQuote: Number.isFinite(qv) ? qv : board.get(sym)?.volQuote,
        });
        notify(false);
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (running && wsStreams.size && document.visibilityState === "visible") {
        setTimeout(() => rebuildWs(wsStreams), 2000);
      }
    };
  }

  async function seedBoardRest(symbols) {
    if (!symbols.length) return;
    for (let i = 0; i < symbols.length; i += 40) {
      const slice = symbols.slice(i, i + 40);
      const q = encodeURIComponent(JSON.stringify(slice));
      try {
        const r = await fetch(BN_REST + "/api/v3/ticker/24hr?symbols=" + q, { headers: { Accept: "application/json" } });
        if (!r.ok) throw new Error(r.status);
        const arr = await r.json();
        for (const t of arr) {
          const px = parseFloat(t.lastPrice);
          const chg = parseFloat(t.priceChangePercent);
          const volQ = parseFloat(t.quoteVolume);
          applyBnTick(t.symbol, px, {
            chg24: Number.isFinite(chg) ? chg : null,
            volQuote: Number.isFinite(volQ) ? volQ : null,
            high: parseFloat(t.highPrice) || null,
            low: parseFloat(t.lowPrice) || null,
            open: parseFloat(t.openPrice) || null,
          });
        }
      } catch (e) {
        console.warn("Binance 24hr seed failed", e);
        await Promise.all(slice.map(async (sym) => {
          try {
            const r = await fetch(BN_REST + "/api/v3/ticker/price?symbol=" + encodeURIComponent(sym));
            if (!r.ok) return;
            const j = await r.json();
            const px = parseFloat(j.price);
            if (px > 0) applyBnTick(sym, px, {});
          } catch {}
        }));
      }
    }
  }

  function parseKlineBars(arr) {
    return (arr || []).map((c) => ({
      t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5], qv: +c[7],
    })).filter((b) => b.c > 0);
  }

  /** Fetch recent closes for sparkline. interval 1h x 24 or 5m x 48. */
  async function fetchKlines(symbol, { interval = "1h", limit = 24, force = false } = {}) {
    const bars = await fetchKlineBars(symbol, { interval, limit, force });
    return bars.map((b) => b.c);
  }

  async function fetchKlineBars(symbol, { interval = "1h", limit = 24, force = false } = {}) {
    const key = symbol + ":" + interval + ":" + limit;
    const hit = klineCache.get(key);
    if (!force && hit && Date.now() - hit.t < KLINE_TTL_MS && hit.bars) return hit.bars;
    try {
      const url = `${BN_REST}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(r.status);
      const bars = parseKlineBars(await r.json());
      const closes = bars.map((b) => b.c);
      klineCache.set(key, { t: Date.now(), closes, bars });
      const row = board.get(symbol);
      if (row && interval !== "15m") { row.spark = closes; board.set(symbol, row); }
      return bars;
    } catch (e) {
      console.warn("klines failed", symbol, e);
      const row = board.get(symbol);
      if (row && row.low && row.high && row.price) {
        const approx = [
          { o: row.open || row.low, h: row.high, l: row.low, c: row.open || row.low, qv: 0 },
          { o: row.low, h: row.high, l: row.low, c: row.low, qv: 0 },
          { o: row.low, h: row.high, l: row.low, c: (row.low + row.high) / 2, qv: 0 },
          { o: row.low, h: row.high, l: row.low, c: row.high, qv: 0 },
          { o: row.low, h: row.high, l: row.low, c: row.price, qv: row.volQuote || 0 },
        ];
        klineCache.set(key, { t: Date.now(), closes: approx.map((b) => b.c), bars: approx });
        return approx;
      }
      return hit?.bars || [];
    }
  }

  async function warmSparks(symbols, maxN = 20) {
    const list = (symbols || boardSymbols).slice(0, maxN);
    await Promise.all(list.map((s) => fetchKlines(s).catch(() => [])));
  }

  function sparkPath(closes, w = 120, h = 40, pad = 2) {
    if (!closes || closes.length < 2) return "";
    const min = Math.min(...closes), max = Math.max(...closes);
    const span = max - min || 1;
    const n = closes.length;
    const pts = closes.map((v, i) => {
      const x = pad + (i / (n - 1)) * (w - pad * 2);
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return [x, y];
    });
    return pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  }

  function sparkSvg(closes, { w = 120, h = 40, up = true, className = "spark-svg" } = {}) {
    const path = sparkPath(closes, w, h);
    if (!path) return null;
    const stroke = up ? "#22c55e" : "#ef4444";
    const fill = up ? "url(#sg)" : "url(#sr)";
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("class", className);
    svg.innerHTML = `<defs>
      <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22c55e66"/><stop offset="100%" stop-color="#22c55e00"/></linearGradient>
      <linearGradient id="sr" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ef444466"/><stop offset="100%" stop-color="#ef444400"/></linearGradient>
    </defs>
    <path d="${path} L${w - 2},${h - 2} L2,${h - 2} Z" fill="${fill}" stroke="none"/>
    <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    return svg;
  }

  const avgNum = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const clampNum = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /** Chase / momentum score — for 「爆升對照」 only, NOT primary AI picks. */
  function scoreChaseRows(rows) {
    const scored = (rows || []).map((r) => {
      const chg = r.chg24 || 0, vol = r.volQuote || 0;
      const hi = r.high || r.price, lo = r.low || r.price;
      const pos = hi > lo ? (r.price - lo) / (hi - lo) : 0.5;
      const ret7 = r.ret7 || 0;
      const score = Math.min(100,
        Math.min(40, Math.max(0, chg) * 3.5) +
        Math.min(30, Math.log10(Math.max(vol, 1)) * 4) +
        (pos > 0.85 ? 15 : 0) +
        Math.min(15, Math.max(0, ret7) * 0.8)
      );
      return {
        ...r, score: Math.round(score * 10) / 10, chase: true,
        alreadyUp: chg >= 8 || r.alreadyUp, ret7,
      };
    }).filter((r) => r.price > 0);
    const hot = scored.filter((r) => (r.chg24 || 0) >= 5 || (r.ret7 || 0) >= 12);
    const pool = hot.length ? hot : scored.slice().sort((a, b) => (b.chg24 || 0) - (a.chg24 || 0)).slice(0, 8);
    pool.sort((a, b) => b.score - a.score);
    return pool.slice(0, 10);
  }

  /** Legacy alias — DO NOT use for primary AI recs (was 24h gainer bait). */
  function scoreBoardRows(rows) {
    return scoreChaseRows(rows);
  }

  function setupFeatures(row, daily, hourly, btcDaily) {
    const chg24 = row.chg24 || 0;
    const price = row.price || 0;
    const volQ = row.volQuote || 0;
    const hi = row.high || price, lo = row.low || price;
    const d = daily.slice(-8), h = hourly.slice(-48);
    const volD = d.map((b) => b.qv);
    const volAvg7 = avgNum(volD.slice(0, -1)) || avgNum(volD) || 1;
    const volToday = volQ || volD[volD.length - 1]; // rolling 24h, not partial UTC day candle
    const volCreep = volToday / volAvg7;
    const vRecent = avgNum(volD.slice(-4, -1)) || 1;
    const vPrior = avgNum(volD.slice(-7, -4)) || vRecent;
    const volRegime = vRecent / vPrior;
    const range = (bars) => {
      if (!bars.length) return 0;
      const hh = Math.max(...bars.map((b) => b.h));
      const ll = Math.min(...bars.map((b) => b.l));
      const mid = (hh + ll) / 2 || 1;
      return ((hh - ll) / mid) * 100;
    };
    const rangeRecent = range(d.slice(-4));
    const rangePrior = range(d.slice(-7, -3)) || rangeRecent || 1;
    const compression = rangePrior / Math.max(rangeRecent, 0.01);
    const recentHigh = Math.max(...d.slice(-5).map((b) => b.h), hi);
    const recentLow = Math.min(...d.slice(-5).map((b) => b.l), lo);
    const posInRange = (price - recentLow) / Math.max(recentHigh - recentLow, 1e-12);
    const nearMidLow = posInRange < 0.55;
    const lowsH = h.slice(-24).map((b) => b.l);
    let higherLows = 0;
    if (lowsH.length >= 8) {
      const a = avgNum(lowsH.slice(0, 8)), b = avgNum(lowsH.slice(8, 16)), c = avgNum(lowsH.slice(16));
      if (b > a * 1.001 && c >= b * 0.998) higherLows = 1;
      else if (c > a * 1.002) higherLows = 0.5;
    }
    const ret7 = d.length >= 2 ? (d[d.length - 1].c / d[0].c - 1) * 100 : 0;
    const btcRet7 = (btcDaily && btcDaily.length >= 2)
      ? (btcDaily[btcDaily.length - 1].c / btcDaily[0].c - 1) * 100 : 0;
    const relStrength = ret7 - btcRet7;
    const meanRev = chg24 < 1 && chg24 > -8 && nearMidLow && volCreep > 1.15;
    const calmAccum = Math.abs(chg24) < 3 && volRegime > 1.1 && compression > 1.15 && posInRange < 0.65;
    const rotation = relStrength < -3 && volCreep > 1.1 && chg24 > -5 && chg24 < 6;
    const breakout = compression > 1.2 && posInRange > 0.55 && posInRange < 0.92 && volCreep > 1.2 && chg24 < 8;
    const alreadyUp = chg24 >= 8;
    const extended = chg24 >= 12 || (chg24 >= 6 && posInRange > 0.9);
    let precursorEcho = 0;
    const retsD = [];
    for (let i = 1; i < d.length; i++) retsD.push((d[i].c / d[i - 1].c - 1) * 100);
    for (let i = 2; i < retsD.length; i++) {
      if (retsD[i] > 8) {
        const volBefore = volD[i] / Math.max(avgNum(volD.slice(Math.max(0, i - 3), i)) || 1, 1);
        if (volBefore > 1.15 && retsD[i - 1] < 5) precursorEcho += 1;
      }
    }
    const turnoverQ = clampNum(Math.log10(Math.max(volQ, 1)) / 8, 0, 1);
    return {
      chg24, price, volQ, hi, lo, volCreep, volRegime, compression, posInRange, nearMidLow,
      higherLows, ret7, btcRet7, relStrength, meanRev, calmAccum, rotation, breakout,
      alreadyUp, extended, precursorEcho, turnoverQ,
    };
  }

  function scoreSetupFeatures(f) {
    const parts = {
      vol_creep: 0, compression: 0, relative: 0, higher_lows: 0,
      rotation: 0, accumulation: 0, breakout: 0, precursor_echo: 0, turnover: 0, chase_penalty: 0,
    };
    if (f.volCreep > 1.1 && f.chg24 < 6) parts.vol_creep = clampNum((f.volCreep - 1) * 28, 0, 22);
    if (f.compression > 1.1) parts.compression = clampNum((f.compression - 1) * 18, 0, 16);
    if (f.relStrength < -2 && f.volCreep > 1.05) parts.relative = clampNum(-f.relStrength * 1.8, 0, 18);
    parts.higher_lows = f.higherLows * 12;
    if (f.rotation) parts.rotation = 16 + clampNum(-f.relStrength, 0, 8);
    if (f.calmAccum) parts.accumulation = 18;
    if (f.breakout) parts.breakout = 14;
    parts.precursor_echo = clampNum(f.precursorEcho * 6, 0, 12);
    parts.turnover = f.turnoverQ * 10;
    if (f.alreadyUp) parts.chase_penalty = -35 - Math.min(20, (f.chg24 - 8) * 2);
    else if (f.chg24 > 5) parts.chase_penalty = -12;
    if (f.extended) parts.chase_penalty -= 15;
    if (f.chg24 < -10 && !f.higherLows) parts.chase_penalty -= 10;
    const setupScore = clampNum(Object.values(parts).reduce((a, b) => a + b, 0), 0, 100);
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
    let tip = angleScores[0][2];
    if (f.alreadyUp) tip = `已急升 ${f.chg24.toFixed(1)}% · 宜勿追（只供對照）`;
    else if (angle === "accumulation") tip = `24h 只 ${f.chg24 >= 0 ? "+" : ""}${f.chg24.toFixed(1)}%，成交較 7 日均${f.volCreep >= 1 ? "高" : "低"} ${Math.abs(f.volCreep * 100 - 100).toFixed(0)}% · 靜吸`;
    else if (angle === "rotation") tip = `7 日跑輸 BTC ${(-f.relStrength).toFixed(1)} pt，量能開始回 · 輪動留意`;
    else if (angle === "compression") tip = `近幾日波幅收窄 ${f.compression.toFixed(1)}×，輕觸上沿 · 唔係已爆升`;
    else if (angle === "mean_reversion") tip = `仍近區間中低位，量回暖 · 睇反彈多過追升`;
    else if (angle === "higher_lows") tip = `1h 抬高低位而 24h 未瘋 · 結構轉好`;
    else tip = `相對大盤偏弱後量能回 · 提早留意`;
    return { setupScore: Math.round(setupScore * 10) / 10, angle, tip, parts };
  }

  function diversifySetups(scored, n = 6) {
    // Hard diversify: ≥3 angles for 6 picks; max 1 per angle first, never pad same angle via catch-all.
    const ANGLE_ORDER = ["accumulation", "rotation", "compression", "mean_reversion", "higher_lows", "relative"];
    const HARD = 1; // first pass
    const SOFT = 2; // only after every available angle has ≥1
    // Soft-skip mega majors so AI brief is not stuck on BTC/ETH/SOL/BNB
    const MEGA = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]);
    const setups = scored.filter((s) => !s.alreadyUp && !s.extended && s.setupScore >= 26 && !MEGA.has(s.symbol))
      .sort((a, b) => b.setupScore - a.setupScore);
    const out = [];
    const used = new Set();
    const usedAngle = new Map();
    const angN = (a) => usedAngle.get(a) || 0;
    const add = (s) => {
      out.push(s);
      used.add(s.symbol);
      usedAngle.set(s.angle, angN(s.angle) + 1);
    };

    // Pass 1: one best coin per angle (preferred order)
    for (const ang of ANGLE_ORDER) {
      if (out.length >= n) break;
      const s = setups.find((x) => !used.has(x.symbol) && x.angle === ang);
      if (s) add(s);
    }

    // Pass 2: fill with unused angles first; only then allow 2nd of an angle (never 3+)
    while (out.length < n) {
      let next = setups.find((x) => !used.has(x.symbol) && angN(x.angle) === 0);
      if (!next) next = setups.find((x) => !used.has(x.symbol) && angN(x.angle) < SOFT);
      if (!next) break;
      add(next);
    }

    // Pass 3: relax score gate, still enforce SOFT angle cap + chg24 < 8 + MEGA skip
    if (out.length < n) {
      const relaxed = scored
        .filter((s) => (s.chg24 || 0) < 8 && !MEGA.has(s.symbol))
        .sort((a, b) => b.setupScore - a.setupScore);
      for (const s of relaxed) {
        if (out.length >= n) break;
        if (used.has(s.symbol)) continue;
        if (angN(s.angle) >= SOFT) continue;
        add(s);
      }
    }
    return out.slice(0, n);
  }

  let setupCache = { t: 0, picks: [], chasing: [] };
  const SETUP_TTL = 5 * 60_000;

  /** Multi-angle setup picks — primary AI brief. Not 24h gainer rank. */
  async function computeSetupPicks({ force = false, limitSymbols = 40 } = {}) {
    if (!force && setupCache.picks.length && Date.now() - setupCache.t < SETUP_TTL) {
      return setupCache;
    }
    const rows = getBoardRows().filter((r) => r.price > 0);
    if (!rows.length) await ensureBoard(false);
    let list = getBoardRows().filter((r) => r.price > 0);
    // Prefer mix: skip pure majors-only; analyze most liquid + memes
    list = list.slice().sort((a, b) => (b.volQuote || 0) - (a.volQuote || 0)).slice(0, limitSymbols);
    const btcDaily = await fetchKlineBars("BTCUSDT", { interval: "1d", limit: 8 }).catch(() => []);
    const scored = [];
    // Batch with concurrency 4
    const queue = list.slice();
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const row = queue.shift();
        if (!row) break;
        try {
          const [daily, hourly] = await Promise.all([
            fetchKlineBars(row.symbol, { interval: "1d", limit: 8 }),
            fetchKlineBars(row.symbol, { interval: "1h", limit: 48 }),
          ]);
          const f = setupFeatures(row, daily, hourly, btcDaily);
          const sc = scoreSetupFeatures(f);
          scored.push({
            ...row,
            ...f,
            ...sc,
            score: sc.setupScore,
            logo: logoUrl(row.base),
          });
        } catch (e) {
          console.warn("setup fail", row.symbol, e);
        }
      }
    });
    await Promise.all(workers);
    // Market-regime gate (same rule as batch writer + home banner):
    // weak if BTC 24h < -2% or <30% of board green => max 4, setup >= 28, rank by RS vs BTC.
    const boardNow = getBoardRows().filter((r) => r.price > 0);
    const btcRow = boardNow.find((r) => r.symbol === "BTCUSDT");
    const btc24 = btcRow ? (btcRow.chg24 || 0) : 0;
    const breadth = boardNow.length ? boardNow.filter((r) => (r.chg24 || 0) > 0).length / boardNow.length : 1;
    const weak = btc24 < -2 || breadth < 0.3;
    let picks;
    if (weak) {
      picks = diversifySetups(scored.filter((s) => s.setupScore >= 28), 4)
        .map((s) => ({ ...s, size: "half", rsBtc: (s.chg24 || 0) - btc24 }))
        .sort((a, b) => b.rsBtc - a.rsBtc);
    } else {
      picks = diversifySetups(scored, 6);
    }
    const chasing = scoreChaseRows(scored.length ? scored : list);
    setupCache = { t: Date.now(), picks, chasing, all: scored, regime: { weak, btc24, breadth } };
    return setupCache;
  }

  // ---------- 急升榜 (high-risk momentum board) ----------
  // 🔥 surge + ⚡ v2 early rules mirror scripts/gainer_core.py (surge_fire / early2_at); all computed here, live.
  const GB_STABLE = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "EUR", "EURI", "AEUR", "XUSD", "USD1",
    "BFUSD", "USDE", "USDEB", "U", "FRAX", "RLUSD", "USDS", "RWUSD", "PYUSD", "PAXG", "XAUT", "WBTC", "WBETH", "BNSOL"]);
  const GB_LEV_OK = new Set(["JUP", "SYRUP", "SUP"]);
  const GB_MIN_QV = 3e6;       // min 24h quote volume (USDT)
  // 🔥 surge rule (2026-10-25, mirrors scripts/gainer_core.py surge_feats/surge_fire) — NO 24h minimum:
  //   (rolling 1h >= +5% AND 1h quote volume >= 3x the previous-24h hourly average) OR 15m candle >= +5%.
  const GB_SURGE_C1 = 5, GB_SURGE_VR = 3, GB_SURGE_C15 = 5;
  const GB_TRIGGER_H = 4;      // a surge stays 🔥 on the board for 4h (same as backtest cooldown / horizon)
  const GB_CAND_C24 = 5, GB_CAND_FH = -30;      // 候補 filler when < 6 rule hits (watch-only)
  const GB_CAND_N = 6;         // 候補 coins fetched (filler only)
  // ⚡ v2 (20261029a, mirrors gainer_core.early2_at): 起步 + prec + 細盤 $1.5M; watch-only.
  //   起步: 24h vol ≥ $3M, not 🔥, 15m ≥ +2.5%, 1h ≥ 0, prior-24h range ≥ 25%
  //   prec: 24h vol ≥ $3M, not 🔥, 1h ≥ +2.5%, vol ≥ 2.5x, 24h % < +12%
  //   細盤: 24h vol $1.5M–$3M with the 🔥 price/volume condition
  //   suppressed when 🔥 (≥ $3M) fired on that coin in the 16 bars up to the signal bar.
  const GB_E2_C15 = 2.5, GB_E2_C1_MIN = 0, GB_E2_RNG24 = 25, GB_E2_LOW_QV = 1.5e6;
  const GB_E2_PREC_C1 = 2.5, GB_E2_PREC_VR = 2.5, GB_E2_PREC_C24_MAX = 12;
  // Scan pool: EVERY eligible coin passing a cheap ticker pre-filter (no top-10 cap any more):
  //   🔥 / 細盤: rolling-4h range ≥ 5% · 起步: 24h range ≥ 25% and rolling-4h range ≥ 2.5%. Hard cap for rate safety.
  const GB_POOL_MAX = 90;
  const GB_TTL = 60_000;
  let gainerCache = { t: 0, rows: [] };

  function gainerEligible(sym, qv, floor = GB_MIN_QV) {
    if (!sym.endsWith("USDT")) return false;
    const base = sym.slice(0, -4);
    if (GB_STABLE.has(base) || bnTokenized.has(base)) return false;
    if (/(UP|DOWN|BULL|BEAR)$/.test(base) && !GB_LEV_OK.has(base)) return false;
    return qv >= floor;
  }

  /** Rolling surge features at 15m bar j (closed bars) — same maths as gainer_core.surge_feats. */
  function surgeFeats(b, j) {
    if (j < 99) return null;
    let v1 = 0, prev = 0, hi = 0, q24 = 0;
    for (let k = j - 3; k <= j; k++) v1 += b[k].qv;
    for (let k = j - 99; k <= j - 4; k++) prev += b[k].qv;
    for (let k = j - 95; k <= j; k++) { hi = Math.max(hi, b[k].h); q24 += b[k].qv; }
    const avg = prev / 24, c = b[j].c;
    return {
      t: b[j].t + 15 * 60e3, price: c,
      c15: b[j].o > 0 ? (c / b[j].o - 1) * 100 : 0, c1: (c / b[j - 4].c - 1) * 100, c4: (c / b[j - 16].c - 1) * 100,
      vr: avg > 0 ? v1 / avg : 0, fh: hi > 0 ? (c / hi - 1) * 100 : 0, qv24: q24,
    };
  }
  const surgeFire = (f) => !!f && ((f.c1 >= GB_SURGE_C1 && f.vr >= GB_SURGE_VR) || f.c15 >= GB_SURGE_C15);
  const surgeVia = (f) => (f.c1 >= GB_SURGE_C1 && f.vr >= GB_SURGE_VR ? "1h+vol" : "15m");

  /** ⚡ v2 leg at CLOSED 15m bar j: "start" | "prec" | "thin" | null (same maths as gainer_core.early2_at). */
  function early2At(b, j) {
    if (j < 115) return null;
    for (let k = j - 16; k <= j; k++) { const g = surgeFeats(b, k); if (g.qv24 >= GB_MIN_QV && surgeFire(g)) return null; }
    const f = surgeFeats(b, j);
    // c24 from the same 96-bar window as gainer_core.surge_feats
    const c24 = (j >= 96 && b[j - 96].c > 0) ? (f.price / b[j - 96].c - 1) * 100 : 0;
    if (f.qv24 >= GB_MIN_QV) {
      if (!(f.c15 < GB_SURGE_C15 && f.c1 < GB_SURGE_C1)) return null;
      let hi = -Infinity, lo = Infinity;
      for (let k = j - 96; k < j; k++) { hi = Math.max(hi, b[k].h); lo = Math.min(lo, b[k].l); }
      const rng24 = lo > 0 ? (hi / lo - 1) * 100 : 0;
      if (f.c15 >= GB_E2_C15 && f.c1 >= GB_E2_C1_MIN && rng24 >= GB_E2_RNG24) return "start";
      if (f.c1 >= GB_E2_PREC_C1 && f.vr >= GB_E2_PREC_VR && c24 < GB_E2_PREC_C24_MAX) return "prec";
      return null;
    }
    return f.qv24 >= GB_E2_LOW_QV && surgeFire(f) ? "thin" : null;
  }
  /** First ⚡ v2 fire on closed bars in the last 4h (bars = 15m klines, last one forming → excluded). */
  function early2Trigger(bars) {
    const m = bars.length;
    if (m < 118) return null;
    const cutoff = Date.now() - GB_TRIGGER_H * 3600e3;
    for (let j = Math.max(115, m - 17); j <= m - 2; j++) {
      if (bars[j].t + 15 * 60e3 < cutoff) continue;
      const leg = early2At(bars, j);
      if (leg) { const f = surgeFeats(bars, j); return { t: f.t, price: f.price, via: leg, c1: f.c1, c15: f.c15, vr: f.vr, forming: false }; }
    }
    return null;
  }

  /**
   * Trigger = FIRST 15m bar in the last 4h whose rolling window fired (incl. the forming bar, evaluated live).
   * bars = 15m klines (last one forming).
   */
  function surgeTrigger(bars, livePx) {
    const m = bars.length;
    if (m < 101) return null;
    const cutoff = Date.now() - GB_TRIGGER_H * 3600e3;
    const live = bars.slice(); // forming bar with the live price as its close
    if (livePx > 0) live[m - 1] = { ...live[m - 1], c: livePx, h: Math.max(live[m - 1].h, livePx) };
    for (let j = Math.max(99, m - 17); j < m; j++) {
      const f = surgeFeats(live, j);
      if (!f || f.t < cutoff) continue;
      if (surgeFire(f)) return { t: j === m - 1 ? Date.now() : f.t, price: f.price, via: surgeVia(f), c1: f.c1, c15: f.c15, vr: f.vr, forming: j === m - 1 };
    }
    return null;
  }

  /** Display metrics + score from 15m bars (score = same shape as gainer_core.score). */
  function gainerScore15(t, bars) {
    const m = bars.length, p = t.price;
    const ref = (k) => (m - 1 - k >= 0 ? bars[m - 1 - k].c : null);
    const c1h = ref(4) ? (p / ref(4) - 1) * 100 : null;
    const c4h = ref(16) ? (p / ref(16) - 1) * 100 : null;
    let v1 = 0, prev = 0, np = 0;
    for (let k = Math.max(0, m - 4); k < m; k++) v1 += bars[k].qv;
    for (let k = Math.max(0, m - 100); k < m - 4; k++) { prev += bars[k].qv; np++; }
    const volRatio = np ? v1 / (prev / np * 4) : null;
    const fromHigh = t.high > 0 ? (p / t.high - 1) * 100 : 0;
    const score = clampNum((c4h || 0) * 1.2, -20, 30) + clampNum((c1h || 0) * 2, -15, 20)
      + clampNum(Math.log2(Math.max(volRatio || 0.01, 0.01)) * 8, -5, 20)
      + clampNum(t.chg24 / 3, 0, 15) + clampNum(15 + fromHigh * 0.75, -15, 15);
    return { c1h, c4h, volRatio, volRatioPrev: null, fromHigh, score: Math.round(score * 10) / 10 };
  }

  /** Rolling-window ticker (windowSize 4h) for the eligible list — 1 call (≤100 symbols per call). */
  async function rollingTicker(symbols, windowSize) {
    const out = new Map();
    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100);
      const url = `${BN_REST}/api/v3/ticker?type=MINI&windowSize=${windowSize}&symbols=${encodeURIComponent(JSON.stringify(chunk))}`;
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("rolling ticker " + r.status);
      for (const x of await r.json()) out.set(x.symbol, { open: +x.openPrice, high: +x.highPrice, low: +x.lowPrice, last: +x.lastPrice, qv: +x.quoteVolume });
    }
    return out;
  }

  /**
   * 1 MINI 24hr ticker + rolling-4h ticker (≤100 symbols/call) + ≤ GB_POOL_MAX 15m-kline calls, cached 1 min.
   * Throws on ticker failure. 🔥 = surge in the last 4h (no 24h minimum). ⚡ = early2 (watch-only).
   * 候補 = 24h ≥ +5% & ≤ 30% off high (watch-only filler).
   */
  async function computeGainerBoard({ force = false, n = 8 } = {}) {
    if (!force && gainerCache.rows.length && Date.now() - gainerCache.t < GB_TTL) return gainerCache;
    const listed = await ensureExchangeInfo();
    const r = await fetch(BN_REST + "/api/v3/ticker/24hr?type=MINI", { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("ticker " + r.status);
    const all = await r.json();
    const elig = [], thin = [];
    const prices = new Map();
    for (const x of all) {
      const sym = x.symbol, qv = parseFloat(x.quoteVolume), last = parseFloat(x.lastPrice), open = parseFloat(x.openPrice);
      if (listed.size && !listed.has(sym)) continue;
      if (!(last > 0) || !(open > 0) || !gainerEligible(sym, qv, GB_E2_LOW_QV)) continue;
      prices.set(sym, last);
      const hi = parseFloat(x.highPrice) || null, lo = parseFloat(x.lowPrice) || null;
      const t = { symbol: sym, base: sym.slice(0, -4), price: last, chg24: (last / open - 1) * 100, volQuote: qv,
        high: hi, low: lo, open, rng24t: hi > 0 && lo > 0 ? (hi / lo - 1) * 100 : 0, thin: qv < GB_MIN_QV };
      (t.thin ? thin : elig).push(t);
    }
    elig.sort((a, b) => b.chg24 - a.chg24);
    elig.forEach((t, i) => { t.rank24 = i + 1; t.fromHigh = t.high > 0 ? (t.price / t.high - 1) * 100 : 0; });
    thin.forEach((t) => { t.rank24 = null; t.fromHigh = t.high > 0 ? (t.price / t.high - 1) * 100 : 0; });
    // Cheap pre-filter on EVERY eligible coin (rolling 4h window): a ≥5% 15m/1h surge leaves a ≥5% 4h range;
    // a ⚡ 起步 bar (15m ≥ +2.5%) leaves ≥2.5% and needs the 24h range ≥ 25% (ticker range ⊇ prior-24h range).
    let r4 = new Map();
    try { r4 = await rollingTicker(elig.concat(thin).map((t) => t.symbol), "4h"); } catch (e) { console.warn("rolling 4h failed", e); }
    const range4 = (t) => { const x = r4.get(t.symbol); return x && x.low > 0 ? (x.high / x.low - 1) * 100 : 0; };
    const c4roll = (t) => { const x = r4.get(t.symbol); return x && x.open > 0 ? (x.last / x.open - 1) * 100 : 0; };
    const byC4 = (a, b) => c4roll(b) - c4roll(a);
    const surgePool = elig.filter((t) => range4(t) >= GB_SURGE_C15).sort(byC4);
    const inPool = new Set(surgePool.map((t) => t.symbol));
    const startPool = elig.filter((t) => !inPool.has(t.symbol) && t.rng24t >= GB_E2_RNG24 && range4(t) >= GB_E2_C15).sort(byC4);
    startPool.forEach((t) => inPool.add(t.symbol));
    const thinPool = thin.filter((t) => range4(t) >= GB_SURGE_C15).sort(byC4);
    thinPool.forEach((t) => inPool.add(t.symbol));
    const candPool = elig.filter((t) => !inPool.has(t.symbol) && t.chg24 >= GB_CAND_C24 && t.fromHigh >= GB_CAND_FH).slice(0, GB_CAND_N);
    const pool = surgePool.concat(startPool, thinPool).slice(0, GB_POOL_MAX).concat(candPool);
    const out = [], early = [];
    const queue = pool.slice();
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const t = queue.shift();
        let bars = [];
        try { bars = await fetchKlineBars(t.symbol, { interval: "15m", limit: 120, force: true }); } catch (_) {}
        const trig = !t.thin && bars.length >= 101 ? surgeTrigger(bars, t.price) : null;
        const e2 = !trig ? early2Trigger(bars) : null;
        const f = bars.length >= 20 ? gainerScore15(t, bars) : { c1h: null, c4h: null, volRatio: null, volRatioPrev: null, fromHigh: t.fromHigh, score: 0 };
        const spark = bars.slice(-32).map((b) => b.c).concat([t.price]);
        if (e2) { early.push({ ...t, ...f, tier: "early2", trigger: e2, spark, logo: logoUrl(t.base) }); continue; }
        const tier = trig ? "pump" : (!t.thin && t.chg24 >= GB_CAND_C24 && t.fromHigh >= GB_CAND_FH ? "cand" : null);
        if (!tier) continue;
        out.push({ ...t, ...f, tier, trigger: trig, spark, logo: logoUrl(t.base) });
      }
    }));
    const pumps = out.filter((x) => x.tier === "pump").sort((a, b) => b.trigger.t - a.trigger.t || b.score - a.score);
    const fill = out.filter((x) => x.tier === "cand").sort((a, b) => b.score - a.score);
    const rows = pumps.concat(fill.slice(0, Math.max(0, 6 - pumps.length))).slice(0, Math.max(n, pumps.length));
    early.sort((a, b) => b.trigger.t - a.trigger.t || b.score - a.score);
    gainerCache = { t: Date.now(), rows, early, pool: elig.length + thin.length, poolThin: thin.length, scanned: pool.length, screened4h: r4.size,
      tokenizedExcluded: bnTokenized.size, tokenizedSrc: bnTokenizedSrc, prices, rank: new Map(elig.concat(thin).map((t) => [t.symbol, t])) };
    return gainerCache;
  }

  async function ensureBoard(force) {
    if (boardReady && !force && board.size) return getBoardRows();
    if (boardLoading) return boardLoading;
    boardLoading = (async () => {
      await ensureExchangeInfo();
      boardSymbols = CURATED_BASES.map((b) => b + "USDT").filter((s) => bnListed.has(s));
      await seedBoardRest(boardSymbols);
      boardReady = true;
      const { bnNeeded } = collectTargets();
      const all = [...new Set([...boardSymbols, ...bnNeeded, ...extraSyms])];
      rebuildWs(all);
      // Warm sparklines for top / selected (non-blocking)
      warmSparks(boardSymbols, 24).then(() => notify(true));
      notify(true);
      return getBoardRows();
    })().finally(() => { boardLoading = null; });
    return boardLoading;
  }

  function getBoardRows() {
    return boardSymbols.map((s) => board.get(s)).filter(Boolean);
  }

  async function pollDex() {
    if (!window.MCE || !window.MCE.cachedJson) return;
    const API = window.MCE.API;
    const list = dexTargets.filter((t) => t.chain && t.pair && t.chain !== "binance");
    if (!list.length) return;
    const byChain = new Map();
    for (const t of list) {
      if (!byChain.has(t.chain)) byChain.set(t.chain, new Set());
      byChain.get(t.chain).add(t.pair);
    }
    const jobs = [];
    for (const [chain, set] of byChain) {
      const a = [...set];
      for (let i = 0; i < a.length; i += 30) {
        const slice = a.slice(i, i + 30);
        jobs.push(
          window.MCE.cachedJson(
            `${API}/latest/dex/pairs/${encodeURIComponent(chain)}/${slice.join(",")}`,
            { force: true }
          ).then((r) => ({ chain, asked: slice, pairs: r.data.pairs || [] }))
        );
      }
    }
    const results = await Promise.allSettled(jobs);
    for (const res of results) {
      if (res.status !== "fulfilled") continue;
      const { chain, asked, pairs } = res.value;
      const got = new Map(pairs.map((p) => [p.pairAddress, p]));
      for (const pair of asked) {
        const p = got.get(pair);
        const px = p?.priceUsd ? parseFloat(p.priceUsd) : null;
        const liq = p?.liquidity?.usd ?? 0;
        const prev = getMark(chain, pair);
        if (px > 0) {
          setMark(chain, pair, {
            price: px, liq, source: "dex", p, symbol: prev?.symbol,
            _flash: prev?.price != null && prev.price !== px ? (px > prev.price ? "up" : "down") : null,
          });
          if (window.MCE.paper && window.MCE.paper.ingestPair) window.MCE.paper.ingestPair(chain, pair, p);
        } else if (liq < 1000) {
          setMark(chain, pair, { price: 0, liq, source: "dex", dead: true });
        }
      }
    }
    notify(true);
  }

  function collectTargets() {
    const { spot = [], lev = [] } = getPositions() || {};
    const all = [...spot, ...lev];
    const bnNeeded = [];
    const dex = [];
    for (const pos of all) {
      if (!pos.chain || !pos.pair) continue;
      const c = classify(pos);
      if (c.kind === "binance") {
        bnNeeded.push(c.bn);
        setMark(pos.chain, pos.pair, {
          bn: c.bn, symbol: pos.symbol,
          source: getMark(pos.chain, pos.pair)?.source || "binance",
          token: pos.token,
        });
      } else {
        dex.push({ chain: pos.chain, pair: pos.pair, token: pos.token, symbol: pos.symbol });
        const prev = getMark(pos.chain, pos.pair);
        if (!prev) setMark(pos.chain, pos.pair, { symbol: pos.symbol, source: "dex", token: pos.token });
      }
    }
    dexTargets = dex;
    return { bnNeeded: [...new Set(bnNeeded)], dexCount: dex.length };
  }

  function stopTimers() {
    if (dexTimer) { clearInterval(dexTimer); dexTimer = null; }
  }

  async function tickOnce() {
    await ensureExchangeInfo();
    if (!boardReady) await ensureBoard(false);
    const { bnNeeded } = collectTargets();
    const allBn = [...new Set([...boardSymbols, ...bnNeeded, ...extraSyms])];
    rebuildWs(allBn);
    if (dexTargets.length) await pollDex();
    const missing = bnNeeded.filter((s) => !(getMark("binance", s)?.price > 0) && !(board.get(s)?.price > 0));
    if (missing.length) await seedBoardRest(missing);
    for (const bn of bnNeeded) {
      const row = board.get(bn);
      if (row?.price > 0) {
        for (const [, m] of marks) {
          if (m.bn === bn) setMark(m.chain, m.pair, { price: row.price, source: "binance" });
        }
      }
    }
    notify(true);
  }

  function schedule() {
    stopTimers();
    if (!running) return;
    if (document.visibilityState === "hidden") return;
    // Only poll Dex for legacy positions; board is WS-driven
    dexTimer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      collectTargets();
      if (dexTargets.length) pollDex();
    }, DEX_POLL_MS);
  }

  async function start(opts = {}) {
    if (opts.getPositions) getPositions = opts.getPositions;
    if (opts.liveModeOn != null) liveModeOn = !!opts.liveModeOn;
    running = true;
    await tickOnce();
    schedule();
  }
  function stop() {
    running = false;
    stopTimers();
    if (ws) { try { ws.close(); } catch {} ws = null; }
    wsStreams = new Set();
  }
  function setLiveMode(on) {
    liveModeOn = !!on;
    if (running) schedule();
  }
  function sync(getPos) {
    if (getPos) getPositions = getPos;
    if (!running) return start({ getPositions });
    return tickOnce().then(schedule);
  }
  function onTick(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  }
  function hasOpenPositions() {
    const { spot = [], lev = [] } = getPositions() || {};
    return spot.length + lev.length > 0;
  }

  document.addEventListener("visibilitychange", () => {
    if (!running) return;
    if (document.visibilityState === "hidden") {
      stopTimers();
      if (ws) { try { ws.close(); } catch {} ws = null; }
    } else {
      tickOnce().then(schedule);
    }
  });

  /** Add symbols (e.g. 急升榜 rows) to the WS miniTicker set so price / 24h % tick without refresh. */
  function watchExtra(list) {
    const next = new Set((list || []).filter((s) => !bnListed || !bnListed.size || bnListed.has(s)));
    const same = next.size === extraSyms.size && [...next].every((s) => extraSyms.has(s));
    if (same && ws && ws.readyState <= 1) return;
    extraSyms = next;
    const { bnNeeded } = collectTargets();
    rebuildWs([...new Set([...boardSymbols, ...bnNeeded, ...extraSyms])]);
  }

  window.MCE = window.MCE || {};
  window.MCE.live = {
    start, stop, sync, onTick, getMark, sourceLabel, setLiveMode, classify,
    hasOpenPositions, ensureBoard, getBoardRows, fetchKlines, fetchKlineBars, warmSparks,
    sparkSvg, sparkPath, scoreBoardRows, scoreChaseRows, computeSetupPicks, computeGainerBoard, watchExtra,
    _gb: { surgeFeats, surgeFire, early2At, early2Trigger, surgeTrigger },
    logoUrl, coinLogoEl, letterAvatar, ICON_EMOJI,
    ensureExchangeInfo, isTokenized: (base) => bnTokenized.has(String(base || "").toUpperCase()),
    isStable: (base) => GB_STABLE.has(String(base || "").toUpperCase()),
    isLeveragedToken: (base) => /(UP|DOWN|BULL|BEAR)$/.test(String(base || "").toUpperCase()) && !GB_LEV_OK.has(String(base || "").toUpperCase()),
    DEX_POLL_MS, MINT_TO_BN, CURATED_BASES, BN_REST,
    get running() { return running; },
    get marks() { return marks; },
    get board() { return board; },
    get boardSymbols() { return boardSymbols; },
  };
})();
