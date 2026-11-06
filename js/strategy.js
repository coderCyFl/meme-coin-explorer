/* Crypto.M — Early Score strategy.
 *
 * Idea: find coins where buying pressure is building BEFORE a big move, and refuse to chase
 * coins that already pumped (the old "gainer" rule bought after the move and lost on average).
 *
 * Works on 15-minute candles. Six signals, 100 points total:
 *   Volume surge     25  last 1h volume vs the average hour of the prior 24h
 *   Early momentum   20  last 1h price change in the "early" zone (+1% … +5%)
 *   Breakout         15  price above the prior 24h high
 *   Squeeze          10  the 12h before was tight (quiet before the move)
 *   Buyers in control 15 share of volume from market buys (taker buy)
 *   Beating BTC      15  4h return minus BTC's 4h return
 * Late filter: 24h > +25% or 1h > +12%  → "Already pumped" (watch only, no buy).
 *
 * Every number here is checked by backtest() on the same candles, so the app shows
 * whether the rule actually worked recently instead of just claiming it does.
 */
(function (root) {
  "use strict";

  const BARS_1H = 4, BARS_4H = 16, BARS_12H = 48, BARS_24H = 96;
  const MIN_BARS = BARS_24H + BARS_1H + 4;
  const FEE_ROUND_TRIP = 0.002; // 0.1% each side

  const STAGE = { early: "early", build: "build", late: "late", quiet: "quiet" };
  /** Every tunable number in one place. The strategy bot changes these (and only these, unless a new
   *  signal is proposed), then proves the change with `node tools/backtest.mjs`. */
  const PARAMS = {
    earlyMin: 70, buildMin: 50,          // score cut-offs
    late24h: 0.25, late1h: 0.12,         // "Already pumped" filter
    chase24hPenalty: 0.15,               // −15 points above this 24h gain
    rvolFull: 3.5,                       // volume surge earns full points at this multiple
    mom: [1, 5, 8],                      // 1h % zone: ramps to 1%, full to 5%, fades to 8%
    buyers: [0.52, 0.56, 0.62],          // taker-buy share for 4 / 9 / 15 points
    rs: [0.005, 0.015, 0.03],            // 4h return vs BTC for 4 / 9 / 15 points
    squeeze: [0.04, 0.07, 0.10],         // prior 12h range for 10 / 6 / 3 points
    stopAtr: 2, t1Atr: 3, t2Atr: 6, holdHours: 4,
    stopMin: 0.025, stopMax: 0.06, t1Min: 0.04, t1Max: 0.10, t2Min: 0.08, t2Max: 0.20,
  };
  let EARLY_MIN = PARAMS.earlyMin, BUILD_MIN = PARAMS.buildMin;
  function setParams(over) { Object.assign(PARAMS, over || {}); EARLY_MIN = PARAMS.earlyMin; BUILD_MIN = PARAMS.buildMin; api.EARLY_MIN = EARLY_MIN; api.BUILD_MIN = BUILD_MIN; }

  /** Binance kline arrays → column arrays. */
  function parseKlines(rows) {
    const n = rows.length;
    const s = { t: new Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n),
      c: new Float64Array(n), qv: new Float64Array(n), tbq: new Float64Array(n), n };
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      s.t[i] = +r[0]; s.o[i] = +r[1]; s.h[i] = +r[2]; s.l[i] = +r[3]; s.c[i] = +r[4];
      s.qv[i] = +r[7]; s.tbq[i] = +r[10];
    }
    return s;
  }

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function sum(a, from, to) { let x = 0; for (let i = from; i <= to; i++) x += a[i]; return x; }
  function max(a, from, to) { let x = -Infinity; for (let i = from; i <= to; i++) if (a[i] > x) x = a[i]; return x; }
  function min(a, from, to) { let x = Infinity; for (let i = from; i <= to; i++) if (a[i] < x) x = a[i]; return x; }

  function atrPct(s, i, len) {
    len = len || 14;
    let tr = 0;
    for (let k = i - len + 1; k <= i; k++) {
      const pc = s.c[k - 1];
      tr += Math.max(s.h[k] - s.l[k], Math.abs(s.h[k] - pc), Math.abs(s.l[k] - pc));
    }
    return tr / len / s.c[i];
  }

  /** BTC 4h return at the same candle time (aligned by open time). */
  function btcRet4h(btc, t) {
    if (!btc || !btc._idx) return 0;
    const j = btc._idx.get(t);
    if (j == null || j < BARS_4H) return 0;
    return btc.c[j] / btc.c[j - BARS_4H] - 1;
  }
  function indexSeries(s) {
    if (s && !s._idx) { s._idx = new Map(); for (let i = 0; i < s.n; i++) s._idx.set(s.t[i], i); }
    return s;
  }

  /** Trade plan from volatility: stop ~2 ATR, targets ~3 and ~6 ATR, clamped to sane ranges. */
  function planFor(price, atr) {
    const Q = PARAMS;
    const stopPct = clamp(Q.stopAtr * atr, Q.stopMin, Q.stopMax);
    const t1Pct = clamp(Q.t1Atr * atr, Q.t1Min, Q.t1Max);
    const t2Pct = clamp(Q.t2Atr * atr, Q.t2Min, Q.t2Max);
    return {
      entry: price,
      stop: price * (1 - stopPct), stopPct,
      t1: price * (1 + t1Pct), t1Pct,
      t2: price * (1 + t2Pct), t2Pct,
      holdHours: Q.holdHours,
    };
  }

  /**
   * Score candle i of series s. Returns null when there is not enough history.
   * `priceOverride` lets the live price stand in for the forming candle's close.
   */
  function scoreAt(s, i, btc, priceOverride) {
    if (!s || i < MIN_BARS || i >= s.n) return null;
    const c = priceOverride || s.c[i];

    const qv1h = sum(s.qv, i - BARS_1H + 1, i);
    const baseHour = sum(s.qv, i - BARS_24H - BARS_1H + 1, i - BARS_1H) / (BARS_24H / BARS_1H);
    const rvol = baseHour > 0 ? qv1h / baseHour : 0;

    const ret1h = c / s.c[i - BARS_1H] - 1;
    const ret4h = c / s.c[i - BARS_4H] - 1;
    const ret24h = c / s.c[i - BARS_24H] - 1;

    const priorHigh = max(s.h, i - BARS_24H - BARS_1H + 1, i - BARS_1H);
    const sqzHi = max(s.h, i - BARS_1H - BARS_12H + 1, i - BARS_1H);
    const sqzLo = min(s.l, i - BARS_1H - BARS_12H + 1, i - BARS_1H);
    const squeeze = (sqzHi - sqzLo) / c;

    const buyRatio = qv1h > 0 ? sum(s.tbq, i - BARS_1H + 1, i) / qv1h : 0.5;
    const rs = ret4h - btcRet4h(btc, s.t[i]);
    const atr = atrPct(s, i);

    const Q = PARAMS, p = {};
    p.volume = rvol <= 1 ? 0 : Math.min(1, (rvol - 1) / (Q.rvolFull - 1)) * 25;
    const r1 = ret1h * 100, [m0, m1, m2] = Q.mom;
    p.momentum = r1 <= 0 ? 0 : r1 < m0 ? r1 / m0 * 20 : r1 <= m1 ? 20 : r1 <= m2 ? 20 - (r1 - m1) / (m2 - m1) * 16 : 4;
    p.breakout = c > priorHigh ? 15 : c > priorHigh * 0.985 ? 7 : 0;
    p.squeeze = squeeze < Q.squeeze[0] ? 10 : squeeze < Q.squeeze[1] ? 6 : squeeze < Q.squeeze[2] ? 3 : 0;
    p.buyers = buyRatio >= Q.buyers[2] ? 15 : buyRatio >= Q.buyers[1] ? 9 : buyRatio >= Q.buyers[0] ? 4 : 0;
    p.strength = rs >= Q.rs[2] ? 15 : rs >= Q.rs[1] ? 9 : rs >= Q.rs[0] ? 4 : 0;

    let score = p.volume + p.momentum + p.breakout + p.squeeze + p.buyers + p.strength;
    // Momentum needs to be real: no upward move = no signal, however good the rest looks.
    if (ret1h <= 0) score = Math.min(score, 35);
    if (ret24h > Q.chase24hPenalty) score -= 15;
    score = Math.round(clamp(score, 0, 100));

    const late = ret24h > Q.late24h || ret1h > Q.late1h;
    const stage = late ? STAGE.late : score >= EARLY_MIN ? STAGE.early : score >= BUILD_MIN ? STAGE.build : STAGE.quiet;

    return {
      score, stage, parts: p,
      metrics: { rvol, ret1h, ret4h, ret24h, priorHigh, squeeze, buyRatio, rs, atr },
      plan: planFor(c, atr),
    };
  }

  /** Short human reasons, strongest first (keys are i18n ids, values are filled into the text). */
  function reasons(r) {
    if (!r) return [];
    const m = r.metrics, p = r.parts, out = [];
    if (p.volume >= 10) out.push({ k: "why.volume", v: m.rvol.toFixed(1) + "×", w: p.volume / 25 });
    if (p.breakout >= 15) out.push({ k: "why.breakout", w: 1 });
    else if (p.breakout > 0) out.push({ k: "why.nearHigh", w: 0.5 });
    if (p.buyers >= 9) out.push({ k: "why.buyers", v: Math.round(m.buyRatio * 100) + "%", w: p.buyers / 15 });
    if (p.strength >= 9) out.push({ k: "why.btc", v: "+" + (m.rs * 100).toFixed(1) + "%", w: p.strength / 15 });
    if (p.squeeze >= 6) out.push({ k: "why.squeeze", w: p.squeeze / 10 });
    if (r.stage === STAGE.late) out.unshift({ k: "why.late", v: "+" + (Math.max(m.ret24h, m.ret1h) * 100).toFixed(0) + "%", w: 2 });
    return out.sort((a, b) => b.w - a.w).slice(0, 3);
  }

  /**
   * Replay one trade with the plan on candles after entry bar j.
   * Half sells at target 1 (stop moves to entry), rest at target 2, or everything at the time limit.
   * If a candle touches both stop and target we assume the stop hit first (pessimistic).
   */
  function simulate(s, j, plan) {
    const end = Math.min(s.n - 1, j + plan.holdHours * BARS_1H);
    let stop = plan.stop, half = false, realized = 0, exitBar = end, how = "time";
    for (let k = j + 1; k <= end; k++) {
      if (s.l[k] <= stop) {
        realized += (half ? 0.5 : 1) * (stop / plan.entry - 1);
        exitBar = k; how = half ? "t1+be" : "stop"; return finish();
      }
      if (!half && s.h[k] >= plan.t1) { realized += 0.5 * (plan.t1 / plan.entry - 1); half = true; stop = plan.entry; }
      if (half && s.h[k] >= plan.t2) { realized += 0.5 * (plan.t2 / plan.entry - 1); exitBar = k; how = "t2"; return finish(); }
    }
    realized += (half ? 0.5 : 1) * (s.c[end] / plan.entry - 1);
    return finish();
    function finish() {
      const maxGain = max(s.h, j + 1, Math.max(j + 1, exitBar)) / plan.entry - 1;
      return { ret: realized - FEE_ROUND_TRIP, how, bars: exitBar - j, maxGain, t1Hit: half };
    }
  }

  /**
   * Backtest the rule over every coin's candle history (closed candles only).
   * One signal per coin per 4h (cooldown). Baseline = buying every coin at random times with the same exits.
   */
  function backtest(seriesBySym, btc, opts) {
    opts = opts || {};
    const minScore = opts.minScore || EARLY_MIN;
    const trades = [], base = [];
    indexSeries(btc);
    for (const sym in seriesBySym) {
      const s = seriesBySym[sym];
      if (!s || s.n < MIN_BARS + BARS_4H + 2) continue;
      const last = s.n - 2 - BARS_4H; // keep a full 4h of closed candles after entry
      let cooldown = -1;
      for (let j = MIN_BARS; j <= last; j++) {
        if ((opts.from && s.t[j] < opts.from) || (opts.to && s.t[j] >= opts.to)) continue;
        const r = scoreAt(s, j, btc);
        if (!r) continue;
        if (j % 8 === 0) base.push(simulate(s, j, r.plan).ret);
        if (j <= cooldown) continue;
        if (r.stage !== STAGE.late && r.score >= minScore) {
          const sim = simulate(s, j, r.plan);
          trades.push({ sym, t: s.t[j], score: r.score, entry: s.c[j], ret: sim.ret, how: sim.how, maxGain: sim.maxGain, t1Hit: sim.t1Hit, bars: sim.bars });
          cooldown = j + BARS_4H;
        }
      }
    }
    return { ...stats(trades.map((x) => x.ret)), baseline: stats(base), trades: trades.sort((a, b) => b.t - a.t),
      hitT1: trades.length ? trades.filter((x) => x.t1Hit).length / trades.length : 0,
      from: Math.min(...Object.values(seriesBySym).filter(Boolean).map((s) => s.t[MIN_BARS] || Infinity)) };
  }
  function stats(a) {
    if (!a.length) return { n: 0, win: 0, avg: 0, median: 0, total: 0 };
    const sorted = [...a].sort((x, y) => x - y);
    const tot = a.reduce((x, y) => x + y, 0);
    return { n: a.length, win: a.filter((x) => x > 0).length / a.length, avg: tot / a.length,
      median: sorted[Math.floor(sorted.length / 2)], total: tot, best: sorted[sorted.length - 1], worst: sorted[0] };
  }

  /**
   * All-in simulation over backtest trades: one position at a time, 100% of the balance, compounding.
   * When several coins signal at once, the highest score wins. Also returns a "stake" curve
   * (each trade uses `stake` of the balance, overlaps allowed) for comparison.
   */
  function allIn(trades, start, stake) {
    const BAR = 15 * 60 * 1000, sorted = [...trades].sort((a, b) => a.t - b.t || b.score - a.score);
    let bal = start, free = 0, peak = start, maxDD = 0, wins = 0;
    const taken = [], curve = [{ t: sorted.length ? sorted[0].t : 0, v: start }];
    for (const x of sorted) {
      if (x.t < free) continue;
      bal *= 1 + x.ret; free = x.t + (x.bars || 16) * BAR;
      if (x.ret > 0) wins++;
      peak = Math.max(peak, bal); maxDD = Math.min(maxDD, bal / peak - 1);
      taken.push({ ...x, bal }); curve.push({ t: free, v: bal });
    }
    let sb = start; const stakeCurve = [{ t: curve[0].t, v: start }];
    for (const x of sorted) { sb *= 1 + x.ret * (stake || 0.1); stakeCurve.push({ t: x.t + (x.bars || 16) * BAR, v: sb }); }
    const rets = taken.map((x) => x.ret);
    return { start, end: bal, ret: bal / start - 1, trades: taken, n: taken.length, win: taken.length ? wins / taken.length : 0,
      maxDD, best: rets.length ? Math.max(...rets) : 0, worst: rets.length ? Math.min(...rets) : 0, curve,
      stakeEnd: sb, stakeRet: sb / start - 1, stakeCurve };
  }

  const api = { PARAMS, setParams, allIn, parseKlines, scoreAt, reasons, planFor, simulate, backtest, indexSeries, STAGE, EARLY_MIN, BUILD_MIN, MIN_BARS, BARS_1H };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Strategy = api;
})(typeof window !== "undefined" ? window : globalThis);
