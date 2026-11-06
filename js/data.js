/* Crypto.M — market data.
 * Live: Binance public REST + WebSocket (no key). If Binance can't be reached (blocked network, preview
 * sandbox), the app switches to a clearly-labelled demo market so every screen still works. */
(function (root) {
  "use strict";
  const REST = "https://data-api.binance.vision/api/v3";
  const WS = "wss://data-stream.binance.vision/ws/!miniTicker@arr";
  const MIN_QUOTE_VOL = 3e6;   // skip coins with < $3M traded in 24h (too thin, easy to manipulate)
  const MAX_COINS = 150;
  const KLINE_LIMIT = 400;     // ~4 days of 15m candles: 24h for the score + ~3 days to backtest it
  const STABLES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USDE", "XUSD", "USD1", "PAXG", "WBTC", "BFUSD", "EURI"]);

  const names = {
    BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB", DOGE: "Dogecoin", PEPE: "Pepe", WIF: "dogwifhat",
    BONK: "Bonk", FLOKI: "Floki", SHIB: "Shiba Inu", TURBO: "Turbo", BOME: "Book of Meme", NEIRO: "Neiro",
    PNUT: "Peanut", ACT: "Act I", MEME: "Memecoin", XRP: "XRP", SUI: "Sui", TRUMP: "Official Trump", PENGU: "Pudgy Penguins",
    ORDI: "ORDI", NOT: "Notcoin", PEOPLE: "ConstitutionDAO", ADA: "Cardano", AVAX: "Avalanche", LINK: "Chainlink",
    TON: "Toncoin", APT: "Aptos", ARB: "Arbitrum", OP: "Optimism", INJ: "Injective", SEI: "Sei", TIA: "Celestia",
    FET: "Artificial Superintelligence", RENDER: "Render", WLD: "Worldcoin", JUP: "Jupiter", ENA: "Ethena", "1000SATS": "SATS",
    DOGS: "Dogs", HMSTR: "Hamster Kombat", CATI: "Catizen", MEW: "cat in a dogs world", POPCAT: "Popcat", BRETT: "Brett",
    GOAT: "Goatseus Maximus", MOODENG: "Moo Deng", CHILLGUY: "Just a chill guy", FARTCOIN: "Fartcoin", VIRTUAL: "Virtuals",
  };
  let bnNames = {};
  const nameOf = (base) => names[base] || (bnNames[base] && bnNames[base].n) || base;
  function setNames(a) { bnNames = a || {}; }

  async function getJSON(url, ms) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms || 8000);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(to); }
  }

  function eligible(t) {
    if (!t.symbol.endsWith("USDT")) return false;
    const base = t.symbol.slice(0, -4);
    if (!base || STABLES.has(base)) return false;
    if (/(UP|DOWN|BULL|BEAR)$/.test(base) && base.length > 4) return false;
    return +t.quoteVolume >= MIN_QUOTE_VOL && +t.lastPrice > 0;
  }
  /** Gainers universe: all USDT spot, excl stables + leveraged tokens; no volume floor. */
  function gainerEligible(t) {
    if (!t.symbol.endsWith("USDT")) return false;
    const base = t.symbol.slice(0, -4);
    if (!base || STABLES.has(base)) return false;
    if (/(UP|DOWN|BULL|BEAR)$/.test(base) && base.length > 4) return false;
    return +t.lastPrice > 0;
  }
  function mapTicker(t) {
    const base = t.symbol.slice(0, -4);
    return {
      sym: t.symbol, base, name: nameOf(base),
      price: +t.lastPrice, open24: +t.openPrice, high24: +t.highPrice, low24: +t.lowPrice, qv24: +t.quoteVolume,
    };
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (_) { out[k] = null; } }
    }));
    return out;
  }

  /* ---------------- live ---------------- */
  const live = {
    mode: "live",
    async probe() { await getJSON(REST + "/ping", 5000); return true; },
    async tickers() {
      const all = await getJSON(REST + "/ticker/24hr?type=MINI");
      return all.filter(eligible).map(mapTicker).sort((a, b) => b.qv24 - a.qv24).slice(0, MAX_COINS);
    },
    /** Full Gainers board universe (same filters as Binance spot USDT excl stables / UP-DOWN). */
    async tickersAll() {
      const all = await getJSON(REST + "/ticker/24hr?type=MINI");
      return all.filter(gainerEligible).map(mapTicker);
    },
    async klines(sym) {
      return root.Strategy.parseKlines(await getJSON(`${REST}/klines?symbol=${sym}&interval=15m&limit=${KLINE_LIMIT}`, 10000));
    },
    async scan(onProgress) {
      const ticks = await this.tickers();
      const syms = ticks.map((t) => t.sym);
      if (!syms.includes("BTCUSDT")) syms.push("BTCUSDT");
      let done = 0;
      const series = await pool(syms, 8, async (s) => { const k = await this.klines(s); onProgress && onProgress(++done, syms.length); return k; });
      const bySym = {}; syms.forEach((s, i) => { if (series[i]) bySym[s] = series[i]; });
      return { ticks, series: bySym };
    },
    /** Exact price N ms after a time (for the signal log). */
    async priceAt(sym, t) {
      const k = await getJSON(`${REST}/klines?symbol=${sym}&interval=1m&startTime=${t}&limit=1`);
      return k && k[0] ? +k[0][4] : null;
    },
    stream(onPrices) {
      let ws, dead = false, retry = 1000;
      const open = () => {
        if (dead) return;
        try { ws = new WebSocket(WS); } catch (_) { return; }
        ws.onmessage = (ev) => {
          try {
            const arr = JSON.parse(ev.data), m = {};
            for (const x of arr) {
              if (!x.s || !x.s.endsWith("USDT")) continue;
              m[x.s] = { c: +x.c, o: +x.o, q: +x.q };
            }
            onPrices(m); retry = 1000;
          } catch (_) {}
        };
        ws.onclose = () => { if (!dead) setTimeout(open, (retry = Math.min(retry * 2, 30000))); };
      };
      open();
      return () => { dead = true; try { ws && ws.close(); } catch (_) {} };
    },
  };

  /* ---------------- demo ---------------- */
  // Seeded so the demo looks the same each load; prices still move every couple of seconds.
  function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const DEMO = [
    ["BTC", 68250, 2.1e9], ["ETH", 3420, 1.1e9], ["SOL", 162.4, 6.2e8], ["BNB", 584, 3.1e8], ["DOGE", 0.1612, 4.4e8],
    ["PEPE", 0.00001128, 3.9e8], ["WIF", 2.41, 2.2e8], ["BONK", 0.00002612, 1.6e8], ["FLOKI", 0.0001721, 9.1e7],
    ["SHIB", 0.00001795, 1.1e8], ["TURBO", 0.00721, 6.4e7], ["BOME", 0.00871, 5.2e7], ["NEIRO", 0.00152, 7.7e7],
    ["PNUT", 0.512, 8.8e7], ["MEME", 0.0179, 2.3e7], ["SUI", 1.88, 2.6e8], ["TRUMP", 11.42, 1.9e8],
    ["PENGU", 0.0214, 9.9e7], ["ORDI", 31.2, 4.8e7], ["XRP", 0.582, 5.4e8],
    ["AVAX", 27.9, 1.2e8], ["LINK", 13.8, 1.0e8], ["FET", 1.42, 8.3e7], ["WLD", 2.12, 7.1e7], ["ENA", 0.412, 9.4e7],
    ["MEW", 0.00488, 1.8e7], ["POPCAT", 0.884, 4.2e7], ["MOODENG", 0.121, 3.6e7],
    ["GOAT", 0.392, 2.7e7], ["FARTCOIN", 0.744, 5.9e7],
  ];
  // Coins that are setting up right now (squeeze → volume + buyers → breakout) and two that already ran.
  const EARLY_NOW = { WIF: 1.0, NEIRO: 0.9, POPCAT: 0.85, PNUT: 0.7, FET: 0.55 };
  const LATE_NOW = { TURBO: 0.38, MOODENG: 0.31 };

  function demoSeries(base, p0, qv24, seed) {
    const r = rng(seed), n = KLINE_LIMIT, now = Math.floor(Date.now() / 9e5) * 9e5;
    const s = { t: new Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n),
      c: new Float64Array(n), qv: new Float64Array(n), tbq: new Float64Array(n), n };
    const vol = base === "BTC" ? 0.0028 : base === "ETH" ? 0.0035 : 0.0065 + r() * 0.004;
    const hourQv = qv24 / 96;
    // a few historic pump episodes so the backtest has something to find (some work, some fail)
    const episodes = [];
    for (let e = 0; e < 3; e++) episodes.push({ at: 110 + Math.floor(r() * (n - 150)), win: r() < 0.42, size: 0.03 + r() * 0.07 });
    let price = p0 * (0.85 + r() * 0.3), trend = 0;
    const early = EARLY_NOW[base], late = LATE_NOW[base];
    for (let i = 0; i < n; i++) {
      let drift = 0, vMul = 1, qMul = 1, buy = 0.5 + (r() - 0.5) * 0.06;
      for (const ep of episodes) {
        const d = i - ep.at;
        if (d >= -48 && d < -4) vMul = 0.45;                          // squeeze
        if (d >= -4 && d < 0) { drift = 0.006; qMul = 3.2; buy = 0.64; } // ignition
        if (d >= 0 && d < 12) { drift = ep.win ? ep.size / 12 : -0.006; qMul = ep.win ? 2.4 : 1.4; buy = ep.win ? 0.6 : 0.46; }
      }
      if (early && i >= n - 52 && i < n - 5) vMul = 0.4;
      if (early && i >= n - 5) { drift = 0.0055 * early; qMul = 2.6 + 2.2 * early; buy = 0.6 + 0.06 * early; }
      if (late && i >= n - 40) { drift = late / 40; qMul = 3; buy = 0.58; }
      trend = trend * 0.97 + (r() - 0.5) * 0.0004;
      const ret = drift + trend + (r() - 0.5) * 2 * vol * vMul;
      const o = price; price = Math.max(price * (1 + ret), p0 * 0.05);
      const wig = vol * vMul * (0.3 + r() * 0.7);
      s.t[i] = now - (n - 1 - i) * 9e5; s.o[i] = o; s.c[i] = price;
      s.h[i] = Math.max(o, price) * (1 + wig * r()); s.l[i] = Math.min(o, price) * (1 - wig * r());
      s.qv[i] = hourQv / 4 * qMul * (0.6 + r() * 0.8) * (vMul < 1 ? 0.7 : 1);
      s.tbq[i] = s.qv[i] * Math.max(0.3, Math.min(0.8, buy));
    }
    // rescale so the last close equals the demo price
    const k = p0 / s.c[n - 1];
    for (let i = 0; i < n; i++) { s.o[i] *= k; s.h[i] *= k; s.l[i] *= k; s.c[i] *= k; }
    return s;
  }

  const demo = {
    mode: "demo",
    _series: null, _ticks: null,
    async probe() { return true; },
    async tickersAll() {
      if (!this._ticks) await this.scan();
      return this._ticks.slice();
    },
    async scan(onProgress) {
      if (!this._series) {
        this._series = {}; this._ticks = [];
        DEMO.forEach(([base, p, qv], i) => {
          const s = demoSeries(base, p, qv, 1000 + i * 7919);
          const sym = base + "USDT";
          this._series[sym] = s;
          this._ticks.push({ sym, base, name: nameOf(base), price: s.c[s.n - 1], open24: s.c[s.n - 97],
            high24: Math.max(...s.h.slice(s.n - 96)), low24: Math.min(...s.l.slice(s.n - 96)), qv24: qv });
        });
      }
      onProgress && onProgress(1, 1);
      return { ticks: this._ticks, series: this._series };
    },
    async priceAt() { return null; },
    stream(onPrices) {
      const r = rng(42);
      const id = setInterval(() => {
        if (!this._series) return;
        const m = {};
        for (const sym in this._series) {
          const s = this._series[sym], base = sym.slice(0, -4);
          const bias = EARLY_NOW[base] ? 0.0009 * EARLY_NOW[base] : 0;
          const p = s.c[s.n - 1] * (1 + bias + (r() - 0.5) * 0.003);
          s.c[s.n - 1] = p; s.h[s.n - 1] = Math.max(s.h[s.n - 1], p); s.l[s.n - 1] = Math.min(s.l[s.n - 1], p);
          m[sym] = p;
        }
        onPrices(m);
      }, 2000);
      return () => clearInterval(id);
    },
  };

  /** Try Binance; fall back to the demo market. `?demo=1` forces demo. */
  async function connect() {
    const force = /[?&]demo=1/.test(location.search);
    if (!force) { try { await live.probe(); return live; } catch (_) {} }
    return demo;
  }

  root.Market = { connect, live, demo, nameOf, setNames, gainerEligible };
})(window);
