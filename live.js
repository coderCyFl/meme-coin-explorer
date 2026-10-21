/* Hybrid live marks: Binance public REST+WS for CEX board + mapped assets;
 * DexScreener REST poll for on-chain memes. No API keys. */
(() => {
  "use strict";
  const BN_REST = "https://data-api.binance.vision";
  const BN_WS = "wss://data-stream.binance.vision/stream";
  const DEX_POLL_MS = 4000;
  const UI_THROTTLE_MS = 400;

  // Curated USDT spot bases — majors + meme-ish. Only shown if TRADING on exchangeInfo.
  const CURATED_BASES = [
    "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "LINK", "DOT",
    "NEAR", "APT", "ARB", "OP", "SUI", "INJ", "TIA", "SEI", "JUP", "PYTH",
    "W", "ENA", "EIGEN", "AAVE", "UNI", "LTC", "BCH", "ATOM", "PEPE", "SHIB",
    "FLOKI", "BONK", "WIF", "BOME", "MEME", "NEIRO", "PNUT", "ACT", "PENGU",
    "TRUMP", "TURBO", "ORDI", "NOT", "HMSTR", "PEOPLE", "ANIME", "1000SATS",
    "1MBABYDOGE", "WLD", "MOVE", "FET", "RENDER", "ONDO", "PENDLE",
  ];

  // Only map when we know the contract IS the Binance asset (avoid pump.fun clones).
  const MINT_TO_BN = {
    "solana:So11111111111111111111111111111111111111112": "SOLUSDT",
    "solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONKUSDT",
    "solana:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIFUSDT",
    "solana:ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82": "BOMEUSDT",
    "solana:6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN": "TRUMPUSDT",
    "ethereum:0x6982508145454ce325ddbe47a25d4ec3d2311933": "PEPEUSDT",
    "ethereum:0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce": "SHIBUSDT",
    "ethereum:0xcf0c122c6b73ff809c693db761e7baebe62b6a2e": "FLOKIUSDT",
    "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": null,
    "bsc:0xba2ae424d960c26247dd6c32edc70b295c744c43": "DOGEUSDT",
  };

  const marks = new Map(); // key chain:pair -> { price, liq, source, symbol, bn, t, chg24, volQuote }
  const board = new Map(); // SYMBOL -> row
  const watchers = new Set();
  let bnListed = null; // Set of SYMBOLUSDT
  let boardSymbols = []; // filtered curated that are TRADING
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

  const keyOf = (chain, pair) => chain + ":" + pair;
  const mintKey = (chain, token) => (chain && token ? String(chain).toLowerCase() + ":" + String(token) : "");

  function setMark(chain, pair, patch) {
    const k = keyOf(chain, pair);
    const prev = marks.get(k) || {};
    const next = { ...prev, ...patch, chain, pair, t: Date.now() };
    marks.set(k, next);
    return next;
  }

  function getMark(chain, pair) {
    return marks.get(keyOf(chain, pair)) || null;
  }

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
      bnListed = new Set(
        (j.symbols || [])
          .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT" && s.isSpotTradingAllowed)
          .map((s) => s.symbol)
      );
    } catch (e) {
      console.warn("Binance exchangeInfo failed", e);
      bnListed = new Set();
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
    if (m.source === "dex") return "Dex 即時（每 " + (DEX_POLL_MS / 1000) + " 秒）";
    return "";
  }

  function applyBnTick(sym, px, extra) {
    if (!sym || !(px > 0)) return;
    // Board row
    const row = board.get(sym) || { symbol: sym, base: sym.replace(/USDT$/, "") };
    const prev = row.price;
    Object.assign(row, extra || {}, { price: px, t: Date.now() });
    if (prev != null && prev !== px) row._flash = px > prev ? "up" : "down";
    board.set(sym, row);

    // Synthetic board mark
    setMark("binance", sym, {
      bn: sym, price: px, source: "binance", symbol: row.base,
      liq: 1e12, chg24: row.chg24, volQuote: row.volQuote,
      _flash: row._flash || null,
    });

    // Any position marks mapped to this bn
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
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    if (!next.size) return;
    const streams = [...next].map((s) => s.toLowerCase() + "@miniTicker").join("/");
    const url = BN_WS + "?streams=" + streams;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.warn("WS open failed", e);
      return;
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const d = msg.data || msg;
        const sym = d.s;
        const px = parseFloat(d.c || d.p);
        if (!sym || !(px > 0)) return;
        const chg = d.P != null ? parseFloat(d.P) : undefined;
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
    // Batch 24hr ticker — URL length safe in chunks of 40
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
          });
        }
      } catch (e) {
        console.warn("Binance 24hr seed failed", e);
        // Fallback per-symbol price
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

  async function ensureBoard(force) {
    if (boardReady && !force && board.size) return getBoardRows();
    if (boardLoading) return boardLoading;
    boardLoading = (async () => {
      await ensureExchangeInfo();
      boardSymbols = CURATED_BASES
        .map((b) => b + "USDT")
        .filter((s) => bnListed.has(s));
      await seedBoardRest(boardSymbols);
      boardReady = true;
      // Keep WS covering board + open positions
      const { bnNeeded } = collectTargets();
      const all = [...new Set([...boardSymbols, ...bnNeeded])];
      rebuildWs(all);
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
            price: px,
            liq,
            source: "dex",
            p,
            symbol: prev?.symbol,
            _flash: prev?.price != null && prev.price !== px ? (px > prev.price ? "up" : "down") : null,
          });
          if (window.MCE.paper && window.MCE.paper.ingestPair) {
            window.MCE.paper.ingestPair(chain, pair, p);
          }
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
    const allBn = [...new Set([...boardSymbols, ...bnNeeded])];
    rebuildWs(allBn);
    if (dexTargets.length) await pollDex();
    // Re-seed any bnNeeded missing price
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
    dexTimer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      collectTargets();
      if (dexTargets.length || liveModeOn) pollDex();
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

  window.MCE = window.MCE || {};
  window.MCE.live = {
    start, stop, sync, onTick, getMark, sourceLabel, setLiveMode, classify,
    hasOpenPositions, ensureBoard, getBoardRows,
    DEX_POLL_MS, MINT_TO_BN, CURATED_BASES,
    get running() { return running; },
    get marks() { return marks; },
    get board() { return board; },
    get boardSymbols() { return boardSymbols; },
  };
})();
