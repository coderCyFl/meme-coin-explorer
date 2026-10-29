/* AI 揀幣 scorecard + Crypto.M 紙上倉. Depends on window.MCE from app.js. */
(() => {
  "use strict";
  const { el, money, price, pct, fmtInt, localTime, safeUrl, cachedJson, API } = window.MCE;
  const $ = (id) => document.getElementById(id);
  const DEAD_LIQ = 1000;
  const S = { picks: null, outcomes: [], live: new Map(), solPair: null, news: null };

  // ---------- 簡單 / 完整 ----------
  const UI_KEY = "mce:ui:mode";
  let uiMode = localStorage.getItem(UI_KEY) || "simple";
  function applyUiMode(mode) {
    uiMode = mode === "full" ? "full" : "simple";
    localStorage.setItem(UI_KEY, uiMode);
    document.body.classList.toggle("ui-simple", uiMode === "simple");
    document.body.classList.toggle("ui-full", uiMode === "full");
    document.querySelectorAll("#uiModeToggle [data-ui]").forEach((b) => b.classList.toggle("active", b.dataset.ui === uiMode));
    document.querySelectorAll(".bn-simple").forEach((a) => { a.style.display = uiMode === "simple" ? "" : "none"; });
    document.querySelectorAll(".bn-full").forEach((a) => { a.style.display = uiMode === "full" ? "" : "none"; });
    const howto = $("howto");
    if (howto && uiMode === "simple") howto.open = false;
    // refresh current view
    const v = (location.hash || "#picks").slice(1);
    if (uiMode === "simple" && (v === "news" || v === "explore" || v === "browse") && location.hash) {
      /* allow deep link */
    }
  }


  /** Follow-report times: zh-HK 24h "10月22日 04:54" (Asia/Shanghai, no seconds). */
  const frTime = (iso) => {
    try {
      const d = new Date(iso);
      if (isNaN(d)) return iso || "";
      const p = {};
      new Intl.DateTimeFormat("zh-HK", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
      return `${+p.month}月${+p.day}日 ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    } catch (_) { return iso || ""; }
  };
  const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3.6e6;
  const held = (iso) => { const h = hoursSince(iso); return h < 48 ? `${h.toFixed(1)} 小時` : `${(h / 24).toFixed(1)} 日`; };
  const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const money2 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  /** Live weak-tape? Prefer regime banner, then last computeSetupPicks regime. */
  function liveWeakNow() {
    const box = $("regimeBanner");
    if (box && !box.hidden) return true;
    try {
      const r = window.MCE.live && window.MCE.live._lastSetupCache && window.MCE.live._lastSetupCache.regime;
      if (r && r.weak) return true;
    } catch (_) {}
    return false;
  }

  /**
   * Paper sell-timing for AI picks / open positions.
   * Fixed transparent rules (not a promise): normal 24h review +8/−5; weak 12h +5/−4.
   * Aligns with 24h outcomes seal; 72h as second look when not weak.
   */
  function paperExitPlan({ createdAt, weak, high24, entryPx, tpPct, slPct, reviewH, secondH, momentum, tp2Pct } = {}) {
    if (momentum) return momentumExitPlan({ createdAt, tpPct, tp2Pct, slPct, reviewH, secondH });
    const isWeak = !!weak;
    const rh = reviewH != null ? reviewH : (isWeak ? 12 : 24);
    const sh = secondH != null ? secondH : (isWeak ? 24 : 72);
    const tp = tpPct != null ? tpPct : (isWeak ? 5 : 8);
    const sl = slPct != null ? slPct : (isWeak ? 4 : 5);
    const baseMs = createdAt ? new Date(createdAt).getTime() : Date.now();
    const baseOk = !isNaN(baseMs);
    const reviewAt = baseOk ? new Date(baseMs + rh * 3600e3) : null;
    const secondAt = baseOk ? new Date(baseMs + sh * 3600e3) : null;
    const pastReview = reviewAt ? Date.now() >= reviewAt.getTime() : false;
    let whenText;
    if (!reviewAt) {
      whenText = `約 ${rh}h 後再睇`;
    } else if (pastReview) {
      whenText = isWeak
        ? `已過 ${rh}h · 宜決定賣定留`
        : `已過 ${rh}h · 宜決定賣定留` + (secondAt ? `（${sh}h ${frTime(secondAt)} 再對照）` : "");
    } else {
      whenText = `約 ${frTime(reviewAt)} 再睇`;
    }
    let trimNote = null;
    if (high24 > 0 && entryPx > 0) {
      const roomPct = (high24 / entryPx - 1) * 100;
      if (roomPct > 0.5 && roomPct < tp) {
        trimNote = `近 24h 高（+${roomPct.toFixed(1)}%）可減倉`;
      }
    }
    return {
      reviewAt, secondAt, reviewH: rh, secondH: sh, tp, sl, weak: isWeak, pastReview,
      whenText, tpText: `紙上 +${tp}%／-${sl}%`, trimNote,
    };
  }

  /**
   * 急升榜 momentum exit (separate from AI picks; NOT halved by weak-market gate).
   * TP ladder +20% (放一半, 止蝕升返成本) / +50% (清), SL −10%, recheck 4h, hold max 12h.
   */
  const GAINER_EXIT = { tp: 20, tp2: 50, sl: 10, reviewH: 4, secondH: 12 };
  /** 🚀 續升買 (Strategy 2026-10-30): same ladder, sell_by 24h; 細盤 gets CHASE_SMALL_MULT size. Mirrors gainer_core CHASE_*. */
  const CHASE_EXIT = { tp: 20, tp2: 50, sl: 10, reviewH: 4, secondH: 24 };
  const CHASE_SMALL_MULT = 1.5;
  const gbExitFor = (tier) => (tier === "chase" ? CHASE_EXIT : GAINER_EXIT);
  function momentumExitPlan({ createdAt, tpPct, tp2Pct, slPct, reviewH, secondH } = {}) {
    const tp = tpPct != null ? tpPct : GAINER_EXIT.tp;
    const tp2 = tp2Pct != null ? tp2Pct : GAINER_EXIT.tp2;
    const sl = slPct != null ? slPct : GAINER_EXIT.sl;
    const rh = reviewH != null ? reviewH : GAINER_EXIT.reviewH;
    const sh = secondH != null ? secondH : GAINER_EXIT.secondH;
    const baseMs = createdAt ? new Date(createdAt).getTime() : Date.now();
    const baseOk = !isNaN(baseMs);
    const reviewAt = baseOk ? new Date(baseMs + rh * 3600e3) : null;
    const secondAt = baseOk ? new Date(baseMs + sh * 3600e3) : null;
    const now = Date.now();
    const pastReview = reviewAt ? now >= reviewAt.getTime() : false;
    const pastHold = secondAt ? now >= secondAt.getTime() : false;
    let whenText;
    if (!secondAt) whenText = `最遲 ${sh}h 內走`;
    else if (pastHold) whenText = `已過 ${sh}h · 急升倉宜清`;
    else if (pastReview) whenText = `最遲 ${frTime(secondAt)} 走`;
    else whenText = `${frTime(reviewAt)} 再睇`;
    return {
      momentum: true, reviewAt, secondAt, reviewH: rh, secondH: sh, tp, tp2, sl, weak: false,
      pastReview: pastHold, pastRecheck: pastReview, whenText,
      tpText: `紙上 +${tp}%／+${tp2}%／-${sl}%`, trimNote: null,
    };
  }

  /** Shanghai calendar day YYYY-MM-DD for pick-meta bucket. */
  function shanghaiDay(d = new Date()) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    } catch (_) {
      return d.toISOString().slice(0, 10);
    }
  }

  /**
   * Freeze live-pick created_at + regime on first sight (per Shanghai day + symbol + angle).
   * Reload / recompute must not restart the 24h countdown or flip paper ±.
   */
  function stablePickMeta(symbol, angle, { weakNow } = {}) {
    const day = shanghaiDay();
    const key = "mce:pickMeta:v1:" + day + ":" + String(symbol || "").toUpperCase() + ":" + String(angle || "");
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && o.created_at) return o;
      }
    } catch (_) {}
    const weak = !!weakNow;
    const o = {
      created_at: new Date().toISOString(),
      exitRegime: weak ? "weak" : "normal",
      suggested_exit_h: weak ? 12 : 24,
      suggested_second_h: weak ? 24 : 72,
      take_profit_pct: weak ? 5 : 8,
      stop_loss_pct: weak ? 4 : 5,
    };
    try { localStorage.setItem(key, JSON.stringify(o)); } catch (_) {}
    return o;
  }

  /** Exit rule snapshot at open (persist on position). */
  function lockExitMeta({ weak } = {}) {
    const isWeak = weak != null ? !!weak : liveWeakNow();
    return {
      exitRegime: isWeak ? "weak" : "normal",
      suggested_exit_h: isWeak ? 12 : 24,
      suggested_second_h: isWeak ? 24 : 72,
      take_profit_pct: isWeak ? 5 : 8,
      stop_loss_pct: isWeak ? 4 : 5,
    };
  }

  /** Exit lock a NEW position gets from a buy request (window + doBuySpot + doOpenLev share this). */
  /* Exit plan follows the COIN, not the button you came from (QA 9faccce): 🔥 board momentum plan > today's AI pick plan.
   * Same pair → same meta from the 🔥 card, the AI card, 模擬倉 search, 睇幣 or 孤注一擲. */
  const EXIT_KEYS = ["exitRegime", "exitWeak", "suggested_exit_h", "suggested_second_h", "take_profit_pct", "take_profit2_pct", "stop_loss_pct", "flags", "size"];
  let gbPumpNow = new Set(), gbChaseNow = new Set();
  function coinExitMeta(pair) {
    if (!pair) return null;
    if (gbPumpNow.has(pair) || gbChaseNow.has(pair)) {
      const X = gbPumpNow.has(pair) ? GAINER_EXIT : CHASE_EXIT;
      return { exitRegime: "momentum", take_profit_pct: X.tp, take_profit2_pct: X.tp2, stop_loss_pct: X.sl,
        suggested_exit_h: X.reviewH, suggested_second_h: X.secondH, size: "full" };
    }
    const latest = S.picks && S.picks.batches && S.picks.batches[S.picks.batches.length - 1];
    const e = latest && (latest.entries || []).find((x) => x.type === "buy" && x.pair_address === pair);
    if (e && e.tier === "chase") {
      return { exitRegime: "momentum", take_profit_pct: e.take_profit_pct, take_profit2_pct: e.take_profit2_pct, stop_loss_pct: e.stop_loss_pct,
        suggested_exit_h: e.suggested_exit_h, suggested_second_h: e.suggested_second_h, size: "full" };
    }
    if (e) {
      const half = (e.flags || []).includes("size:half") || e.size === "half" || e.suggested_exit_h === 12 || (latest.regime && latest.regime.sizing === "half");
      return { exitRegime: e.exitRegime || (half ? "weak" : "normal"), suggested_exit_h: e.suggested_exit_h, suggested_second_h: e.suggested_second_h,
        take_profit_pct: e.take_profit_pct, stop_loss_pct: e.stop_loss_pct, take_profit2_pct: e.take_profit2_pct, flags: e.flags, size: half ? "half" : "full" };
    }
    return null;
  }
  function withCoinExit(info) {
    if (!info) return info;
    const meta = coinExitMeta(info.pair);
    if (!meta) return info;
    const out = { ...info };
    for (const k of EXIT_KEYS) delete out[k];
    for (const [k, v] of Object.entries(meta)) if (v != null) out[k] = v;
    return out;
  }
  function lockExitMetaForInfo(info) {
    info = withCoinExit(info);
    const weakOpen = info.exitWeak != null ? !!info.exitWeak
      : info.exitRegime === "weak" ? true
      : (info.exitRegime === "normal" || info.exitRegime === "momentum") ? false
      : (info.suggested_exit_h === 12 || (info.flags || []).includes("regime:weak") || info.size === "half")
        ? true
        : liveWeakNow();
    const lock = lockExitMeta({ weak: weakOpen });
    // Prefer pick-locked numbers when present
    if (info.suggested_exit_h != null) lock.suggested_exit_h = info.suggested_exit_h;
    if (info.suggested_second_h != null) lock.suggested_second_h = info.suggested_second_h;
    if (info.take_profit_pct != null) lock.take_profit_pct = info.take_profit_pct;
    if (info.stop_loss_pct != null) lock.stop_loss_pct = info.stop_loss_pct;
    if (info.exitRegime === "weak" || info.exitRegime === "normal" || info.exitRegime === "momentum") lock.exitRegime = info.exitRegime;
    if (info.take_profit2_pct != null) lock.take_profit2_pct = info.take_profit2_pct;
    if (info.exit_plan) lock.exit_plan = info.exit_plan;          // 🔥/🚀 paper buys carry their exit_plan text
    if (info.tier === "pump" || info.tier === "chase") lock.gb_tier = info.tier;
    return lock;
  }

  function exitPlanFromEntry(e, { weakOverride } = {}) {
    if (!e) return null;
    if (e.exitRegime === "momentum") {
      return momentumExitPlan({
        createdAt: e.created_at || e.openedAt || null, tpPct: e.take_profit_pct, tp2Pct: e.take_profit2_pct,
        slPct: e.stop_loss_pct, reviewH: e.suggested_exit_h, secondH: e.suggested_second_h,
      });
    }
    const flags = e.flags || [];
    const locked = e.exitRegime === "weak" || e.exitRegime === "normal"
      || e.suggested_exit_h != null || e.take_profit_pct != null;
    let weak;
    if (weakOverride != null) weak = !!weakOverride;
    else if (e.exitRegime === "weak") weak = true;
    else if (e.exitRegime === "normal") weak = false;
    else if (flags.includes("regime:weak") || flags.includes("size:half") || e.size === "half") weak = true;
    else if (locked) weak = false;
    else weak = liveWeakNow();
    const snap = e.entry_snapshot || {};
    return paperExitPlan({
      createdAt: e.created_at || e.openedAt || null,
      weak,
      high24: snap.high24h ?? e.high24h,
      entryPx: e.entry_price_usd ?? e.entry,
      tpPct: e.take_profit_pct,
      slPct: e.stop_loss_pct,
      reviewH: e.suggested_exit_h,
      secondH: e.suggested_second_h,
    });
  }

  /**
   * Live exit text = ONE template system for every would-be-buy surface (今日跟買 cards + table, hot buys,
   * 急升 banner / card / 詳情). First render AND every WS tick both go through exitTplText(exitLevels(plan,
   * buyFillPx(live))) so all of them show identical numbers to the buy window at the same live price.
   * Placeholders: {target} {target2} {stop} {tp} {tp2} {sl} {review} {until}  (review/until = buy now + h, with date).
   */
  function exitTplText(tpl, L, plan, nowMs = Date.now()) {
    const at = (h) => frTime(new Date(nowMs + h * 3600e3));
    const map = {
      target: () => (L ? price(L.targetPx) : "—"), target2: () => (L && L.target2Px != null ? price(L.target2Px) : "—"),
      stop: () => (L ? price(L.stopPx) : "—"), tp: () => plan.tp, tp2: () => plan.tp2, sl: () => plan.sl,
      review: () => at(plan.reviewH), until: () => at(plan.secondH),
      untilS: () => { const d = new Date(nowMs + plan.secondH * 3600e3); const t = frTime(d); return shanghaiDay(d) === shanghaiDay(new Date(nowMs)) ? t.slice(-5) : "明 " + t.slice(-5); },
    };
    return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (map[k] ? String(map[k]()) : m));
  }
  /** Container attrs: which pair + which plan; children carry data-exit-tpl. */
  function exitLiveAttrs(pair, plan, px, extra = {}) {
    const L = exitLevels(plan, px);
    const a = Object.assign({}, extra, {
      "data-exit-tp": String(plan.tp), "data-exit-tp2": plan.tp2 != null ? String(plan.tp2) : "", "data-exit-sl": String(plan.sl),
      "data-exit-rh": String(plan.reviewH), "data-exit-sh": String(plan.secondH),
    });
    if (pair) a["data-exit-pair"] = pair;
    if (L) Object.assign(a, { "data-basis": String(L.basePx), "data-target": String(L.targetPx), "data-stop": String(L.stopPx), "data-target2": L.target2Px != null ? String(L.target2Px) : "" });
    return a;
  }
  function exitLiveNode(tag, attrs, tpl, plan, px) {
    return el(tag, Object.assign({}, attrs, { "data-exit-tpl": tpl, text: exitTplText(tpl, exitLevels(plan, px), plan) }));
  }
  /** Plan a NEW buy would lock right now (fresh window from now — same as doBuySpot / buy window). */
  function wouldBuyPlan(info) {
    return exitPlanFromEntry(Object.assign({}, lockExitMetaForInfo(info), { created_at: new Date().toISOString(), entry_snapshot: info.entry_snapshot }));
  }

  /** Compact chips: 揸到 · 目標 · 止蝕. With {pair, basePx} = would-be buy at live price (ticks live). */
  function exitHintRow(plan, { className = "sc-exit", basePx = null, pair = null } = {}) {
    if (!plan) return "";
    const live = pair && basePx > 0;
    if (live) {
      const chip = (c, tpl) => exitLiveNode("span", { class: "exit-chip " + c }, tpl, plan, basePx);
      const kids = plan.momentum
        ? [chip("exit-tp", "🎯 {target}／{target2}"), chip("exit-sl", "止蝕 {stop}"), chip("exit-when", "最遲 {until}")]
        : [chip("exit-tp", "🎯 {target}"), chip("exit-sl", "止蝕 {stop}"), chip("exit-when", "揸到 {review}")];
      return el("div", exitLiveAttrs(pair, plan, basePx, { class: className, title: "而家落倉嘅話：目標／止蝕同落倉窗、持倉用同一條公式同一個即時價；落倉會由而家起計新嘅持有時間" }), ...kids);
    }
    const whenClean = String(plan.whenText || "").replace(/^約\s*/, "").replace(/\s*再睇$/, "");
    const holdTxt = plan.pastReview ? "宜決定賣定留" : ("揸到 " + (whenClean || plan.whenText));
    const kids = plan.momentum ? [
      el("span", { class: "exit-chip exit-when" + (plan.pastReview ? " exit-due" : ""), text: plan.whenText }),
      el("span", { class: "exit-chip exit-tp", text: "+" + plan.tp + "% 放一半" }),
      el("span", { class: "exit-chip exit-tp", text: "+" + plan.tp2 + "% 清" }),
      el("span", { class: "exit-chip exit-sl", text: "止蝕 −" + plan.sl + "%" }),
      el("span", { class: "exit-chip exit-when", text: plan.secondAt ? "最遲 " + frTime(plan.secondAt) : "最遲 " + plan.secondH + "h" }),
    ] : [
      el("span", { class: "exit-chip exit-when" + (plan.pastReview ? " exit-due" : ""), text: holdTxt }),
      el("span", { class: "exit-chip exit-tp", text: "目標 +" + plan.tp + "%" }),
      el("span", { class: "exit-chip exit-sl", text: "止蝕 −" + plan.sl + "%" }),
    ];
    if (plan.trimNote) kids.push(el("span", { class: "exit-chip exit-trim", text: plan.trimNote }));
    return el("div", { class: className, title: "幾時可以放 · 紙上參考唔係保證。" }, ...kids);
  }

  /** Live-tick every would-be-buy exit text (same formula + same live price as the buy window). */
  let exitTickAt = 0;
  function refreshExitChips(board, { force = false } = {}) {
    const nowMs = Date.now();
    if (!force && nowMs - exitTickAt < 400) return;
    exitTickAt = nowMs;
    document.querySelectorAll("[data-exit-pair]").forEach((n) => {
      const r = board && board.get(n.dataset.exitPair); if (!(r && r.price > 0)) return;
      const plan = { tp: +n.dataset.exitTp, tp2: n.dataset.exitTp2 ? +n.dataset.exitTp2 : null, sl: +n.dataset.exitSl,
        reviewH: +n.dataset.exitRh, secondH: +n.dataset.exitSh };
      const L = exitLevels(plan, buyFillPx({ price: r.price, source: "binance" }, 0));
      n.dataset.basis = String(L.basePx); n.dataset.target = String(L.targetPx); n.dataset.stop = String(L.stopPx);
      n.dataset.target2 = L.target2Px != null ? String(L.target2Px) : "";
      n.querySelectorAll("[data-exit-tpl]").forEach((c) => { const t = exitTplText(c.dataset.exitTpl, L, plan, nowMs); if (c.textContent !== t) c.textContent = t; });
    });
  }

  /**
   * Human exit copy for modal / holdings.
   * entryPx = basis for target; markPx = live mark (optional).
   */
  /**
   * THE single source for exit price levels. Buy window, card chips, 急升 cards and the
   * holdings 「幾時可以放」 block all call this with the same plan + basis price.
   */
  function exitLevels(plan, basePx) {
    if (!plan || !(basePx > 0)) return null;
    return {
      basePx,
      targetPx: basePx * (1 + plan.tp / 100),
      target2Px: plan.tp2 != null ? basePx * (1 + plan.tp2 / 100) : null,
      stopPx: basePx * (1 - plan.sl / 100),
    };
  }
  /** Price a buy actually fills at (same impact model as doBuySpot / doOpenLev). */
  function buyFillPx(li, notional) {
    if (li.source === "binance") return li.price; // CEX book: no pool impact (was ~0.0005% from liq 1e12)
    return li.price * (1 + estimateImpact(notional, li.liq || 0).impactPct / 100);
  }
  /** Exit basis of an open position = average FILL price (fees excluded). */
  function posBasisPx(pos) {
    if (!pos) return null;
    if (pos.entry != null) return pos.entry; // lev
    if (pos.qty > 0 && pos.fillNotional > 0) return pos.fillNotional / pos.qty;
    return pos.qty > 0 && pos.cost ? pos.cost / pos.qty : null; // legacy spot (pre-20261025c1)
  }

  const LEV_STOP_NOTE = "槓桿止蝕：計劃止蝕低過爆倉價，改用入場同爆倉中間";
  /**
   * Effective stop for a position. Spot (lev ≤ 1): the plan stop, unchanged.
   * Leverage: the plan stop if it sits ABOVE the liquidation price; otherwise halfway between
   * entry and liquidation (50x ≈ −0.9%). Target / review / latest exit are never touched.
   */
  function effectiveStop(planStopPx, entryPx, lev) {
    if (!(lev > 1) || !(entryPx > 0)) return { stopPx: planStopPx, adj: false, liq: null };
    const liq = liqPriceLong(entryPx, lev);
    if (planStopPx > liq) return { stopPx: planStopPx, adj: false, liq };
    return { stopPx: (entryPx + liq) / 2, adj: true, liq };
  }
  function exitGuideCopy(plan, entryPx, markPx, lev) {
    const g = exitGuideCopyPlan(plan, entryPx, markPx);
    if (!g) return g;
    g.planStopPx = g.stopPx; g.planSl = g.sl;
    const e = effectiveStop(g.stopPx, entryPx, lev);
    g.liqPx = e.liq;
    if (e.adj) {
      g.stopPx = e.stopPx; g.levStopAdj = true;
      g.sl = +((1 - e.stopPx / entryPx) * 100).toFixed(2);
      withStopLoss(g, null);
    }
    // Long only: mark at / below the effective stop → 已到止蝕 (row, card, 詳情 all read this flag).
    g.stopHit = markPx != null && isFinite(markPx) && markPx <= g.stopPx;
    return g;
  }
  const fmtSl = (v) => { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  /**
   * $ P&L if the stop fills — through the SAME open/close maths as real trades (fees both sides).
   * lev: { pos } or { margin, lev, entry };  spot: { pos } or { usd, entry }.
   */
  function stopLossUsd(kind, o, stopPx) {
    if (!(stopPx > 0)) return null;
    if (kind === "lev") {
      const pos = o.pos || (o.margin > 0 && o.entry > 0 ? calc.levOpen(o.margin, o.lev, o.entry) : null);
      return pos ? calc.levClose(pos, stopPx).pnl : null;
    }
    if (o.pos) return o.pos.qty > 0 ? calc.spotSell(o.pos.qty, stopPx).proceeds - o.pos.cost : null;
    if (!(o.usd > 0 && o.entry > 0)) return null;
    const b = calc.spotBuy(o.usd, o.entry);
    return calc.spotSell(b.qty, stopPx).proceeds - b.cost;
  }
  /** 止蝕 text, same everywhere: $x（−0.9% · 約蝕 $2,616.90）（槓桿） */
  function withStopLoss(g, loss) {
    if (!g) return g;
    g.lossUsd = loss != null && isFinite(loss) ? loss : null;
    g.stop = `${price(g.stopPx)}（−${fmtSl(g.sl)}%` + (g.lossUsd != null ? ` · 約蝕 ${money2(Math.abs(Math.min(0, g.lossUsd)))}` : "") + "）" + (g.levStopAdj ? "（槓桿）" : g.momentum ? `· 到 +${g.tp}% 後止蝕升返成本` : "");
    return g;
  }
  const STOP_HIT_TXT = "已到止蝕 · 宜平倉";
  function exitGuideCopyPlan(plan, entryPx, markPx) {
    if (!plan || !(entryPx > 0)) return null;
    if (plan.momentum) return momentumGuideCopy(plan, entryPx, markPx);
    const tp = plan.tp, sl = plan.sl;
    const { targetPx, stopPx } = exitLevels(plan, entryPx);
    const mark = markPx != null && markPx > 0 ? markPx : null;
    const reached = mark != null && mark >= targetPx * 0.995;
    const near = mark != null && !reached && mark >= targetPx * 0.97;
    let main;
    if (reached) {
      main = `已到目標 · ${price(targetPx)}（+${tp}%）可考慮放`;
    } else if (near) {
      main = `接近 · ${price(targetPx)}（+${tp}%）可考慮放`;
    } else {
      main = `${price(targetPx)}（+${tp}%）可考慮放`;
    }
    const whenClean = String(plan.whenText || "").replace(/^約\s*/, "").replace(/\s*再睇$/, "");
    const hold = reached
      ? (plan.pastReview ? "已過檢視時間 · 宜決定賣定留" : `到目標可減倉；否則持有至 ${whenClean || plan.whenText}`)
      : (plan.pastReview
        ? `未到目標 · 已過檢視時間，宜決定賣定留定再 hold`
        : `${whenClean || plan.whenText} 再決定（而家未到目標）`);
    const stop = `${price(stopPx)}（−${sl}%）· 紙上參考`;
    const untilText = plan.pastReview ? "宜決定" : (whenClean ? "揸到 " + whenClean : "");
    return { main, hold, stop, basePx: entryPx, targetPx, stopPx, reached, pastReview: plan.pastReview, tp, sl, untilText };
  }

  /** 急升倉 exit copy: ladder + stop + hard time stop. */
  function momentumGuideCopy(plan, entryPx, markPx) {
    const L = exitLevels(plan, entryPx);
    const t1 = L.targetPx, t2 = L.target2Px, stopPx = L.stopPx;
    const mark = markPx != null && markPx > 0 ? markPx : null;
    const hit2 = mark != null && mark >= t2 * 0.995;
    const hit1 = mark != null && !hit2 && mark >= t1 * 0.995;
    let main;
    if (hit2) main = `已到 +${plan.tp2}% · ${price(t2)} 可清倉`;
    else if (hit1) main = `已到 +${plan.tp}% · 放一半；餘下等 ${price(t2)}（+${plan.tp2}%）`;
    else main = `${price(t1)}（+${plan.tp}%）放一半 → ${price(t2)}（+${plan.tp2}%）清`;
    const recheck = plan.reviewAt ? frTime(plan.reviewAt) : `${plan.reviewH}h 後`;
    const last = plan.secondAt ? frTime(plan.secondAt) : `${plan.secondH}h 內`;
    const hold = plan.pastReview
      ? `已過 ${plan.secondH}h · 急升倉唔好留，宜清`
      : (plan.pastRecheck
        ? `已過 ${plan.reviewH}h 檢查點 · 最遲 ${last} 走`
        : `${recheck} 再睇（${plan.reviewH}h）· 最遲 ${last} 走`);
    const stop = `${price(stopPx)}（−${plan.sl}%）· 到 +${plan.tp}% 後止蝕升返成本`;
    return { main, hold, stop, basePx: entryPx, targetPx: t1, target2Px: t2, stopPx, reached: hit1 || hit2, pastReview: plan.pastReview, tp: plan.tp, sl: plan.sl, momentum: true, untilText: plan.pastReview ? "宜清" : "最遲 " + last };
  }

  /** One short line: 🎯 target(s) · 止蝕 · 最遲 / 揸到. Shared by order sheet + holdings. */
  function exitOneLine(g) {
    if (!g) return "";
    const tgt = g.momentum && g.target2Px ? `${price(g.targetPx)}／${price(g.target2Px)}` : price(g.targetPx);
    const when = g.untilText ? ` · ${g.untilText}` : "";
    return `🎯 ${tgt} · 止蝕 ${price(g.stopPx)}${g.levStopAdj ? "（槓桿）" : ""}${when}`;
  }
  function paintTradeExitGuide(guide) {
    const box = $("tradeExitGuide");
    if (!box) return;
    if (!guide) { box.hidden = true; box.classList.remove("teg-due"); const m = $("tradeExitMain"); if (m) m.textContent = ""; return; }
    box.hidden = false;
    box.classList.toggle("teg-due", !!guide.pastReview || !!guide.reached);
    box.classList.toggle("teg-momentum", !!guide.momentum);
    box.dataset.basis = String(guide.basePx); box.dataset.target = String(guide.targetPx); box.dataset.stop = String(guide.stopPx);
    box.dataset.loss = guide.lossUsd != null ? String(guide.lossUsd) : "";
    // Visible line: 🎯 … · 最遲 …  /  止蝕 $x（−0.9% · 約蝕 $y）（槓桿） — same stop text as 孤注一擲 sheet + 詳情.
    const tgt = guide.momentum && guide.target2Px ? `${price(guide.targetPx)}／${price(guide.target2Px)}` : price(guide.targetPx);
    const m = $("tradeExitMain"); if (m) m.textContent = `🎯 ${tgt}` + (guide.untilText ? ` · ${guide.untilText}` : "") + `\n止蝕 ${guide.stop}`;
    const h = $("tradeExitHold"); if (h) h.textContent = guide.hold;
    const s2 = $("tradeExitStop"); if (s2) s2.textContent = guide.stop;
  }

  function posExitGuideEl(pos, markPx) {
    const plan = exitPlanForPosition(pos);
    const entryPx = posBasisPx(pos);
    const g = withStopLoss(exitGuideCopy(plan, entryPx, markPx, pos.leverage), null);
    if (g) withStopLoss(g, stopLossUsd(pos.leverage > 1 || pos.margin != null ? "lev" : "spot", { pos }, g.stopPx));
    if (!g) return exitHintRow(plan, { className: "sc-exit sc-exit-pos" });
    return el("div", { class: "pos-exit-guide", "data-sym": pos.symbol || "", "data-basis": String(g.basePx), "data-target": String(g.targetPx), "data-stop": String(g.stopPx), "data-tp": String(g.tp), "data-sl": String(g.sl) },
      el("div", { class: "peg-kicker", text: "幾時可以放" }),
      el("div", { class: "peg-row" },
        el("span", { class: "peg-lab", text: "目標價" }),
        el("span", { class: "peg-main", text: g.main })),
      el("div", { class: "peg-row" },
        el("span", { class: "peg-lab", text: "揸到" }),
        el("span", { class: "peg-hold", text: g.hold })),
      el("div", { class: "peg-row" },
        el("span", { class: "peg-lab", text: "止蝕" }),
        el("span", { class: "peg-stop", text: g.stop }))
    );
  }

  function srcBadge(chain, pair, li) {
    const label = (window.MCE.live && window.MCE.live.sourceLabel(chain, pair))
      || (li && li.source === "binance" ? "Binance 即時" : li && li.source === "dex" ? "Dex 即時" : "");
    if (!label) return "";
    const clsName = label.startsWith("Binance") ? "src-bn" : "src-dex";
    return el("span", { class: "src-badge " + clsName, text: label });
  }
  /** Rough price impact: ~ k * sqrt(notional/liquidity), capped. Fee is separate. */
  function estimateImpact(notional, liqUsd) {
    if (!(notional > 0) || !(liqUsd > 0)) return { impactPct: 0, note: "流動性未知，未計衝擊" };
    const ratio = notional / liqUsd;
    const impactPct = Math.min(35, 100 * 0.5 * Math.sqrt(ratio)); // 50% of pool ≈ ~35% cap
    return { impactPct, note: `估算衝擊約 ${impactPct.toFixed(1)}%（名義 ${money2(notional)} vs 流動性 ${money2(liqUsd)}）` };
  }
  function totalCostPct(notional, liqUsd, feePct) {
    const { impactPct, note } = estimateImpact(notional, liqUsd);
    return { feePct, impactPct, totalPct: feePct + impactPct, note };
  }

  /** Human batch label — never show raw batch-00x to users. */
  function batchLabel(batch, { latestId } = {}) {
    if (!batch) return "—";
    const id = typeof batch === "string" ? batch : batch.id;
    const created = typeof batch === "string" ? null : (batch.created_at || null);
    const latest = latestId || (S.picks?.batches?.length ? S.picks.batches[S.picks.batches.length - 1].id : null);
    if (id && latest && id === latest) return "今批";
    if (created) {
      try {
        const d = new Date(created);
        if (!isNaN(d)) {
          const md = `${d.getMonth() + 1}月${d.getDate()}日`;
          const hm = d.toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit", hour12: false });
          return `${md} ${hm}`;
        }
      } catch (_) {}
    }
    // Fallback: ordinal without "batch-" prefix
    const m = String(id || "").match(/(\d+)$/);
    return m ? `第 ${parseInt(m[1], 10)} 批` : "較早批次";
  }

  async function fetchPairs(list, force = false) {
    const byChain = new Map();
    for (const { chain, pair } of list) {
      if (!chain || !pair || chain === "binance") continue;
      if (!byChain.has(chain)) byChain.set(chain, new Set());
      byChain.get(chain).add(pair);
    }
    const jobs = [];
    for (const [chain, set] of byChain) {
      const a = [...set];
      for (let i = 0; i < a.length; i += 30)
        jobs.push(cachedJson(`${API}/latest/dex/pairs/${encodeURIComponent(chain)}/${a.slice(i, i + 30).join(",")}`, { force }).then((r) => ({ chain, asked: a.slice(i, i + 30), r })));
    }
    for (const res of await Promise.allSettled(jobs)) {
      if (res.status !== "fulfilled") continue;
      const { chain, asked, r } = res.value;
      const got = new Map((r.data.pairs || []).map((p) => [p.pairAddress, p]));
      for (const a of asked) S.live.set(chain + ":" + a, got.get(a) || null);
    }
  }
  function liveInfo(chain, pair) {
    const mark = window.MCE.live && window.MCE.live.getMark(chain, pair);
    if (mark && mark.dead) return { state: "dead", price: 0, liq: mark.liq || 0, p: mark.p, source: mark.source };
    if (mark && mark.price > 0) {
      const dexLiq = S.live.get(chain + ":" + pair)?.liquidity?.usd ?? 0;
      const liq = mark.source === "binance" ? (mark.liq || 1e12) : (mark.liq ?? dexLiq);
      return { state: "live", price: mark.price, liq, p: mark.p || S.live.get(chain + ":" + pair), source: mark.source, flash: mark._flash };
    }
    if (chain === "binance") {
      const row = window.MCE.live && window.MCE.live.board && window.MCE.live.board.get(pair);
      if (row && row.price > 0) return { state: "live", price: row.price, liq: 1e12, source: "binance" };
      return { state: "unknown" };
    }
    const k = chain + ":" + pair;
    if (!S.live.has(k)) return { state: "unknown" };
    const p = S.live.get(k);
    const liq = p?.liquidity?.usd ?? 0;
    if (!p || liq < DEAD_LIQ || !p.priceUsd) return { state: "dead", price: 0, liq, p };
    return { state: "live", price: parseFloat(p.priceUsd), liq, p, source: "dex" };
  }
  function ingestPair(chain, pair, p) {
    S.live.set(chain + ":" + pair, p || null);
  }

  async function loadPicks(force = false) {
    try {
      if (!S.picks || force) {
        S.picks = await (await fetch("data/picks.json", { cache: "no-cache" })).json();
        try { S.outcomes = (await (await fetch("data/outcomes.json", { cache: "no-cache" })).json()).records || []; } catch { S.outcomes = []; }
      }
      const need = [];
      for (const b of S.picks.batches) {
        for (const e of b.entries) need.push({ chain: e.chain, pair: e.pair_address });
        for (const bm of Object.values(b.benchmarks || {})) need.push({ chain: bm.chain, pair: bm.pair_address });
      }
      await fetchPairs(need, force);
      renderPicks();
    } catch (e) {
      console.error(e);
      $("pickStats").textContent = "載入推薦失敗：" + e.message;
    }
  }
  /** Prefer BTC (Binance-first) then SOL for legacy Solana batches. */
  function pickBenchmark(b) {
    const bm = (b && b.benchmarks) || {};
    if (bm.BTC) return { key: "BTC", ...bm.BTC };
    if (bm.SOL) return { key: "SOL", ...bm.SOL };
    const keys = Object.keys(bm);
    if (keys.length) return { key: keys[0], ...bm[keys[0]] };
    return null;
  }
  function evalEntry(b, e) {
    const li = liveInfo(e.chain, e.pair_address);
    const bm = pickBenchmark(b);
    const bl = bm ? liveInfo(bm.chain, bm.pair_address) : { state: "unknown" };
    const ret = li.state === "dead" ? -100 : li.state === "live" ? (li.price / e.entry_price_usd - 1) * 100 : null;
    const bmRet = bm && bl.state === "live" ? (bl.price / bm.price_usd - 1) * 100 : null;
    const liqDrop = li.state === "live" && e.entry_snapshot?.liquidity_usd ? li.liq / e.entry_snapshot.liquidity_usd : null;
    // solRet kept as alias for older call sites / outcomes titles
    return { e, b, li, ret, bm, bmKey: bm ? bm.key : "BTC", bmRet, solRet: bmRet, excess: ret != null && bmRet != null ? ret - bmRet : null, liqDrop };
  }
  function horizonCell(x) {
    return el("td", {}, (x.e.horizons_h || [24, 72, 168]).map((h) => {
      const rec = S.outcomes.find((o) => o.pick_id === x.e.id && o.horizon_h === h);
      const label = h === 168 ? "7日" : h + "h";
      if (rec) return el("span", { class: "pill " + (rec.status === "dead" ? "dead" : rec.return_pct >= 0 ? "good" : "bad"), title: `快照 ${localTime(rec.observed_at)} · 基準 ${pct(rec.btc_return_pct != null ? rec.btc_return_pct : rec.sol_return_pct)}` }, `${label} ${pct(rec.return_pct)}`);
      const left = h - hoursSince(x.e.created_at);
      if (left > 0) return el("span", { class: "pill", title: "24h/7d 結果尚未到期" }, `${label} 尚未到期`);
      return el("span", { class: "pill", title: "期限已到但未跑 snapshot_outcomes.py" }, `${label} 待快照`);
    }));
  }
  function retCell(x) {
    if (x.li.state === "dead") return el("td", { class: "num" }, el("span", { class: "pill dead", title: "交易對消失或流動性 < $1k" }, "已死／Rug −100%"));
    return el("td", { class: "num " + cls(x.ret) }, el("b", { text: pct(x.ret) }),
      x.liqDrop != null && x.liqDrop < 0.2 ? el("span", { class: "pill bad", title: "流動性跌超過 80%" }, "流動性 −" + Math.round((1 - x.liqDrop) * 100) + "%") : "");
  }
  function tokenCell(e) {
    return el("td", {}, el("div", { class: "tok" }, el("div", {}, el("div", { class: "nm", text: e.name }), el("div", { class: "sy", text: `$${e.symbol} · ${e.chain}` }))));
  }

  const ANGLE_LABEL = {
    accumulation: "靜吸",
    rotation: "輪動",
    compression: "壓縮",
    mean_reversion: "回彈",
    higher_lows: "結構",
    relative: "相對",
    already_up: "勿追",
  };

  function renderSimpleCards(buys) {
    const box = $("simpleCards"); if (!box) return;
    box.textContent = "";
    const bn = (buys || []).filter((x) => x.e && x.e.chain === "binance");
    const top = (bn.length ? bn : buys || []).slice(0, 6);
    if (!top.length) { box.append(el("p", { class: "muted", text: "計緊多角度盤…稍等" })); return; }
    const liveApi = window.MCE.live;
    top.forEach((x, i) => {
      const tip = x.e.tip || (x.e.rationale || "").split("（")[0].slice(0, 72) || "多角度盤 · 唔係追 24h 升幅";
      const livePx = x.li && x.li.state === "live" ? x.li.price : (x.e.entry_price_usd || null);
      const chg = x.e.entry_snapshot?.chg24h_pct;
      const angle = x.e.angle || x.e.entry_snapshot?.angle || "";
      const scInfo = {
        chain: x.e.chain, pair: x.e.pair_address, token: x.e.token_address,
        symbol: x.e.symbol, name: x.e.name, price: livePx,
        source: x.e.chain === "binance" ? "binance" : undefined,
        created_at: x.e.created_at, entry_price_usd: x.e.entry_price_usd,
        entry_snapshot: x.e.entry_snapshot,
        exitRegime: x.e.exitRegime, suggested_exit_h: x.e.suggested_exit_h,
        suggested_second_h: x.e.suggested_second_h, take_profit_pct: x.e.take_profit_pct,
        stop_loss_pct: x.e.stop_loss_pct, flags: x.e.flags, size: x.e.size,
      };
      const logo = liveApi && liveApi.coinLogoEl
        ? liveApi.coinLogoEl(x.e.symbol, "coin-logo", 44)
        : el("span", { class: "coin-logo letter", text: String(x.e.symbol || "?").slice(0, 2) });
      const details = el("details", { class: "sc-details" },
        el("summary", { text: "詳情" }),
        el("div", { class: "sc-detail-body muted" },
          x.e.chain === "binance" ? shillLineEl(x.e.pair_address || x.e.symbol) : null,
          el("div", { text: tip }),
          el("div", { text: "角度：" + (ANGLE_LABEL[angle] || angle || "setup") }),
          el("div", { text: "推薦價 " + price(x.e.entry_price_usd) + (chg != null ? " · 當時 24h " + pct(chg) : "") }),
          el("div", { text: (x.e.rationale || "").slice(0, 160) })
        )
      );
      box.append(el("article", { class: "simple-card anim-in", "data-angle": angle || "", style: "--i:" + i },
        el("div", { class: "sc-top" },
          logo,
          el("div", { class: "sc-id" },
            el("div", { class: "nm", text: x.e.symbol }),
            x.e.chain === "binance" ? shillFlagEl(x.e.pair_address || x.e.symbol) : null
          ),
          el("div", { class: "sc-px" },
            el("div", { class: "num live-px", "data-bn-price": x.e.pair_address || "", text: livePx != null ? price(livePx) : "…" }),
            (() => { const br = window.MCE.live && window.MCE.live.board && window.MCE.live.board.get(x.e.pair_address); const c = br && br.chg24 != null ? br.chg24 : chg;
              return el("div", { class: "sc-ret num " + cls(c), "data-bn-chg": x.e.pair_address || "", text: c != null ? pct(c) : "—" }); })()
          )
        ),
        exitHintRow(x.e.chain === "binance" && livePx > 0 ? wouldBuyPlan(scInfo) : exitPlanFromEntry(x.e), x.e.chain === "binance" && livePx > 0 ? { basePx: livePx, pair: x.e.pair_address } : {}),
        details,
        el("div", { class: "sc-actions" },
          el("button", { type: "button", class: "allin-btn", onclick: () => openAllinFlow(scInfo) }, "孤注"),
          el("button", { class: "primary", onclick: () => openBuy(scInfo) }, "買")
        )
      ));
    }); paintShillSoon();
  }

  const FAKE_STAKE = 1000; // equal-weight paper stake across latest buys

  function followHorizonState(createdAt) {
    const age = hoursSince(createdAt);
    const left = 24 - age;
    if (age >= 24) return { kind: "full", age, left: 0, label: "已滿 24h" };
    return { kind: "mtm", age, left, label: `未滿 24h · 暫計（仲差 ${Math.max(0, left).toFixed(1)}h）` };
  }

  /** Price cell for a follow-report row: sealed → 入 $x → 24h $y (static); live → ticking mark. */
  function frPxCell(r, e) {
    const entry = el("div", { class: "muted tiny", text: "入 " + price(e.entry_price_usd) });
    if (r.sealed && r.rec) {
      const exitPx = r.rec.status === "dead" ? null : r.rec.price_usd;
      const sealIso = r.rec.due_at || r.rec.observed_at;
      const sealT = sealIso ? "封盤 " + frTime(sealIso) + (r.rec.price_source === "kline_1m_due" ? "（到期 1m K 線收市價）" : "") : "24h 已封盤";
      return el("div", { class: "fr-px", title: sealT },
        entry,
        exitPx != null
          ? el("div", { class: "num fr-exit " + cls(r.ret), text: "24h " + price(exitPx) })
          : el("div", { class: "muted tiny fr-exit", text: r.rec.status === "dead" ? "已死 · " + sealT : sealT })
      );
    }
    // Live: ticking price via data-bn-price; fall back to last known mark instead of a bare "…"
    const mark = r.now != null ? r.now
      : (r.ret != null && e.entry_price_usd ? e.entry_price_usd * (1 + r.ret / 100) : null);
    return el("div", { class: "fr-px" },
      entry,
      el("div", { class: "num live-px", "data-bn-price": e.pair_address, text: mark != null ? price(mark) : "報價連接中" })
    );
  }

  /** Prominent paper result: if you followed latest-batch buys equally. */
  function renderFollowReport(buys) {
    const panel = $("followReportPanel");
    const rowsEl = $("followReportRows");
    const pctEl = $("followReportPct");
    const pnlEl = $("followReportPnl");
    const stEl = $("followReportStatus");
    const metaEl = $("followReportMeta");
    if (!panel || !rowsEl || !pctEl) return;
    const list = (buys || []).filter((x) => x && x.e && x.e.type === "buy");
    S._followBuys = list;
    rowsEl.textContent = "";
    if (!list.length) {
      pctEl.textContent = "—";
      pctEl.className = "fr-pct";
      if (pnlEl) { pnlEl.textContent = "假錢 —"; pnlEl.className = "fr-pnl"; }
      if (stEl) stEl.innerHTML = '<span class="fr-chip fr-chip-muted">未有今批買入推薦</span>';
      if (metaEl) metaEl.textContent = "";
      return;
    }
    const created = list[0].e.created_at;
    const hz = followHorizonState(created);
    const withRet = list.map((x) => {
      const li = liveInfo(x.e.chain, x.e.pair_address);
      const ret = li.state === "dead" ? -100
        : li.state === "live" ? (li.price / x.e.entry_price_usd - 1) * 100
        : (x.ret != null ? x.ret : null);
      // Prefer sealed 24h outcome when due
      const rec = S.outcomes.find((o) => o.pick_id === x.e.id && o.horizon_h === 24);
      const sealed = hz.kind === "full" && rec ? rec.return_pct : null;
      const use = sealed != null ? sealed : ret;
      return { x, li, ret: use, sealed: sealed != null, rec: sealed != null ? rec : null, entry: x.e.entry_price_usd, now: li.state === "live" ? li.price : null };
    });
    const known = withRet.filter((r) => r.ret != null);
    const avgRet = known.length ? known.reduce((a, b) => a + b.ret, 0) / known.length : null;
    const wins = known.filter((r) => r.ret > 0).length;
    const per = FAKE_STAKE / list.length;
    const pnl = known.length ? known.reduce((a, b) => a + per * (b.ret / 100), 0) : null;
    const sealedAll = withRet.every((r) => r.sealed);
    if (stEl) {
      const chips = [];
      if (hz.kind === "full") {
        chips.push(`<span class="fr-chip fr-chip-full">${hz.label}</span>`);
      } else {
        chips.push(`<span class="fr-chip fr-chip-mtm">${hz.label}</span>`);
      }
      if (sealedAll) chips.push(`<span class="fr-chip fr-chip-lock">已鎖 24h 快照</span>`);
      else if (hz.kind === "full") chips.push(`<span class="fr-chip fr-chip-live">即時價暫代（待快照）</span>`);
      else chips.push(`<span class="fr-chip fr-chip-live">即時對盤</span>`);
      chips.push(`<span class="fr-chip fr-chip-win">勝率 ${known.length ? wins + "/" + known.length : "—"}</span>`);
      stEl.innerHTML = chips.join("");
    }
    if (metaEl) {
      const bid = list[0].b && list[0].b.id ? list[0].b.id : "";
      const sealAt = sealedAll ? withRet.map((r) => r.rec && (r.rec.due_at || r.rec.observed_at)).filter(Boolean).sort().pop() : null;
      const head = sealedAll && bid ? bid : batchLabel(list[0].b);
      metaEl.textContent = `等權各 $${(per).toFixed(0)} · 總假本 $${FAKE_STAKE} · ${head} · 買入時間 ${frTime(created)}`
        + (sealAt ? ` · 封盤 ${frTime(sealAt)}` : "");
    }
    const kickEl = $("followReportKicker");
    if (kickEl) {
      const bid = list[0].b && list[0].b.id ? list[0].b.id : "";
      kickEl.textContent = sealedAll && bid ? `若跟晒 ${bid} 買 · 24h 結果` : "若跟晒今批買 · 24h";
    }
    if (avgRet == null) {
      pctEl.textContent = "…";
      pctEl.className = "fr-pct";
      if (pnlEl) { pnlEl.textContent = "報價連接中"; pnlEl.className = "fr-pnl"; }
    } else {
      pctEl.textContent = (avgRet >= 0 ? "+" : "") + avgRet.toFixed(2) + "%";
      pctEl.className = "fr-pct " + cls(avgRet);
      if (pnlEl) {
        // Verb carries the sign: 賺 $X / 蝕 $X (no "-$" after 蝕)
        pnlEl.textContent = (pnl >= 0 ? "賺 " : "蝕 ") + "$" + Math.abs(pnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        pnlEl.className = "fr-pnl " + cls(pnl);
      }
    }
    panel.classList.toggle("fr-pos", avgRet != null && avgRet > 0);
    panel.classList.toggle("fr-neg", avgRet != null && avgRet < 0);
    const liveApi = window.MCE.live;
    for (const r of withRet) {
      const e = r.x.e;
      const logo = liveApi && liveApi.coinLogoEl ? liveApi.coinLogoEl(e.symbol, "coin-logo", 28) : "";
      const angle = e.angle || e.entry_snapshot?.angle || "";
      rowsEl.append(el("div", { class: "fr-row", "data-fr-pair": e.pair_address, "data-fr-entry": String(e.entry_price_usd) },
        logo,
        el("div", { class: "fr-id" },
          el("div", { class: "nm", text: e.symbol }),
          el("div", { class: "sy" },
            el("span", { class: "angle-pill", text: ANGLE_LABEL[angle] || "留意盤" }),
            r.sealed ? el("span", { class: "pill", text: "24h鎖" }) : ""
          )
        ),
        frPxCell(r, e),
        el("div", { class: "fr-ret-wrap" },
          el("div", { class: "fr-ret num " + cls(r.ret), "data-fr-ret": e.pair_address, text: r.ret == null ? "…" : pct(r.ret) }),
          r.sealed && r.rec && r.rec.exit_reason && r.rec.exit_reason !== "hold_horizon" && r.rec.exit_reason !== "none"
            ? el("div", { class: "tiny muted", text:
                (r.rec.exit_reason === "stop" ? "止蝕" : r.rec.exit_reason === "take_profit" ? "止賺" : r.rec.exit_reason)
                + (r.rec.return_pct_eod != null && Math.abs(r.rec.return_pct_eod - r.ret) > 0.05
                  ? ` · EOD ${pct(r.rec.return_pct_eod)}` : "")
              })
            : (e.sell_by || e.stop_loss_pct != null
              ? el("div", { class: "tiny muted", text:
                  (e.take_profit_pct != null ? `止賺 +${e.take_profit_pct}%` : "")
                  + (e.stop_loss_pct != null ? ` · 止蝕 −${e.stop_loss_pct}%` : "")
                  + (e.sell_by ? ` · 最遲 ${frTime(e.sell_by)}` : "")
                })
              : "")
        )
      ));
    }
  }

  function refreshFollowReportLive() {
    const list = S._followBuys;
    if (!list || !list.length) return;
    // Recompute from latest marks without full DOM rebuild of cards
    renderFollowReport(list.map((x) => evalEntry(x.b, x.e)));
  }

  function renderChaseList(chasing, scored) {
    const box = $("chaseList"); if (!box) return;
    box.textContent = "";
    // Build mirror: 24h pumps + any scored with big 7d / precursor echo
    const bySym = new Map();
    for (const r of (chasing || [])) bySym.set(r.symbol, { ...r, badge: "pump" });
    for (const r of (scored || [])) {
      const chg = r.chg24 || 0;
      const ret7 = r.ret7 || 0;
      const big7 = ret7 >= 12;
      const pump = chg >= 6 || r.alreadyUp || r.extended;
      if (!pump && !big7) continue;
      const prev = bySym.get(r.symbol) || { ...r };
      bySym.set(r.symbol, {
        ...prev, ...r,
        precursorEcho: r.precursorEcho || prev.precursorEcho || 0,
        ret7: ret7 || prev.ret7,
        badge: pump ? "pump" : "week",
      });
    }
    // Cross-check paper batch + live setups
    const setupSyms = new Set();
    const avoidSyms = new Set();
    if (S.picks && S.picks.batches && S.picks.batches.length) {
      const latest = S.picks.batches[S.picks.batches.length - 1];
      for (const e of latest.entries || []) {
        const sym = (e.pair_address || "").toUpperCase();
        if (e.type === "buy") setupSyms.add(sym);
        if (e.type === "avoid") avoidSyms.add(sym);
      }
    }
    const liveSetups = (window.MCE.live && window.MCE.live._lastSetupPicks) || [];
    for (const p of liveSetups) setupSyms.add((p.symbol || "").toUpperCase());

    let rows = [...bySym.values()].sort((a, b) => (b.chg24 || 0) - (a.chg24 || 0));
    rows = rows.slice(0, 8);
    // Red-tape day fallback: still show relative strongest + paper avoids so panel is never empty
    if (!rows.length && window.MCE.live) {
      const board = (window.MCE.live.getBoardRows && window.MCE.live.getBoardRows()) || [];
      rows = board.slice().filter((r) => r.price > 0)
        .sort((a, b) => (b.chg24 || 0) - (a.chg24 || 0))
        .slice(0, 6)
        .map((r) => ({ ...r, badge: "rel", soft: true }));
    }
    if (S.picks && S.picks.batches && S.picks.batches.length) {
      const latest = S.picks.batches[S.picks.batches.length - 1];
      for (const e of (latest.entries || []).filter((x) => x.type === "avoid")) {
        const sym = (e.pair_address || "").toUpperCase();
        if (rows.some((r) => (r.symbol || "").toUpperCase() === sym)) continue;
        const li = liveInfo(e.chain, e.pair_address);
        const chg = e.entry_snapshot?.chg24h_pct;
        const nowChg = null;
        rows.push({
          symbol: sym, base: e.symbol, price: li.state === "live" ? li.price : e.entry_price_usd,
          chg24: chg != null ? chg : 0, badge: "avoid_row", fromAvoid: true,
        });
      }
      rows = rows.slice(0, 8);
    }
    if (!rows.length) {
      box.append(el("p", { class: "muted tiny", text: "暫時冇極端急升對照（大盤偏弱時會顯示相對強）。" }));
      return;
    }
    const liveApi = window.MCE.live;
    for (const r of rows) {
      const base = r.base || (r.symbol || "").replace(/USDT$/, "");
      const sym = (r.symbol || "").toUpperCase();
      const logo = liveApi && liveApi.coinLogoEl ? liveApi.coinLogoEl(base, "coin-logo", 28) : "";
      const badges = [];
      if (r.fromAvoid || avoidSyms.has(sym)) badges.push(el("span", { class: "pump-badge avoid", text: "今批避過" }));
      if (r.soft || r.badge === "rel") badges.push(el("span", { class: "pump-badge soft", text: "相對強·對照" }));
      else if (gbChaseNow.has(sym) || gbPumpNow.has(sym)) badges.push(el("span", { class: "gb-buytag", text: gbPumpNow.has(sym) ? "🔥 可追" : "🚀 續升買" }));
      else if ((r.chg24 || 0) >= 5 || r.alreadyUp) badges.push(el("span", { class: "pump-badge hot", text: "已急升·未夠 🚀" }));
      else badges.push(el("span", { class: "pump-badge soft", text: "對照·勿追" }));
      if (setupSyms.has(sym)) badges.push(el("span", { class: "pump-badge echo", text: "前兆有影" }));
      else if ((r.precursorEcho || 0) > 0) badges.push(el("span", { class: "pump-badge soft", text: "週內有前兆型態" }));
      const sub = [];
      if (r.ret7 != null && Math.abs(r.ret7) >= 5) sub.push("7日 " + pct(r.ret7));
      if ((r.precursorEcho || 0) > 0) sub.push("前兆×" + r.precursorEcho);
      box.append(el("div", { class: "chase-row" },
        logo,
        el("div", { class: "fr-id", style: "flex:1;min-width:0" },
          el("div", { class: "nm", text: base }),
          el("div", { class: "pump-badges" }, ...badges),
          sub.length ? el("div", { class: "muted tiny", text: sub.join(" · ") }) : ""
        ),
        el("span", { class: "num " + cls(r.chg24), "data-bn-chg": r.symbol, text: pct(r.chg24) })
      ));
    }
  }

  /** Market-regime gate: BTC 24h < -2% or <30% of board green => 市況弱·細注／觀望. */
  function renderRegimeBanner() {
    const box = $("regimeBanner"); if (!box || !window.MCE.live) return;
    const rows = (window.MCE.live.getBoardRows ? window.MCE.live.getBoardRows() : []).filter((r) => r.price > 0);
    if (!rows.length) { box.hidden = true; return; }
    const btc = rows.find((r) => (r.symbol || "").toUpperCase() === "BTCUSDT");
    const btc24 = btc ? (btc.chg24 || 0) : 0;
    const breadth = rows.filter((r) => (r.chg24 || 0) > 0).length / rows.length;
    const weak = btc24 < -2 || breadth < 0.3;
    box.hidden = !weak;
    if (!weak) return;
    box.textContent = "";
    box.append(
      el("strong", { text: "市況弱 · 細注／觀望" }),
      el("span", { class: "tiny", text: `BTC 24h ${pct(btc24)} · 只有 ${Math.round(breadth * 100)}% 幣升 · 跟買建議半注或者唔落，優先揀跌得少過 BTC 嘅` })
    );
  }

  /** Live multi-angle setup picks (≥6) — NOT 24h gainer rank. */
  async function loadLiveBnPicks(force) {
    if (!window.MCE.live) return [];
    await window.MCE.live.ensureBoard(!!force);
    const meta = $("setupMeta");
    if (meta) meta.textContent = "分析緊 1d／1h 盤…";
    let result;
    try {
      result = await window.MCE.live.computeSetupPicks({ force: !!force, limitSymbols: 36 });
    } catch (e) {
      console.error(e);
      if (meta) meta.textContent = "分析失敗，改用存檔推薦";
      return [];
    }
    const picks = result.picks || [];
    const chasing = result.chasing || [];
    if (window.MCE.live) window.MCE.live._lastSetupPicks = picks;
    renderRegimeBanner();
    renderChaseList(chasing, result.all || []);
    renderHotBuysFromBn(picks); // full-mode list shows setups too
    if (meta) {
      const angles = [...new Set(picks.map((p) => p.angle).filter(Boolean))];
      meta.textContent = picks.length
        ? `多角度 · ${picks.length} 隻 · ${angles.map((a) => ANGLE_LABEL[a] || a).join("／")} · 唔係 24h 升幅榜`
        : "未搵到足夠留意盤";
    }
    if (picks.length >= 4) {
      const liveWeak = !!(result.regime && result.regime.weak) || picks.some((p) => p.size === "half");
      try { if (window.MCE.live) window.MCE.live._lastSetupCache = result; } catch (_) {}
      // Prefer fixed batch created_at when symbol is in latest batch; else freeze first-sight meta.
      const latest = S.picks && S.picks.batches && S.picks.batches[S.picks.batches.length - 1];
      const batchBySym = new Map();
      if (latest) {
        for (const e of latest.entries || []) {
          if (e.type === "buy" && e.symbol) batchBySym.set(String(e.symbol).toUpperCase(), e);
        }
      }
      const synth = picks.slice(0, 6).map((r) => {
        const half = liveWeak || r.size === "half";
        const be = batchBySym.get(String(r.base || "").toUpperCase());
        const meta = be && be.created_at
          ? {
              created_at: be.created_at,
              exitRegime: (be.flags || []).includes("regime:weak") || be.suggested_exit_h === 12 ? "weak" : (be.exitRegime || (half ? "weak" : "normal")),
              suggested_exit_h: be.suggested_exit_h != null ? be.suggested_exit_h : (half ? 12 : 24),
              suggested_second_h: be.suggested_second_h != null ? be.suggested_second_h : (half ? 24 : 72),
              take_profit_pct: be.take_profit_pct != null ? be.take_profit_pct : (half ? 5 : 8),
              stop_loss_pct: be.stop_loss_pct != null ? be.stop_loss_pct : (half ? 4 : 5),
            }
          : stablePickMeta(r.symbol || r.base, r.angle, { weakNow: half });
        const weakLocked = meta.exitRegime === "weak";
        return {
          e: {
            chain: "binance", pair_address: r.symbol, token_address: "binance:" + r.symbol,
            symbol: r.base, name: (r.base || "") + " (Binance)",
            entry_price_usd: r.price, conviction: Math.round(r.setupScore || r.score),
            model_score: Math.round(r.setupScore || r.score),
            tip: r.tip, angle: r.angle, rationale: r.tip,
            created_at: meta.created_at,
            exitRegime: meta.exitRegime,
            size: weakLocked ? "half" : (r.size || "full"),
            flags: weakLocked ? ["regime:weak", "size:half"] : [],
            suggested_exit_h: meta.suggested_exit_h,
            suggested_second_h: meta.suggested_second_h,
            take_profit_pct: meta.take_profit_pct,
            stop_loss_pct: meta.stop_loss_pct,
            entry_snapshot: {
              chg24h_pct: r.chg24, volume24h_usd: r.volQuote, high24h: r.high, low24h: r.low, angle: r.angle,
            },
          },
          li: { state: "live", price: r.price, source: "binance" },
          ret: null,
        };
      });
      renderSimpleCards(synth);
    }
    return picks;
  }

  function renderHotBuysFromBn(scored) {
    const box = $("hotBuyList"); if (!box) return;
    box.textContent = "";
    const top = (scored || []).slice(0, 8);
    if (!top.length) {
      box.append(el("p", { class: "muted", text: "計緊留意盤…" }));
      return;
    }
    const liveApi = window.MCE.live;
    for (const r of top) {
      const logo = liveApi && liveApi.coinLogoEl ? liveApi.coinLogoEl(r.base, "coin-logo", 36) : el("span", { class: "coin-logo letter", text: (r.base || "?").slice(0, 2) });
      const hotWeakNow = r.size === "half" || liveWeakNow();
      const hotMeta = stablePickMeta(r.symbol || r.base, r.angle, { weakNow: hotWeakNow });
      const hotInfo = {
        chain: "binance", pair: r.symbol, token: "binance:" + r.symbol,
        symbol: r.base, name: (r.base || "") + " (Binance)", price: r.price, source: "binance",
        created_at: hotMeta.created_at, entry_price_usd: r.price,
        exitRegime: hotMeta.exitRegime, suggested_exit_h: hotMeta.suggested_exit_h,
        suggested_second_h: hotMeta.suggested_second_h, take_profit_pct: hotMeta.take_profit_pct,
        stop_loss_pct: hotMeta.stop_loss_pct, size: hotMeta.exitRegime === "weak" ? "half" : "full",
      };
      const hotPlan = paperExitPlan({
        createdAt: hotMeta.created_at,
        weak: hotMeta.exitRegime === "weak",
        high24: r.high, entryPx: r.price,
        tpPct: hotMeta.take_profit_pct,
        slPct: hotMeta.stop_loss_pct,
        reviewH: hotMeta.suggested_exit_h,
        secondH: hotMeta.suggested_second_h,
      });
      box.append(el("div", { class: "hot-buy-row" },
        el("div", { class: "tok" },
          logo,
          el("div", {},
            el("div", { class: "nm", text: r.base }),
            el("div", { class: "sy", text: (ANGLE_LABEL[r.angle] || "留意盤") + " · " + (r.tip || "").slice(0, 36) }),
            exitHintRow(wouldBuyPlan(hotInfo), { className: "sc-exit sc-exit-hot", basePx: r.price, pair: r.symbol })
          )
        ),
        el("div", { class: "num " + ((r.chg24 || 0) > 0 ? "pos" : (r.chg24 || 0) < 0 ? "neg" : ""), "data-bn-chg": r.symbol, text: pct(r.chg24) }),
        el("div", { class: "num live-px", "data-bn-price": r.symbol, text: price(r.price) }),
        el("button", { class: "primary sm", onclick: () => openBuy(hotInfo) }, "落倉")
      ));
    }
  }


  // ===================== 急升榜 (high-risk momentum, separate from AI picks) =====================
  // 🔥 急升 = live client-side (Binance REST, backtested rule) with paper buy. ⚡ 早期訊號 = hourly GitHub
  // Actions snapshot (static JSON), watch-only 「觀察」 because it failed the 30d buy gate.
  const GB_LOG_KEY = "mce:gainer:log:v1";
  const GB_MULT_KEY = "mce:gainer:mult";
  const GB_TRIGGER_WINDOW_H = 12;
  const GB_RAW = "https://raw.githubusercontent.com/coderCyFl/meme-coin-explorer/main/";
  let gbBusy = false;
  let gbStatic = { t: 0, summary: null, latest: null };
  function gbMult() { const m = parseFloat(localStorage.getItem(GB_MULT_KEY)); return m > 0 ? m : 2; }
  function gbLoadLog() { try { const o = JSON.parse(localStorage.getItem(GB_LOG_KEY) || "[]"); return Array.isArray(o) ? o : []; } catch (_) { return []; } }
  function gbBatchId(d = new Date()) {
    const p = {};
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return `web-${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
  }
  /** ISO with +08:00 offset (Asia/Shanghai). */
  function isoSh(d = new Date()) {
    return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19) + "+08:00";
  }
  async function gbFetchJson(path) {
    for (const u of [path, GB_RAW + path]) {
      try {
        const r = await fetch(u, { cache: "no-cache" });
        if (r.ok) return await r.json();
      } catch (_) {}
    }
    return null;
  }
  async function gbLoadStatic(force) {
    if (!force && gbStatic.t && Date.now() - gbStatic.t < 5 * 60_000) return gbStatic;
    const [summary, latest] = await Promise.all([gbFetchJson("data/gainer_board/summary.json"), gbFetchJson("data/gainer_board/latest.json")]);
    gbStatic = { t: Date.now(), summary, latest };
    return gbStatic;
  }

  /** Log every board view (both tiers). First sighting within 12h = trigger/entry. Returns Map pair→trigger. */
  function gbLogSnapshot(rows) {
    const log = gbLoadLog();
    const now = Date.now();
    const batch = gbBatchId();
    const trig = new Map();
    for (const r of rows) {
      if (r.serverFlag) { trig.set(r.symbol + ":" + r.tier, r.serverFlag); continue; }
      const prev = log.slice().reverse().find((x) => x.pair === r.symbol && (x.tier || "pump") === r.tier && now - new Date(x.picked_at).getTime() < GB_TRIGGER_WINDOW_H * 3600e3);
      if (prev) { trig.set(r.symbol + ":" + r.tier, prev); continue; }
      const rec = {
        symbol: r.base, pair: r.symbol, tier: r.tier, picked_at: isoSh(new Date(now)), entry_price_usd: r.price,
        change_24h_at_pick: Math.round(r.chg24 * 100) / 100, rank_24h_at_pick: r.rank24 || null, batch, score: r.score,
        change_1h_at_pick: r.c1h != null ? Math.round(r.c1h * 100) / 100 : null,
        change_4h_at_pick: r.c4h != null ? Math.round(r.c4h * 100) / 100 : null, source: "web",
      };
      log.push(rec);
      trig.set(r.symbol + ":" + r.tier, rec);
    }
    try { localStorage.setItem(GB_LOG_KEY, JSON.stringify(log.slice(-400))); } catch (_) {}
    return trig;
  }

  /**
   * Backup when GitHub cron is late/skipped: every board scan (page load + 90 s rescans) stores a client
   * snapshot in localStorage (symbol, tier, price, 24h %, time). Server snapshots remain the official record.
   */
  const GB_CLIENT_SNAP_KEY = "mce:gainer:clientSnap:v1";
  function gbClientSnapshot(rows, early) {
    try {
      const list = JSON.parse(localStorage.getItem(GB_CLIENT_SNAP_KEY) || "[]");
      const last = list[list.length - 1];
      if (last && Date.now() - new Date(last.t).getTime() < 5 * 60e3) return list; // ≤ 1 per 5 min
      list.push({ t: isoSh(), rows: rows.map((r) => ({ pair: r.symbol, tier: r.tier, price: r.price, chg24: Math.round(r.chg24 * 100) / 100 }))
        .concat((early || []).map((e) => ({ pair: e.symbol, tier: "early2", price: e.price, chg24: Math.round(e.chg24 * 100) / 100, via: e.trigger && e.trigger.via }))) });
      const keep = list.slice(-288);
      localStorage.setItem(GB_CLIENT_SNAP_KEY, JSON.stringify(keep));
      return keep;
    } catch (_) { return []; }
  }
  function gbClientSnaps() { try { return JSON.parse(localStorage.getItem(GB_CLIENT_SNAP_KEY) || "[]"); } catch (_) { return []; } }

  function gbStateBox(kind, msg, hostId = "gainerList") {
    const box = $(hostId); if (!box) return;
    box.textContent = "";
    const kids = [el("div", { class: "gb-state-msg", text: msg })];
    if (kind === "error") kids.push(el("button", { type: "button", class: "primary sm", onclick: () => loadGainerBoard(true) }, "再試"));
    box.append(el("div", { class: "gb-state gb-" + kind }, ...kids));
  }

  const gbIsEarly = (t) => t === "early" || t === "early2";
  const gbTierIcon = (t) => (gbIsEarly(t) ? "⚡" : "🔥");

  /** Plan a 🔥 buy would lock NOW (fresh 4h/12h window) — same object the buy window uses. */
  const gbPlanNow = (X = GAINER_EXIT) => momentumExitPlan({ createdAt: new Date().toISOString(), tpPct: X.tp, tp2Pct: X.tp2, slPct: X.sl, reviewH: X.reviewH, secondH: X.secondH });
  /** exit_plan string recorded on every 🔥/🚀 paper buy (same shape as picks.json buys). */
  function gbExitPlanText(X, px) {
    const r = (x) => +Number(x).toPrecision(6);
    return `+${X.tp}% 放一半（$${r(px * (1 + X.tp / 100))}）· +${X.tp2}% 清（$${r(px * (1 + X.tp2 / 100))}）· 止蝕 −${X.sl}%（$${r(px * (1 - X.sl / 100))}）· ${X.reviewH}h 檢討 · 最遲 ${X.secondH}h 沽`;
  }

  /** One-glance alert grid: 觸發時間 · 觸發價 · 觸發後 % · 目標 · 止蝕 (目標/止蝕 = buy NOW at live price, ticks). */
  function gbAlertGrid(pair, trig, nowPx) {
    const e = trig.entry_price_usd;
    const since = nowPx > 0 && e > 0 ? (nowPx / e - 1) * 100 : null;
    const plan = gbPlanNow();
    return el("div", exitLiveAttrs(pair, plan, nowPx, { class: "gba-grid", "data-gb-levels": "banner" }),
      el("div", {}, el("span", { class: "k", text: (trig.trigger_src === "kline" ? (trig.forming ? "觸發（即時）" : "觸發（15m 線）") : trig.trigger_src === "now" ? "觸發（今個鐘）" : "觸發") + (trig.via ? " · " + ({ "15m": "15m 急拉", "1h+vol": "1h+量", start: "起步", thin: "細盤" }[trig.via] || trig.via) : "") }), el("b", { class: "num", text: frTime(trig.picked_at) })),
      el("div", {}, el("span", { class: "k", text: "觸發價" }), el("b", { class: "num", text: price(e) })),
      el("div", {}, el("span", { class: "k", text: "觸發後" }), el("b", { class: "num " + cls(since), "data-gb-since": pair, "data-gb-entry": String(e), text: pct(since) })),
      el("div", {}, el("span", { class: "k", text: "目標（而家入）" }), exitLiveNode("b", { class: "num pos" }, "{target} / {target2}", plan, nowPx)),
      el("div", {}, el("span", { class: "k", text: "止蝕" }), exitLiveNode("b", { class: "num neg" }, "{stop}", plan, nowPx)));
  }

  /** Banner = newest REAL 🔥 (rule hit) or ⚡ trigger. 候補 never appears here. */
  function renderGainerAlert(items) {
    const box = $("gainerAlert"); if (!box) return;
    box.textContent = "";
    // 🔥 surge always wins the banner (newest trigger first); ⚡ watch only when no 🔥 is live.
    const byNew = (a, b) => new Date(b.trig.picked_at) - new Date(a.trig.picked_at);
    const best = items.filter((x) => x.trig && x.tier === "pump").sort(byNew)[0]
      || items.filter((x) => x.trig && gbIsEarly(x.tier)).sort(byNew)[0];
    if (!best) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle("gba-early", gbIsEarly(best.tier));
    box.append(
      el("div", { class: "gba-head" },
        el("span", { class: "gb-risk", text: "高風險" }),
        el("strong", { text: `${gbTierIcon(best.tier)} 最新觸發 ${best.base}` }),
        el("span", { class: "gba-time muted tiny", text: gbIsEarly(best.tier) ? "觀察 · 唔係買入訊號" : "現貨 · 紙上" })),
      gbAlertGrid(best.pair, best.trig, best.price));
  }

  /** Backtest line per tier — TEST half (last 15d), plus live 4h. */
  function gbBtLine(tier) {
    const bt = gbStatic.summary && gbStatic.summary.backtest_30d && gbStatic.summary.backtest_30d.tiers && gbStatic.summary.backtest_30d.tiers[tier];
    const live = gbStatic.summary && gbStatic.summary.tiers && gbStatic.summary.tiers[tier] && gbStatic.summary.tiers[tier]["4h"];
    const parts = [];
    const te = bt && bt.test;
    if (te && te.fires) {
      parts.push(`回測（後 15 日測試）${te.fires} 次：4h 內 +20% ${te.hit20_4h_pct}% · 平均 4h ${pct(te.mean_close_4h_pct)} · 中位最大回撤 ${pct(te.median_max_drawdown_4h_pct)}`);
    } else parts.push("回測載入中…");
    parts.push(live && live.n ? `實盤 4h：${live.hit20}/${live.n} 中 +20%` : "實盤 4h：未有封盤");
    return el("p", { class: "gb-bt tiny", text: parts.join(" ‖ ") });
  }

  /** ⚡ v2 chip: backtest TEST half — median minutes earlier than 🔥 + +20%-in-4h hit (honest, from backtest_early_30d). */
  function gbEarlyChip() {
    const t = gbStatic.summary && gbStatic.summary.backtest_30d && gbStatic.summary.backtest_30d.tiers && gbStatic.summary.backtest_30d.tiers.early2;
    const c = t && t.chip;
    if (!c || c.hit20_4h_pct == null) return el("span", { class: "gb-btchip muted", text: "回測載入中" });
    const lead = c.median_lead_vs_fire_min;
    return el("span", { class: "gb-btchip gb-e2chip", "data-gb-e2chip": "1",
      title: `30日回測後半段（測試）：同一次急升，⚡ 中位數比 🔥 早 ${lead} 分鐘；4h 內 +20% 命中 ${c.hit20_4h_pct}%；平均 4h ${c.mean_close_4h_pct}%；約 ${c.fires_per_day} 次/日。過唔到買入門檻 → 只觀察。`,
      text: (lead > 0 ? `早 ${Math.round(lead)} 分鐘` : "唔早過 🔥") + ` · 中 +20% ${c.hit20_4h_pct}%` });
  }

  /** Chip beside the buy button: backtest TEST-half mean 4h close (actual number). */
  function gbBtChip(tier) {
    const t = gbStatic.summary && gbStatic.summary.backtest_30d && gbStatic.summary.backtest_30d.tiers && gbStatic.summary.backtest_30d.tiers[tier];
    const te = t && t.test;
    if (!te || te.mean_close_4h_pct == null) return el("span", { class: "gb-btchip muted", text: "回測載入中" });
    const v = te.mean_close_4h_pct;
    return el("span", { class: "gb-btchip " + cls(v), title: `30日回測後半段（測試）${te.fires} 次 · 4h 平均收市 · +20% 命中 ${te.hit20_4h_pct}%`,
      text: `回測 ${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%` });
  }

  function gbLogBought(r, info, res) {
    try {
      const log = gbLoadLog();
      const X = gbExitFor(r.tier), now = Date.now();
      log.push({ symbol: r.base, pair: r.symbol, tier: r.tier, bought: true, picked_at: isoSh(), entry_price_usd: r.price,
        change_24h_at_pick: Math.round(r.chg24 * 100) / 100, rank_24h_at_pick: r.rank24 || null, batch: gbBatchId(),
        usd: res && res.amt, mode: res && res.mode, source: "web-buy",
        take_profit_pct: X.tp, take_profit2_pct: X.tp2, stop_loss_pct: X.sl, suggested_exit_h: X.reviewH, suggested_second_h: X.secondH,
        target_price_usd: +(r.price * (1 + X.tp / 100)).toPrecision(6), stop_price_usd: +(r.price * (1 - X.sl / 100)).toPrecision(6),
        review_at: isoSh(new Date(now + X.reviewH * 3600e3)), sell_by: isoSh(new Date(now + X.secondH * 3600e3)),
        exit_plan: gbExitPlanText(X, r.price) });
      localStorage.setItem(GB_LOG_KEY, JSON.stringify(log.slice(-400)));
    } catch (_) {}
  }

  // ---------- X buzz chip (🔥 only). Site makes 0 X calls: reads data/gainer_board/x_buzz.json written by the
  // Grok Bot routine (scripts/x_buzz_write.py). Same-origin only, cache-busted, refreshed every 5 min. ----------
  const GBX_PATH = "data/gainer_board/x_buzz.json";
  const GBX_MAX_AGE = 3 * 3600e3;   // older than 3h → show nothing
  const GBX_REFRESH = 5 * 60_000;
  let gbX = { t: 0, data: null };
  const gbXOpen = new Set();
  const shHm = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
  const shDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
  async function gbLoadX(force) {
    if (!force && gbX.t && Date.now() - gbX.t < GBX_REFRESH) return gbX;
    let data = null;
    try {
      const r = await fetch(GBX_PATH + "?t=" + Date.now(), { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (j && typeof j === "object" && j.coins && typeof j.coins === "object") data = j; }
    } catch (_) {}
    gbX = { t: Date.now(), data };
    return gbX;
  }
  /** Latest usable X record for a pair, or null (missing / stale / malformed). */
  function gbXRec(sym) {
    const c = gbX.data && gbX.data.coins && gbX.data.coins[sym];
    if (!c || typeof c !== "object" || !["熱", "升溫", "冷"].includes(c.verdict)) return null;
    const t = Date.parse(c.checked_at);
    if (!(t > 0) || Date.now() - t > GBX_MAX_AGE || t - Date.now() > 10 * 60e3) return null;
    return { ...c, _t: t };
  }
  function gbXChipText(c) {
    const ratio = c.verdict === "熱" && typeof c.spike_ratio === "number" && isFinite(c.spike_ratio) && c.spike_ratio > 0 ? ` ×${c.spike_ratio.toFixed(1)}` : "";
    return `X ${c.verdict}${ratio} · ${shHm(c._t)}`;
  }
  function gbXSheet(c) {
    const box = el("div", { class: "gb-xsheet-in" });
    const meta = [];
    if (c.shill_flag) meta.push(el("span", { class: "gb-xflag", text: "🚩 X 洗版" }));
    if (Number.isInteger(c.big_accounts) && c.big_accounts > 0) meta.push(el("span", { class: "muted", text: `10萬粉+ ${c.big_accounts} 個` }));
    box.append(el("div", { class: "gb-xline" }, el("b", { text: String(c.one_line || "").slice(0, 20) }), ...meta));
    const posts = (Array.isArray(c.top_posts) ? c.top_posts : []).slice(0, 3);
    if (posts.length) box.append(el("div", { class: "gb-xposts-h tiny muted", text: "近 7 個鐘熱門帖" }));
    for (const p of posts) {
      if (!p || !/^[0-9]{5,25}$/.test(String(p.id)) || !/^[A-Za-z0-9_]{1,15}$/.test(String(p.author_username))) continue;
      const href = `https://x.com/${p.author_username}/status/${p.id}`;
      box.append(el("a", { class: "gb-xpost", href, target: "_blank", rel: "noopener noreferrer" },
        el("span", { class: "gb-xwho", text: `@${p.author_username}` + (Number(p.likes) > 0 ? ` · ♥${fmtInt ? fmtInt(p.likes) : p.likes}` : "")
          + (Date.parse(p.created_at) > 0 ? ` · ${shHm(Date.parse(p.created_at))}` : "") }),
        el("span", { class: "gb-xtxt", text: String(p.text || "").slice(0, 140) })));
    }
    return box;
  }
  /** Paint every [data-gb-x] chip + its sheet in place (no board re-render). */
  function paintXChips() {
    document.querySelectorAll("[data-gb-x]").forEach((chip) => {
      const sym = chip.dataset.gbX;
      const sheet = document.querySelector(`[data-gb-xsheet="${sym}"]`);
      const c = gbXRec(sym);
      if (!c) { chip.hidden = true; if (sheet) { sheet.hidden = true; sheet.textContent = ""; } return; }
      chip.hidden = false;
      chip.className = "gb-xchip" + (c.verdict === "熱" ? " x-hot" : c.verdict === "冷" ? " x-cold" : "");
      chip.textContent = gbXChipText(c); // shill → separate .shill-flag 「🚩 X 洗版」, not a bare 🚩 on the chip
      chip.setAttribute("aria-haspopup", "dialog");
      if (sheet) { sheet.textContent = ""; sheet.hidden = true; } // ux-fix: detail lives in the 詳情 sheet, not inline
    });
    const cap = $("gainerXCap");
    if (cap) {
      const k = gbX.data && gbX.data.cap;
      cap.hidden = !(k && k.cap_reached === true && k.date === shDay(Date.now()));
    }
    paintShillFlags();
  }
  function gbXToggle(sym) {
    const c = gbXRec(sym);
    if (!c) { paintXChips(); return; }
    if (window.MCE.market && window.MCE.market.openSheet) window.MCE.market.openSheet(`${sym.replace(/USDT$/, "")} · ${gbXChipText(c)}`, [gbXSheet(c)]);
  }

  // ---------- 🚩 X 洗版 marker (🔥/⚡ gainer cards + 今日跟買 + 每日新留意). Reuses gbX (same x_buzz.json, 0 X calls).
  // Display only: never removes or reorders. Red text 「🚩 X 洗版」 while LATEST X check (≤24h) has shill_flag. ----------
  const GBX_FLAG_MAX_AGE = 24 * 3600e3;
  const gbPairOf = (s) => { const u = String(s || "").toUpperCase(); return u ? (u.endsWith("USDT") ? u : u + "USDT") : ""; };
  function gbXShill(pair) {
    const c = gbX.data && gbX.data.coins && gbX.data.coins[pair];
    if (!c || typeof c !== "object" || c.shill_flag !== true) return null;
    const tt = Date.parse(c.checked_at);
    if (!(tt > 0) || Date.now() - tt > GBX_FLAG_MAX_AGE || tt - Date.now() > 10 * 60e3) return null;
    return { ...c, _t: tt };
  }
  function gbShillLine(c) {
    const when = (shDay(c._t) === shDay(Date.now()) ? "" : shDay(c._t).slice(5) + " ") + shHm(c._t);
    const big = Number.isInteger(c.big_accounts) && c.big_accounts > 0 ? `10萬粉+ 只得 ${c.big_accounts} 個` : "冇 10萬粉+ 大帳號";
    return `🚩 X 多數係複製貼上推廣帖 · ${big} · ${when} 查`;
  }
  function shillFlagEl(sym) {
    const pair = gbPairOf(sym);
    return el("span", { class: "shill-flag", "data-shill": pair, role: "button", tabindex: "0", hidden: true,
      onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); gbShillOpen(pair); },
      onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); gbShillOpen(pair); } } }, "🚩 X 洗版");
  }
  function shillLineEl(sym) { return el("div", { class: "shill-line", "data-shill-line": gbPairOf(sym), hidden: true }); }
  function gbShillOpen(pair) {
    const c = gbXShill(pair);
    if (!c) { paintShillFlags(); return; }
    if (window.MCE.market && window.MCE.market.openSheet)
      window.MCE.market.openSheet(`${pair.replace(/USDT$/, "")} · 🚩 X 洗版`, [el("div", { class: "shill-line", text: gbShillLine(c) })]);
  }
  function paintShillFlags() {
    document.querySelectorAll("[data-shill]").forEach((n) => { n.hidden = !gbXShill(n.dataset.shill); });
    document.querySelectorAll("[data-shill-line]").forEach((n) => {
      const c = gbXShill(n.dataset.shillLine);
      n.hidden = !c; n.textContent = c ? gbShillLine(c) : "";
    });
  }
  function paintShillSoon() {
    try { paintShillFlags(); gbLoadX(false).then(paintShillFlags).catch(() => {}); } catch (_) {}
  }

  /** Minimal card: coin · 24h % · price · 目標 · 止蝕 · 幾時放 · buy (🔥 only). Everything else in 詳情. */
  function gbCard(r, t, { buy }) {
    const liveApi = window.MCE.live;
    const X = gbExitFor(r.tier);
    const small = r.tier === "chase" && r.trigger && r.trigger.small;
    const mult = gbMult() * (small ? CHASE_SMALL_MULT : 1);
    const usd = Math.max(0, Math.min(Math.floor(P.cash), Math.round(P.cash * 0.1 * mult)));
    const fee2 = usd * (P.feePct || 0) / 100 * 2;
    const plan = gbPlanNow(X);
    const px = r.price;
    const watch = !buy; // 候補 / ⚡: not bought, no buy → no 幾時放
    const logo = liveApi && liveApi.coinLogoEl ? liveApi.coinLogoEl(r.base, "coin-logo", 36) : el("span", { class: "coin-logo letter", text: r.base.slice(0, 2) });
    const spark = liveApi && liveApi.sparkSvg ? liveApi.sparkSvg(r.spark || [], { w: 120, h: 32, up: (r.c4h || 0) >= 0, className: "spark-svg gb-spark" }) : null;
    const tags = r.tier === "cand"
      ? [el("span", { class: "gb-watch", text: "候補" })]
      : gbIsEarly(r.tier)
        ? [el("span", { class: "gb-watch", text: "⚡ 觀察" })].concat(r.thin ? [el("span", { class: "gb-cand-tag", text: "細盤" })] : [])
        : r.tier === "chase"
          ? [el("span", { class: "gb-buytag", text: "🚀 續升買" })].concat(small ? [el("span", { class: "gb-buytag soft", text: "細盤 加碼" })] : [])
          : r.tier === "pump" ? [el("span", { class: "gb-buytag", text: "🔥 可追" })] : [];
    const bnInfo = {
      chain: "binance", pair: r.symbol, token: "binance:" + r.symbol,
      symbol: r.base, name: r.base + " (Binance)", price: r.price, source: "binance",
    };
    const details = el("details", { class: "gb-details" },
      el("summary", { text: "詳情" }),
      el("div", { class: "gb-det-body" },
        spark || "",
        (r.tier === "pump" || gbIsEarly(r.tier)) ? shillLineEl(r.symbol) : null,
        el("div", { class: "pump-badges" },
          el("span", { class: "pump-badge soft gb-fh", "data-gb-fh": r.symbol, "data-gb-high": String(r.high || ""), text: `離 24h 高 ${pct(r.fromHigh)}` }),
          r.volRatio != null ? el("span", { class: "pump-badge " + (r.volRatio >= 1.5 ? "hot" : "soft"), text: `量 ×${r.volRatio.toFixed(1)}` + (r.volRatioPrev != null ? ` ← ×${r.volRatioPrev.toFixed(1)}` : "") }) : "",
          r.c1h != null ? el("span", { class: "pump-badge soft", text: `1h ${pct(r.c1h)}` }) : "",
          r.c4h != null ? el("span", { class: "pump-badge soft", text: `4h ${pct(r.c4h)}` }) : "",
          el("span", { class: "pump-badge soft", text: `成交 ${money(r.volQuote)}` }),
          r.rank24 ? el("span", { class: "pump-badge soft", text: `24h 升幅第 ${r.rank24} 名` }) : ""),
        t ? gbAlertGrid(r.symbol, t, px) : "",
        watch ? "" : el("div", exitLiveAttrs(r.symbol, plan, px, { class: "tiny muted gb-ladder", "data-gb-levels": "details" }),
          exitLiveNode("span", {}, "{target}（+{tp}%）放一半、止蝕升返成本 → {target2}（+{tp2}%）清 · {review} 再睇 · 最遲 {until} 走", plan, px)),
        buy && usd > 0 ? el("div", { class: "tiny" },
          `現貨 ${money2(usd)}：`, el("b", { class: "pos", text: `+${X.tp}% 賺 ${money2(usd * X.tp / 100 - fee2)}` }), " · ",
          el("b", { class: "pos", text: `+${X.tp2}% 賺 ${money2(usd * X.tp2 / 100 - fee2)}` }), " · ",
          el("b", { class: "neg", text: `止蝕蝕 ${money2(usd * X.sl / 100 + fee2)}` })) : "",
        r.tier === "chase" ? el("div", { class: "tiny muted", text: `🚀 續升買：24h +${10}–${30}%、離 24h 高 ≤ 5%、1h 成交 ≥ 2x 平均、1h 仲升緊 → 紙上直接跟買。` + (small ? ` 細盤（24h 成交 < $3M）注碼 ×${CHASE_SMALL_MULT}。` : "") }) : "",
        r.tier === "cand" ? el("div", { class: "tiny muted", text: "候補：近 4h 未有 🔥 急拉（1h ≥ +5% 兼量 ≥ 3x，或 15m ≥ +5%），只做觀察，冇買入掣。" }) : "",
        r.tier === "chase" ? "" : gbBtLine(r.tier === "cand" ? "pump" : r.tier),
        el("div", { class: "gb-det-actions" },
          el("button", { type: "button", class: "allin-btn sm gb-allin", onclick: () => openAllinFlow(bnInfo) }, `孤注一擲 ${r.base}`))));
    const kids = [
      el("div", { class: "gb-top" },
        logo,
        el("div", { class: "gb-id" }, el("div", { class: "nm" }, r.base, " ", ...tags),
          r.tier === "pump" ? el("button", { type: "button", class: "gb-xchip", "data-gb-x": r.symbol, hidden: true, "aria-expanded": "false", onclick: () => gbXToggle(r.symbol) }) : "",
          (r.tier === "pump" || gbIsEarly(r.tier)) ? shillFlagEl(r.symbol) : null),
        el("div", { class: "gb-px" },
          el("div", { class: "num live-px", "data-bn-price": r.symbol, text: price(px) }),
          el("div", { class: "num gb-chg " + cls(r.chg24), "data-bn-chg": r.symbol, text: pct(r.chg24) }))),
      r.tier === "pump" ? el("div", { class: "gb-xsheet", "data-gb-xsheet": r.symbol, hidden: true }) : "",
      // 幾時放 = ONE line (same shared exit formula + live price as the buy window; ticks via refreshExitChips)
      watch ? "" : el("div", exitLiveAttrs(r.symbol, plan, px, { class: "gb-min gb-exit1", "data-gb-levels": "card" }),
        exitLiveNode("span", { class: "num" }, "半 {target} · 清 {target2} · 止 {stop} · {untilS}前走", plan, px)),
    ];
    if (buy) {
      kids.push(el("div", { class: "gb-buyrow" },
        el("button", { type: "button", class: "allin-btn sm gb-allin", onclick: () => openAllinFlow(bnInfo) }, "孤注"),
        el("button", { class: "primary gb-buy", onclick: () => openBuy({
          chain: "binance", pair: r.symbol, token: "binance:" + r.symbol,
          symbol: r.base, name: r.base + " (Binance)", price: r.price, source: "binance",
          created_at: new Date().toISOString(), entry_price_usd: r.price,
          exitRegime: "momentum", take_profit_pct: X.tp, take_profit2_pct: X.tp2,
          stop_loss_pct: X.sl, suggested_exit_h: X.reviewH, suggested_second_h: X.secondH,
          size: "full", sizeMult: mult, forceSpot: true, tier: r.tier, exit_plan: gbExitPlanText(X, r.price),
          entry_snapshot: { chg24h_pct: r.chg24, volume24h_usd: r.volQuote, high24h: r.high, tier: r.tier },
          onFilled: (res) => gbLogBought(r, null, res),
        }) }, `跟買 $${Math.round(usd).toLocaleString()}`)));
    }
    if (r.tier === "early2") kids.push(el("div", { class: "gb-buyrow gb-e2row" }, gbEarlyChip()));
    kids.push(details);
    return el("div", { class: "gb-row" + (r.tier === "cand" ? " gb-cand" : "") + (gbIsEarly(r.tier) ? " gb-early" : ""), "data-gb-tier": r.tier, "data-gb-sym": r.symbol }, ...kids);
  }

  function renderGainerBoard(rows, trig) {
    const box = $("gainerList"); if (!box) return;
    box.textContent = "";
    gbPumpNow = new Set(rows.filter((r) => r.tier === "pump").map((r) => r.symbol));
    gbChaseNow = new Set(rows.filter((r) => r.tier === "chase").map((r) => r.symbol));
    const bt = $("gainerPumpBt"); if (bt) { bt.textContent = ""; bt.append(gbBtLine("pump")); }
    if (!rows.length) { gbStateBox("empty", "而家冇幣夠急升（24h ≥ +5%）· 遲啲再睇"); return; }
    for (const r of rows) box.append(gbCard(r, trig.get(r.symbol + ":" + r.tier) || null, { buy: r.tier === "pump" || r.tier === "chase" }));
  }

  /** ⚡ v2 watch-only rows, computed live in the browser (live.js early2Trigger, every scan); minimal card, no buy. */
  function renderEarlyList(early, trig) {
    const box = $("earlyList"); if (!box) return;
    box.textContent = "";
    const bt = $("gainerEarlyBt"); if (bt) { bt.textContent = ""; bt.append(gbBtLine("early2")); }
    if (!early.length) {
      box.append(el("div", { class: "gb-state gb-empty" }, el("div", { class: "gb-state-msg", text: "近 4h 冇 ⚡" })));
      return;
    }
    for (const r of early) box.append(gbCard(r, trig.get(r.symbol + ":early2") || null, { buy: false }));
  }

  function renderGainerMult() {
    const host = $("gainerMult"); if (!host) return;
    host.textContent = "";
    const cur = gbMult();
    for (const m of [1, 2, 3]) {
      host.append(el("button", { type: "button", class: "chip" + (m === cur ? " active" : ""), onclick: () => {
        localStorage.setItem(GB_MULT_KEY, String(m)); renderGainerMult(); loadGainerBoard(false);
      } }, `${m}x`));
    }
  }

  let gbLastScan = 0, gbLastTick = 0, gbWatched = new Set();
  function paintGainerLive() {
    const n = $("gainerLive"); if (!n) return;
    const t = Math.max(gbLastScan, gbLastTick);
    const fresh = t && Date.now() - t < 3 * 60_000;
    n.classList.toggle("on", !!fresh);
    const tt = $("gainerUpdated");
    if (tt) tt.textContent = t ? "更新 " + new Date(t).toLocaleTimeString("zh-HK", { hour12: false }) : "連接中…";
  }

  async function loadGainerBoard(force) {
    if (!$("gainerList") || !window.MCE.live || !window.MCE.live.computeGainerBoard) return;
    if (gbBusy) return;
    gbBusy = true;
    renderGainerMult();
    const meta = $("gainerMeta");
    if (!$("gainerList").childElementCount || force) gbStateBox("loading", "掃緊 Binance 急升幣…");
    const staticP = gbLoadStatic(force).catch(() => gbStatic);
    let res = null;
    try {
      res = await window.MCE.live.computeGainerBoard({ force: !!force, n: 8 });
      await staticP;
      const cut = Date.now() - GB_TRIGGER_WINDOW_H * 3600e3;
      const active = ((gbStatic.latest && gbStatic.latest.active) || []).filter((e) => new Date(e.picked_at).getTime() >= cut);
      const srvPump = new Map(active.filter((e) => e.tier === "pump").map((e) => [e.pair, e]));
      const rows = (res.rows || []).map((r) => {
        let serverFlag = null;
        if (r.tier === "pump" && r.trigger) {
          serverFlag = { symbol: r.base, pair: r.symbol, tier: "pump", picked_at: isoSh(new Date(r.trigger.t)), entry_price_usd: r.trigger.price, trigger_src: "kline", via: r.trigger.via, forming: r.trigger.forming };
        } else if (r.tier === "pump" && srvPump.get(r.symbol)) {
          serverFlag = { ...srvPump.get(r.symbol), trigger_src: "snapshot" };
        }
        return { ...r, serverFlag };
      });
      // ⚡ v2: live client rows (all eligible coins, closed 15m bars). Old server ⚡ (tier "early") is no longer shown.
      const early = (res.early || []).slice(0, 8).map((r) => ({ ...r, serverFlag: { symbol: r.base, pair: r.symbol, tier: "early2",
        picked_at: isoSh(new Date(r.trigger.t)), entry_price_usd: r.trigger.price, trigger_src: "kline", via: r.trigger.via, forming: false } }));
      const trig = gbLogSnapshot(rows.concat(early));
      for (const r of rows) { const t = trig.get(r.symbol + ":" + r.tier); if (t && !t.trigger_src) t.trigger_src = r.tier === "pump" ? "now" : "seen"; }
      const curPx = (p) => (res.prices && res.prices.get(p)) || null;
      renderGainerAlert(rows.filter((r) => r.tier === "pump").map((r) => ({ tier: "pump", base: r.base, pair: r.symbol, price: r.price, trig: trig.get(r.symbol + ":pump") }))
        .concat(early.map((e) => ({ tier: "early2", base: e.base, pair: e.symbol, price: curPx(e.symbol) || e.price, trig: trig.get(e.symbol + ":early2") }))));
      renderGainerBoard(rows, trig);
      renderEarlyList(early, trig);
      paintXChips(); // after 🔥 + ⚡ cards exist so .shill-flag nodes get painted
      gbLoadX(false).then(paintXChips).catch(() => {});
      gbClientSnapshot(rows, early);
      if (window.MCE.live && window.MCE.live.board) refreshExitChips(window.MCE.live.board, { force: true });
      const watch = rows.map((r) => r.symbol).concat(early.map((e) => e.symbol));
      gbWatched = new Set(watch);
      try { window.MCE.live.watchExtra(watch); } catch (_) {}
      gbLastScan = Date.now();
      const nPump = rows.filter((r) => r.tier === "pump").length, nChase = rows.filter((r) => r.tier === "chase").length;
      const nCand = rows.length - nPump - nChase;
      if (meta) meta.textContent = `掃全部 ${res.pool || 0} 隻 · 🔥 ${nPump} · 🚀 ${nChase} · ⚡ ${early.length}` + (nCand ? ` · 候補 ${nCand}` : "") + ` · ${gbMult()}x`;
    } catch (e) {
      console.warn("gainer board failed", e);
      const a = $("gainerAlert"); if (a) a.hidden = true;
      gbStateBox("error", "暫時攞唔到數據（Binance）· 撳再試");
      gbStateBox("error", "暫時攞唔到數據 · 撳再試", "earlyList");
      if (meta) meta.textContent = "暫時攞唔到數據";
    } finally { gbBusy = false; }
    paintGainerLive();
    renderGainerAccuracy();
    renderGainerScorecard(res);
    renderGainerCaptureStrip();
  }

  /** WS tick → 觸發後 %, live dot. Price / 24h % cells are patched by app.js (data-bn-price / data-bn-chg). */
  function onGainerTick(_marks, board) {
    if (board) refreshExitChips(board);
    if (!gbWatched.size || !board) return;
    let hit = false;
    for (const s of gbWatched) { const r = board.get(s); if (r && r.t && r.t > gbLastTick) { hit = true; gbLastTick = Math.max(gbLastTick, r.t); } }
    document.querySelectorAll("[data-gb-fh]").forEach((n) => {
      const r = board.get(n.dataset.gbFh); const hi0 = parseFloat(n.dataset.gbHigh);
      if (!(r && r.price > 0 && hi0 > 0)) return;
      const hi = Math.max(hi0, r.price); n.dataset.gbHigh = String(hi);
      const v = (r.price / hi - 1) * 100; n.textContent = `離 24h 高 ${pct(v)}`;
    });
    document.querySelectorAll("[data-gb-since]").forEach((n) => {
      const r = board.get(n.dataset.gbSince); const e = parseFloat(n.dataset.gbEntry);
      if (r && r.price > 0 && e > 0) { const v = (r.price / e - 1) * 100; n.textContent = pct(v); n.className = "num " + cls(v); }
    });
    if (hit) paintGainerLive();
  }


  /** Homepage 🔥 strip: latest sealed early-capture rate (always visible, not folded in 詳情). */
  function renderGainerCaptureStrip() {
    const box = $("gainerCapture"); if (!box) return;
    box.textContent = "";
    const sum = gbStatic.summary;
    const cards = (sum && sum.scorecards) || [];
    box.hidden = false;
    if (!cards.length) {
      box.append(
        el("div", { class: "gbc-line" },
          el("span", { class: "gbc-kicker", text: "今日早標捕捉率" }),
          el("span", { class: "gbc-big muted", text: "—" })),
        el("p", { class: "gbc-sub tiny muted", text: "未有密封 · 每晚 23:55 對 Binance 頭 20" }));
      return;
    }
    const c = cards[cards.length - 1];
    const sealed = c.date || "";
    const md = sealed.length >= 10 ? `${Number(sealed.slice(5, 7))}/${sealed.slice(8, 10)}` : sealed;
    const today = isoSh().slice(0, 10);
    const recall = c.recall_top20_pct;
    const prec = c.precision_pct;
    const earlyHits = c.early_hits != null ? c.early_hits : ((c.hits || []).length);
    const earlyFlagged = c.early_flagged != null ? c.early_flagged : (c.flagged != null ? c.flagged : "–");
    const pass = recall != null && Number(recall) >= 10;
    const hitSyms = (c.hits || []).map((h) => (typeof h === "string" ? h : h.symbol)).filter(Boolean);
    const lateSyms = (c.late || []).map((h) => (typeof h === "string" ? h : h.symbol)).filter(Boolean);
    const missSyms = (c.missed || []).map((h) => (typeof h === "string" ? h : h.symbol)).filter(Boolean);
    const w = sum.scorecard_7d || {};

    const gate = el("span", {
      class: "gbc-gate " + (pass ? "pass" : "fail"),
      text: pass ? "PASS（≥10%）" : "FAIL（≥10%）",
    });
    const big = el("div", { class: "gbc-line" },
      el("span", { class: "gbc-kicker", text: "今日早標捕捉率" }),
      el("span", { class: "gbc-big num " + (pass ? "pos" : "neg"), text: recall != null ? `${recall}%` : "—" }),
      el("span", { class: "gbc-inline", text: `（捉到 ${earlyHits}/20）` }),
      el("span", { class: "gbc-dot", text: "·" }),
      el("span", { class: "gbc-inline", text: `講中率 ${prec != null ? prec + "%" : "–"}（${earlyHits}/${earlyFlagged}）` }),
      el("span", { class: "gbc-dot", text: "·" }),
      gate);
    const sealNote = el("div", { class: "gbc-seal tiny" },
      el("span", { class: "gbc-sealchip", text: `密封 ${md}` }),
      sealed !== today
        ? el("span", { class: "muted", text: "（最新密封日 · 今日未封）" })
        : el("span", { class: "muted", text: "（今日）" }),
      el("span", { class: "muted", text: w.days ? ` · 7 日 ${w.recall_top20_pct ?? "–"}%` : "" }));

    const names = (lab, syms, cls) => el("div", { class: "gbc-names " + cls },
      el("span", { class: "gbc-lab", text: lab }),
      el("span", { class: "gbc-syms", text: syms.length ? syms.join(" · ") : "無" }));

    box.append(big, sealNote,
      names("捉到", hitSyms, "gbc-hit"),
      names("走漏", missSyms, "gbc-miss"));
    if (lateSyms.length) box.append(names("遲標", lateSyms, "gbc-late"));
  }

  function renderGainerAccuracy() {
    const box = $("gainerAcc"); if (!box) return;
    box.textContent = "";
    const sum = gbStatic.summary;
    const head = el("div", { class: "gacc-head" }, el("strong", { text: "急升榜準繩度" }), el("span", { class: "muted tiny", text: "Binance 1m K 線封盤 · 4h 為主 · 24h 補充" }));
    if (!sum) { box.append(head, el("p", { class: "muted tiny", text: "暫時攞唔到準繩度數據" })); return; }
    const h4 = sum.horizons && sum.horizons["4h"];
    const h24 = sum.horizons && sum.horizons["24h"];
    const st = (k, v, c = "") => el("div", { class: "gacc-stat" }, el("div", { class: "k", text: k }), el("div", { class: "v num " + c, text: v }));
    const rate = (x, k) => (x && x.n ? Math.round((x[k] / x.n) * 100) + "%" : "–");
    const btP = sum.backtest_30d && sum.backtest_30d.tiers && sum.backtest_30d.tiers.pump;
    const btE = sum.backtest_30d && sum.backtest_30d.tiers && sum.backtest_30d.tiers.early2;  // ⚡ v2 (backtest_early_30d)
    const tP = btP && btP.test, tE = btE && btE.test;
    box.append(head);
    {
      const upd = sum.updated_at ? new Date(sum.updated_at) : null;
      const ageMin = upd ? Math.round((Date.now() - upd.getTime()) / 60e3) : null;
      const stale = ageMin == null || ageMin > 45;
      const cs = gbClientSnaps();
      const lastC = cs.length ? cs[cs.length - 1].t : null;
      box.append(el("p", { class: "tiny gb-snapnote " + (stale ? "warn" : "muted"), id: "gbSnapNote",
        text: `伺服器快照（GitHub Actions 每半個鐘）：最近 ${upd ? frTime(upd) : "—"}${ageMin != null ? `（${ageMin} 分鐘前）` : ""}`
          + (stale ? " · GitHub 排程可能延誤／漏跑" : "")
          + ` · 本機後備快照 ${cs.length} 次（存喺呢部機 localStorage${lastC ? "，最近 " + frTime(lastC) : ""}；只做後備，唔計入正式準繩度）` }));
    }
    if (h4 && h4.n) {
      box.append(el("div", { class: "gacc-grid" },
        st(`實盤 4h 中 +20%（${h4.hit20}/${h4.n}）`, rate(h4, "hit20"), "pos"),
        st("4h 平均最高", pct(h4.avg_max_gain_pct), cls(h4.avg_max_gain_pct)),
        st("4h 平均收", pct(h4.avg_close_pct), cls(h4.avg_close_pct)),
        st("4h 平均最大回撤", pct(h4.avg_max_drawdown_pct), "neg")));
    } else {
      box.append(el("p", { class: "muted tiny", text: "實盤：未有已封盤結果 · 每半個鐘自動快照，4h 後封盤。" }));
    }
    box.append(el("div", { class: "gacc-grid gacc-bt" },
      st(`🔥 回測測試段 4h +20%（${tP ? tP.fires : "–"} 次）`, tP ? tP.hit20_4h_pct + "%" : "–"),
      st("🔥 測試段平均 4h", tP ? pct(tP.mean_close_4h_pct) : "–", tP ? cls(tP.mean_close_4h_pct) : ""),
      st(`⚡ 回測測試段 4h +20%（${tE ? tE.fires : "–"} 次）`, tE ? tE.hit20_4h_pct + "%" : "–"),
      st("⚡ 測試段平均 4h", tE ? pct(tE.mean_close_4h_pct) : "–", tE ? cls(tE.mean_close_4h_pct) : ""),
      st("⚡ 比 🔥 早（中位）", btE && btE.chip && btE.chip.median_lead_vs_fire_min != null ? `${Math.round(btE.chip.median_lead_vs_fire_min)} 分鐘` : "–"),
      st("急升捉到率 🔥／🔥+⚡", btE && btE.chip ? `${btE.chip.fire_alone_recall_pct}%／${btE.chip.recall_with_fire_pct}%` : "–")));
    if (tP) box.append(el("p", { class: "muted tiny", text: `回測：全部 Binance USDT 現貨（24h 成交 ≥ $3M）· 30 日 1h K 線 · 測試段 = 後 15 日 · 🔥 大約 ${Math.max(1, Math.round(100 / Math.max(0.1, tP.hit20_4h_pct)))} 次先中 1 次 · 一定要設止蝕` }));
    if (h24 && h24.n) box.append(el("p", { class: "muted tiny", text: `24h 補充：+20% ${h24.hit20}/${h24.n}（${rate(h24, "hit20")}）· +50% ${h24.hit50}/${h24.n} · 平均最高 ${pct(h24.avg_max_gain_pct)} · 平均收 ${pct(h24.avg_close_pct)}` }));
    if (h4 && h4.n && h4.n < 20) box.append(el("p", { class: "muted tiny", text: `實盤樣本 ${h4.n} 筆 · 太少唔好當結論` }));
    const lb = sum.latest_4h;
    if (lb && lb.entries && lb.entries.length) {
      box.append(el("div", { class: "gacc-latest" },
        el("div", { class: "tiny muted", text: `最新 4h 封盤 · ${frTime(lb.picked_at)} 揀` }),
        ...lb.entries.slice(0, 6).map((x) => el("div", { class: "gacc-row" },
          el("span", { class: "nm", text: gbTierIcon(x.tier) + " " + x.symbol }),
          el("span", { class: "num tiny muted", text: "入 " + price(x.entry_price_usd) }),
          el("span", { class: "num " + cls(x.max_gain_pct), text: "最高 " + pct(x.max_gain_pct) }),
          el("span", { class: "num " + cls(x.close_pct), text: "收 " + pct(x.close_pct) }),
          el("span", { class: "pump-badge " + (x.hit20 ? "avoid" : "soft"), text: x.hit50 ? "中 +50%" : x.hit20 ? "中 +20%" : "未中" })))));
    }
    if (sum.updated_at) box.append(el("p", { class: "muted tiny", text: "更新 " + frTime(sum.updated_at) }));
  }

  function renderGainerScorecard(res) {
    const box = $("gainerCard"); if (!box) return;
    box.textContent = "";
    const sum = gbStatic.summary;
    const cards = (sum && sum.scorecards) || [];
    box.append(el("div", { class: "gacc-head" }, el("strong", { text: "今日對照 Binance Gainer" }), el("span", { class: "muted tiny", text: "每晚 23:55 對全部 USDT 現貨 24h 升幅頭 20 名" })));
    // Your bought rows today (this browser) vs live 24h rank
    const today = isoSh().slice(0, 10);
    const bought = gbLoadLog().filter((x) => x.bought && String(x.picked_at).startsWith(today));
    if (bought.length) {
      box.append(el("div", { class: "tiny" }, el("b", { text: "你今日喺急升榜買咗： " }), bought.map((b) => {
        const live = res && res.rank && res.rank.get(b.pair);
        return `${b.symbol}（${frTime(b.picked_at)} 買 · 當時第 ${b.rank_24h_at_pick || "–"} 名${live ? ` · 而家第 ${live.rank24} 名` : ""}）`;
      }).join("、")));
    }
    if (!cards.length) { box.append(el("p", { class: "muted tiny", text: "未有對照 · 每晚 23:55 出。升前標記（標記時唔喺頭 20、24h 未升夠 15%）同遲咗嘅分開計。" })); return; }
    const c = cards[cards.length - 1];
    const w = sum.scorecard_7d || {};
    const st = (k, v, s) => el("div", { class: "gacc-stat" }, el("div", { class: "k", text: k }), el("div", { class: "v num", text: v }), s ? el("div", { class: "tiny muted", text: s }) : "");
    box.append(el("div", { class: "gacc-grid" },
      st(`${c.date} 講中率（升前）`, c.precision_pct != null ? `${c.precision_pct}%` : "–", `${c.early_hits}/${c.early_flagged ?? c.flagged} 升前標記入頭 20`),
      st("捉到率（升前）", `${c.recall_top20_pct}%`, `頭 20 有幾多升前標咗 · 頭 10：${c.recall_top10_pct}%`),
      st("遲咗（已升先標）", `${c.late_hits}/${c.late_flagged ?? "–"}`, "唔計入講中／捉到"),
      st("7 日講中／捉到", `${w.precision_pct ?? "–"}% / ${w.recall_top20_pct ?? "–"}%`, `${w.early_hits || 0}/${w.early_flagged ?? w.flagged ?? 0} · ${w.days || 0} 日`)));
    box.append(el("div", { class: "gcard-trend tiny muted", text: "7 日：" + cards.map((x) => `${x.date.slice(5)} 中${x.precision_pct ?? "–"}%/捉${x.recall_top20_pct}%`).join(" · ") }));
    if (c.hits && c.hits.length) box.append(el("div", { class: "tiny" }, el("b", { text: "升前中： " }), c.hits.map((h) => `${h.symbol}（${frTime(h.flag_time)} 標 · 第 ${h.final_rank} 名${h.lead_h != null ? ` · 早 ${h.lead_h}h 到頂` : ""}）`).join("、")));
    if (c.late && c.late.length) box.append(el("div", { class: "tiny muted", text: "遲咗： " + c.late.map((h) => `${h.symbol}（${frTime(h.flag_time)} 標時已第 ${h.rank_24h_at_flag ?? "–"} 名）`).join("、") }));
    if (c.missed && c.missed.length) box.append(el("div", { class: "tiny muted", text: "走漏： " + c.missed.join("、") }));
  }

  /** Separate table: latest batch buys (每日新留意) — not the big follow-buy cards. */
  function renderDailyBatchTable() {
    const body = $("dailyBatchBody");
    const empty = $("dailyBatchEmpty");
    const meta = $("dailyBatchMeta");
    const table = $("dailyBatchTable");
    if (!body) return;
    body.textContent = "";
    const batches = (S.picks && S.picks.batches) || [];
    const latest = batches.length ? batches[batches.length - 1] : null;
    const buys = latest ? (latest.entries || []).filter((e) => e.type === "buy") : [];
    if (meta) {
      if (!latest) meta.textContent = "未有批次";
      else {
        const reg = latest.regime || {};
        const weak = reg.state === "weak" || reg.sizing === "half";
        meta.textContent = `${latest.id || "batch"} · ${frTime(latest.created_at)} · ${buys.length} 隻可買`
          + (weak ? " · 弱市半注" : " · 正常注碼")
          + " · 同「今日跟買」卡分開";
      }
    }
    if (!buys.length) {
      if (empty) empty.hidden = false;
      if (table) table.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (table) table.hidden = false;
    const liveApi = window.MCE.live;
    for (const e of buys) {
      const li = liveInfo(e.chain, e.pair_address);
      const bpx = e.chain === "binance" && window.MCE.live && window.MCE.live.board && window.MCE.live.board.get(e.pair_address);
      const livePx = li.state === "live" && li.price > 0 ? li.price : (bpx && bpx.price > 0 ? bpx.price : null);
      const isLive = livePx != null;
      const px = isLive ? livePx : e.entry_price_usd; // 現價 cell only; exit levels never use the pick price
      const chg = e.entry_snapshot && e.entry_snapshot.chg24h_pct;
      const half = (e.flags || []).includes("size:half") || e.size === "half" || e.suggested_exit_h === 12
        || (latest.regime && latest.regime.sizing === "half");
      // Decision (QA 127c32a): a buy ALWAYS starts a fresh exit window from now (also for rows whose pick 24h is over),
      // so the table shows the would-be hold-until + target/stop at the CURRENT live price = buy window = holdings.
      const rowInfo = {
        chain: e.chain, pair: e.pair_address, token: e.token_address,
        symbol: e.symbol, name: e.name, price: px,
        source: e.chain === "binance" ? "binance" : undefined,
        created_at: e.created_at, entry_price_usd: e.entry_price_usd,
        entry_snapshot: e.entry_snapshot,
        exitRegime: e.exitRegime || (half ? "weak" : "normal"),
        suggested_exit_h: e.suggested_exit_h, suggested_second_h: e.suggested_second_h,
        take_profit_pct: e.take_profit_pct, stop_loss_pct: e.stop_loss_pct,
        flags: e.flags, size: half ? "half" : "full",
      };
      const plan = wouldBuyPlan(rowInfo);
      const pickPlan = exitPlanFromEntry(e);
      const pickOver = pickPlan && pickPlan.pastReview;
      const lvPx = isLive ? livePx : null; // no live price yet → 「—」 until the first WS tick fills it
      const liveAttrs = exitLiveAttrs(e.chain === "binance" ? e.pair_address : null, plan, lvPx);
      const logo = liveApi && liveApi.coinLogoEl
        ? liveApi.coinLogoEl(e.symbol, "coin-logo", 28)
        : el("span", { class: "coin-logo letter", text: String(e.symbol || "?").slice(0, 2) });
      body.append(el("tr", Object.assign({ class: "cardish", "data-daily-sym": e.symbol }, liveAttrs),
        el("td", { "data-label": "幣" },
          el("div", { class: "tok" }, logo, el("div", {},
            el("div", { class: "nm", text: e.symbol }),
            chg != null ? el("div", { class: "sy num tiny " + cls(chg), text: pct(chg) }) : "",
            e.chain === "binance" ? shillFlagEl(e.pair_address || e.symbol) : null
          ))
        ),
        el("td", { class: "num live-px", "data-label": "現價", "data-bn-price": e.pair_address || "", text: px != null ? price(px) : "…" }),
        el("td", { class: "num " + cls(chg), "data-label": "24h", text: chg != null ? pct(chg) : "—" }),
        el("td", { class: "daily-when", "data-label": "幾時可以放" },
          exitLiveNode("div", {}, "揸到 {review}", plan, lvPx)),
        el("td", { class: "daily-target", "data-label": "目標價" },
          exitLiveNode("div", { class: "num pos" }, "{target}（+{tp}%）", plan, lvPx),
          exitLiveNode("div", { class: "num neg tiny" }, "止蝕 {stop}（−{sl}%）", plan, lvPx)),
        el("td", { "data-label": "注碼" },
          el("span", { class: "size-pill " + (half ? "half" : "full"), text: half ? "半注" : "全注" })
        ),
        el("td", { class: "actions", "data-label": "" },
          el("button", { class: "primary sm", onclick: () => openBuy(rowInfo) }, "買")
        )
      ));
    }
    paintShillSoon();
    if (window.MCE.live && window.MCE.live.board) refreshExitChips(window.MCE.live.board, { force: true });
  }

  function renderPicks() {
    const all = S.picks.batches.flatMap((b) => b.entries.map((e) => evalEntry(b, e)));
    const latest = S.picks.batches[S.picks.batches.length - 1];
    const latestBuys = (latest ? latest.entries : []).filter((e) => e.type === "buy").map((e) => evalEntry(latest, e));
    const buys = all.filter((x) => x.e.type === "buy"), avoids = all.filter((x) => x.e.type === "avoid");
    // Simple UI uses latest batch (Binance) first
    const simpleBuys = latestBuys.length ? latestBuys : buys;
    // Newest first so Binance batch-002+ surfaces above old Solana Dex
    const buysNewest = [...buys].sort((a, b) => new Date(b.e.created_at) - new Date(a.e.created_at));
    const avoidsNewest = [...avoids].sort((a, b) => new Date(b.e.created_at) - new Date(a.e.created_at));
    const pb = $("picksBody"); pb.textContent = "";
    for (const x of buysNewest) {
      const href = safeUrl(x.e.url);
      const retTd = retCell(x); retTd.setAttribute("data-label", "回報");
      const hz = horizonCell(x); hz.setAttribute("data-label", "展望");
      pb.append(el("tr", { class: "cardish", onclick: () => showDetail(x) },
        el("td", { "data-label": "幣" }, el("div", { class: "tok" }, el("div", {}, el("div", { class: "nm", text: x.e.name }), el("div", { class: "sy", text: `$${x.e.symbol} · ${x.e.chain}` })))),
        el("td", { "data-label": "批次" }, el("div", { text: batchLabel(x.b) }), el("div", { class: "muted", text: localTime(x.e.created_at) })),
        el("td", { class: "num", "data-label": "推薦價", text: price(x.e.entry_price_usd) }),
        el("td", { class: "num", "data-label": "而家", text: x.li.state === "live" ? price(x.li.price) : x.li.state === "dead" ? "–" : "…" }),
        retTd,
        el("td", { class: "num " + cls(x.bmRet), "data-label": x.bmKey || "BTC", text: pct(x.bmRet) }),
        el("td", { class: "num " + cls(x.excess), "data-label": "vs " + (x.bmKey || "BTC"), text: x.excess == null ? "–" : (x.excess > 0 ? "+" : "") + x.excess.toFixed(1) + " pts" }),
        el("td", { "data-label": "持有", text: held(x.e.created_at) }),
        hz,
        el("td", { "data-label": "", class: "actions" }, el("button", { class: "primary", onclick: (ev) => { ev.stopPropagation(); openBuy({ chain: x.e.chain, pair: x.e.pair_address, token: x.e.token_address, symbol: x.e.symbol, name: x.e.name }); } }, "落倉"), " ",
          href ? el("a", { href, target: "_blank", rel: "noopener", onclick: (ev) => ev.stopPropagation(), text: "↗" }) : "")));
    }
    const ab = $("avoidBody"); ab.textContent = "";
    for (const x of avoidsNewest) {
      const good = x.ret != null && x.ret < -0.05, flat = x.ret != null && Math.abs(x.ret) < 0.05;
      ab.append(el("tr", { onclick: () => showDetail(x) }, tokenCell(x.e),
        el("td", { "data-label": "批次" }, el("div", { text: batchLabel(x.b) }), el("div", { class: "muted", text: localTime(x.e.created_at) })),
        el("td", { class: "num", text: price(x.e.entry_price_usd) }),
        el("td", { class: "num", text: x.li.state === "live" ? price(x.li.price) : "–" }),
        retCell(x), el("td", { class: "num " + cls(x.solRet), text: pct(x.solRet) }), el("td", { text: held(x.e.created_at) }),
        el("td", {}, x.ret == null ? "…" : el("span", { class: "pill " + (flat ? "" : good ? "good" : "bad") }, flat ? "暫時持平" : good ? "✓ 避得啱（跌咗）" : "✗ 避錯（升咗）")),
        el("td", {}, safeUrl(x.e.url) ? el("a", { href: safeUrl(x.e.url), target: "_blank", rel: "noopener", onclick: (ev) => ev.stopPropagation(), text: "↗" }) : "")));
    }
    const rs = buys.map((x) => x.ret).filter((v) => v != null);
    const ex = buys.map((x) => x.excess).filter((v) => v != null);
    const sols = buys.map((x) => x.solRet).filter((v) => v != null);
    const best = buys.filter((x) => x.ret != null).sort((a, b) => b.ret - a.ret);
    const goodAvoid = avoids.filter((x) => x.ret != null && x.ret < -0.05).length;
    // Honesty + horizons
    const sh = $("sampleHonesty");
    if (sh) {
      const n = buys.length;
      const due = buys.some((x) => hoursSince(x.e.created_at) >= 24);
      const hasOut = S.outcomes.length > 0;
      sh.textContent = (n < 20 ? `⚠️ 樣本太少（買入推薦 ${n} 筆），唔好當結論。` : `樣本 ${n} 筆。`)
        + (hasOut ? "" : " 24h／7d 結果尚未到期（或未跑 snapshot）。");
    }
    renderFollowReport(simpleBuys);
    renderDailyBatchTable();
    renderSimpleCards(simpleBuys);
    loadLiveBnPicks(false);
    // Keep WS alive so follow-report / card marks tick even with empty portfolio
    try {
      if (window.MCE.live) {
        ensureLiveLoop(true);
      }
    } catch (_) {}

    const st = $("pickStats"); st.textContent = "";
    const stat = (k, v, s, c = "") => el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v " + c, text: v }), s ? el("div", { class: "s", text: s }) : "");
    st.append(
      stat("買入推薦", String(buys.length), `${S.picks.batches.length} 批 · ${avoids.length} 條避過 · 樣本少慎讀`),
      stat("勝率", rs.length ? Math.round((rs.filter((v) => v > 0).length / rs.length) * 100) + "%" : "–", rs.length < 20 ? "樣本太少，唔好當結論" : `${rs.filter((v) => v > 0).length}/${rs.length} 賺錢中`),
      stat("平均回報", pct(avg(rs)), "等權、即時", cls(avg(rs))),
      stat("中位回報", pct(median(rs)), "", cls(median(rs))),
      stat("最好 / 最差", best.length ? `${pct(best[0].ret)} / ${pct(best[best.length - 1].ret)}` : "–", best.length ? `$${best[0].e.symbol} / $${best[best.length - 1].e.symbol}` : ""),
      stat("同期 BTC", pct(avg(sols)), "基準平均（Binance）", cls(avg(sols))),
      stat("平均跑贏 BTC", ex.length ? (avg(ex) > 0 ? "+" : "") + avg(ex).toFixed(1) + " pts" : "–", `${ex.filter((v) => v > 0).length}/${ex.length} 跑贏`, cls(avg(ex))),
      stat("已死 / Rug", String(buys.filter((x) => x.li.state === "dead").length), "計 −100%"),
      stat("避過啱咗", avoids.length ? `${goodAvoid}/${avoids.length}` : "–", "之後價跌"));
    st.append(el("p", { class: "muted", style: "grid-column:1/-1;margin:0", text: `新批報價：Binance 即時 · 舊批可能仍係 Dex · ${new Date().toLocaleTimeString()} · 紀錄只加唔改。樣本少唔證明得咩。` }));
    const detailDefault = buysNewest.find((x) => x.e.chain === "binance") || buysNewest[0];
    if (!$("pickDetails").childElementCount && detailDefault) showDetail(detailDefault);
  }
  function showDetail(x) {
    const d = $("pickDetails"); if (!d) return;
    d.textContent = "";
    const e = x.e;
    const snap = e.entry_snapshot || {};
    const ev = e.evidence || {};
    const parts = e.score_parts || {};
    const ageH = snap.pair_age_h != null ? snap.pair_age_h + "h" : "–";
    const bnEv = e.chain === "binance" || (ev.source && String(ev.source).indexOf("binance") === 0) || !ev.cashtag_sample;
    const evidenceText = bnEv
      ? (ev.note || ev.source
        ? `Binance OHLCV · ${ev.symbol || e.pair_address || e.symbol || ""} · ${ev.note || "多角度留意盤（唔係 X 熱度）"}`
        : "Binance 盤 · 無 X 證據欄")
      : `近 24h ${fmtInt(ev.x_last24h)} 則 vs 之前每日 ${fmtInt(ev.x_prior_daily_avg)} · 近 6h ${ev.x_last6h ?? "–"} vs 前 6h ${ev.x_prev6h ?? "–"} · 7 日共 ${fmtInt(ev.x_7d_total)} · cashtag 樣本 ${(ev.cashtag_sample && ev.cashtag_sample.posts) || 0} 則 / ${(ev.cashtag_sample && ev.cashtag_sample.unique_authors) || 0} 人 · 查詢：${ev.x_count_query || "–"}`;
    const angle = e.angle || snap.angle || "";
    const angleLabel = ANGLE_LABEL[angle] || angle || "留意盤";
    // Confidence / score_parts hidden by default (user hates score walls); obscure expand only
    const geekBits = [];
    if (e.model_score != null) geekBits.push("model " + e.model_score);
    if (Object.keys(parts).length) geekBits.push(Object.entries(parts).map(([k, v]) => k + " " + v).join(", "));
    const geekDetails = geekBits.length
      ? el("details", { class: "sc-details geek-score" },
          el("summary", { class: "muted tiny", text: "技術分數（可略）" }),
          el("div", { class: "muted tiny", text: geekBits.join(" · ") }))
      : "";
    d.append(
      el("h3", { text: `${e.type === "buy" ? "買入推薦" : "避過"}：${e.name} ($${e.symbol}) · ${batchLabel(x.b)}` }),
      el("p", { class: "rationale", text: e.rationale }),
      e.type === "buy" ? exitHintRow(exitPlanFromEntry(e), { className: "sc-exit sc-exit-detail" }) : "",
      e.type === "buy" ? el("p", {}, el("button", { class: "primary", onclick: () => openBuy({ chain: e.chain, pair: e.pair_address, token: e.token_address, symbol: e.symbol, name: e.name, source: e.chain === "binance" ? "binance" : undefined }) }, "落倉 · 放入 Crypto.M")) : "",
      el("div", { class: "kv" },
        el("div", { text: "記錄時間" }), el("div", { text: `${localTime(e.created_at)} (${e.created_at})` }),
        el("div", { text: "推薦價" }), el("div", { text: `${price(e.entry_price_usd)} · 當時 ${(x.bmKey || "BTC")} $${(x.bm && x.bm.price_usd) != null ? x.bm.price_usd : (x.b.benchmarks?.BTC?.price_usd ?? x.b.benchmarks?.SOL?.price_usd ?? "?")}` }),
        el("div", { text: "入場快照" }), el("div", { text: `流動性 ${money(snap.liquidity_usd)} · 24h 成交 ${money(snap.volume24h_usd)} · 市值 ${money(snap.market_cap_usd)} · 年齡 ${ageH} · 24h ${pct(snap.chg24h_pct)}` }),
        el("div", { text: "角度" }), el("div", { text: angleLabel + (e.tip ? " · " + e.tip : "") }),
        el("div", { text: "旗標" }), el("div", { text: (e.flags || []).join(" · ") || "無" }),
        el("div", { text: bnEv ? "證據" : "X 證據" }), el("div", { text: evidenceText })),
      geekDetails,
      el("div", {}, (ev.posts || []).map((u) => safeUrl(u) ? [el("a", { href: safeUrl(u), target: "_blank", rel: "noopener nofollow", text: "X 帖 ↗" }), " "] : "")));
  }

  // ---------- Crypto.M 紙上倉（現貨 + 槓桿逐倉） ----------
  const PF_KEY = "mce:paper:v2";
  const PF_KEY_OLD = "mce:paper:v1";
  const START_CASH = 5000;
  const CAP_PRESETS = [1000, 5000, 10000, 50000];
  const LEV_ALL = [2, 3, 5, 10, 20, 50];
  const LIQ_MARGIN_FRAC = 0.9; // 浮虧達保證金 90% → 爆倉
  // BUG FIX (ux-fix): the spot fee (then 1%) was charged on the full NOTIONAL of a leveraged trade, so a
  // 50x all-in lost ~33% of the cash on open and ~66% after closing at an unchanged price. Perps charge ~0.05% taker
  // on notional; we model 1/10 of the spot fee per side (0.1% of notional at the default 1%).
  // Fees (QA 20261025): Binance taker ≈ 0.1% per side for BOTH spot (of USD traded) and perps (of NOTIONAL).
  const SPOT_FEE_DEFAULT = 0.1;
  const LEV_FEE_PCT = 0.1;
  const levFeePct = () => LEV_FEE_PCT;
  const RISK = {
    safe: { id: "safe", label: "穩陣", maxLev: 3, defaultLev: 2, allowLev: true, spotOnlyCopy: true },
    agg:  { id: "agg",  label: "進取", maxLev: 10, defaultLev: 5, allowLev: true, spotOnlyCopy: false },
    yolo: { id: "yolo", label: "極高風險", maxLev: 50, defaultLev: 10, allowLev: true, spotOnlyCopy: false },
    allin: { id: "allin", label: "孤注一擲", maxLev: 50, defaultLev: 50, allowLev: true, spotOnlyCopy: true },
  };
  let riskId = localStorage.getItem("mce:risk") || "agg";
  if (riskId === "allin") riskId = "yolo"; // legacy sticky all-in profile → same 50x cap, no hijack
  const risk = () => RISK[riskId] || RISK.agg;
  function setRisk(id) {
    if (!RISK[id]) return;
    riskId = id;
    localStorage.setItem("mce:risk", id);
    document.querySelectorAll("[data-risk]").forEach((b) => b.classList.toggle("active", b.dataset.risk === id));
    const h = $("riskHint");
    if (h) {
      h.textContent = id === "safe" ? "穩陣：偏向現貨，槓桿最多 3x。"
        : id === "yolo" ? "極高風險：最多 50x。跌約 1.8% 就爆倉。"
        : id === "allin" ? "孤注一擲：一隻幣 All-in（現貨或 50x）。"
        : "進取：最多 10x。";
      h.className = "muted risk-hint" + (id === "yolo" || id === "allin" ? " yolo" : "");
    }
    rebuildLevPresets(risk().defaultLev);
  }
  function levOpts() { return LEV_ALL.filter((x) => x <= risk().maxLev); }
  function rebuildLevPresets(selected) {
    const box = $("tradeLevPresets"); if (!box) return;
    const opts = levOpts();
    const sel = opts.includes(selected) ? selected : risk().defaultLev;
    box.textContent = "";
    for (const L of opts) {
      box.append(el("button", { type: "button", class: "sm preset" + (L === sel ? " active" : "") + (L >= 20 ? " hot" : ""), "data-lev": L, text: L + "x" }));
    }
    $("tradeLev").value = String(sel);
    box.querySelectorAll("[data-lev]").forEach((b) => b.onclick = () => {
      box.querySelectorAll(".preset").forEach((x) => x.classList.toggle("active", x === b));
      $("tradeLev").value = b.dataset.lev;
      $("tradeLev").dispatchEvent(new Event("change"));
    });
  }

  const pf = {
    migrate(old) {
      return {
        v: 2, start: old.start || START_CASH, cash: old.cash ?? START_CASH,
        realizedSpot: old.realized || 0, realizedLev: 0, feePct: old.feePct ?? SPOT_FEE_DEFAULT, feeV2: true,
        positions: old.positions || {}, levPositions: {}, trades: old.trades || [],
        liquidations: 0, equityPeak: old.start || START_CASH,
        firstBuyAt: old.firstBuyAt || null, solAtFirstBuy: old.solAtFirstBuy || old.bmAtFirstBuy || null, bmAtFirstBuy: old.bmAtFirstBuy || old.solAtFirstBuy || null,
        allin: null, created: old.created || new Date().toISOString(),
      };
    },
    fresh(start) {
      const s = Number(start) > 0 ? Number(start) : START_CASH;
      return { v: 2, start: s, cash: s, realizedSpot: 0, realizedLev: 0, feePct: SPOT_FEE_DEFAULT, feeV2: true,
        positions: {}, levPositions: {}, trades: [], liquidations: 0, equityPeak: s,
        firstBuyAt: null, solAtFirstBuy: null, bmAtFirstBuy: null, created: new Date().toISOString() };
    },
    load() {
      try {
        const raw = localStorage.getItem(PF_KEY) || localStorage.getItem(PF_KEY_OLD);
        if (!raw) return this.fresh(START_CASH);
        const s = JSON.parse(raw);
        if (s.v === 2) { if (feeMigrate(s)) this.save(s); return s; }
        if (s.v === 1) { const m = this.migrate(s); this.save(m); return m; }
      } catch {}
      return this.fresh(START_CASH);
    },
    save(s) {
      // BUG FIX (ux-fix): unbounded history could hit the localStorage quota → save threw → trades lost on reload.
      if (Array.isArray(s.trades) && s.trades.length > TRADES_MAX) s.trades = s.trades.slice(0, TRADES_MAX);
      s.rev = (s.rev || 0) + 1;
      try { localStorage.setItem(PF_KEY, JSON.stringify(s)); _pfRev = s.rev; }
      catch (e) { try { toast("模擬倉儲存失敗：" + e.message, "err"); } catch (_) {} }
    },
  };
  /** One-time: the old default spot fee 1% → 0.1% (Binance taker) for FUTURE trades. Recorded trades / position costs /
   *  open fees are history and are not rewritten. A custom value (≠ 1) is kept. */
  function feeMigrate(s) {
    if (!s || s.feeV2) return false;
    if (s.feePct == null || s.feePct === 1) s.feePct = SPOT_FEE_DEFAULT;
    s.feeV2 = true;
    return true;
  }
  const TRADES_MAX = 500;
  let _pfRev = 0;
  /** BUG FIX (ux-fix): another tab saved newer state → reload before any mutation so a stale tab never overwrites it. */
  function pfSyncFromStorage() {
    try {
      const raw = localStorage.getItem(PF_KEY); if (!raw) return false;
      const s = JSON.parse(raw);
      if (s && s.v === 2 && (feeMigrate(s), true) && (s.rev || 0) !== (P.rev || 0)) { P = s; _pfRev = s.rev || 0; return true; }
    } catch (_) {}
    return false;
  }
  let P = pf.load();
  _pfRev = P.rev || 0;
  window.addEventListener("storage", (ev) => {
    if (ev.key !== PF_KEY) return;
    if (pfSyncFromStorage()) { try { pfListKey = ""; renderPortfolio(false); } catch (_) {} }
  });
  let pfMode = "all"; // spot | lev | all — portfolio section filter
  let _lastEquity = null;
  const posKey = (chain, pair) => chain + ":" + pair;
  const fmtQty = (q) => (q >= 1000 ? Math.round(q).toLocaleString() : q >= 1 ? q.toLocaleString(undefined, { maximumFractionDigits: 2 }) : q.toPrecision(4));
  const DUST_USD = 0.01;
  const levKey = () => "L" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function liqPriceLong(entry, leverage) {
    // unrealized = margin * L * (mark/entry - 1) <= -LIQ_MARGIN_FRAC * margin
    // mark <= entry * (1 - LIQ_MARGIN_FRAC / L)
    return entry * (1 - LIQ_MARGIN_FRAC / leverage);
  }
  function levMark(pos, mark) {
    const u = pos.qty * (mark - pos.entry);
    const equity = pos.margin + u;
    const liq = liqPriceLong(pos.entry, pos.leverage);
    const dead = mark <= liq || equity <= pos.margin * (1 - LIQ_MARGIN_FRAC) + 1e-9;
    return { unreal: u, equity, liq, dead };
  }

  /* ---------- ONE set of paper-trade maths: used by real open/close AND by every preview (孤注一擲 grid, 平倉 sheet). ----------
   * Fees: spot = P.feePct % of USD each side (default 0.1% Binance taker); perps = levFeePct() % of NOTIONAL each side
   * (default 0.1%). Binance pairs fill at the mark (no pool impact). */
  const calc = {
    spotBuy(usd, px, feePct = P.feePct) { const fee = usd * feePct / 100; return { usd, fee, qty: (usd - fee) / px, cost: usd }; },
    spotSell(qty, px, feePct = P.feePct) { const gross = qty * px, fee = gross * feePct / 100; return { gross, fee, proceeds: gross - fee }; },
    /** 孤注一擲 50x margin: margin + open fee = ALL cash (no leftover cents, so 倉值 − 投入 = 盈虧 exactly). */
    allinMargin(cash, lev, fpct = levFeePct()) { return cash / (1 + lev * fpct / 100); },
    levOpen(margin, lev, px, fpct = levFeePct()) { const notional = margin * lev; return { margin, leverage: lev, notional, openFee: notional * fpct / 100, qty: notional / px, entry: px }; },
    /** Close a long at `mark`: liquidated → nothing back; else margin + unrealised − close fee. pnl includes BOTH fees. */
    levClose(pos, mark, fpct = levFeePct(), forceLiq = false) {
      const m = levMark(pos, mark);
      if (forceLiq || m.dead) return { dead: true, unreal: m.unreal, closeFee: 0, back: 0, pnl: -pos.margin - (pos.openFee || 0) };
      const closeFee = pos.qty * mark * fpct / 100;
      return { dead: false, unreal: m.unreal, closeFee, back: pos.margin + m.unreal - closeFee, pnl: m.unreal - closeFee - (pos.openFee || 0) };
    },
    /** Open-position P&L shown everywhere (row, group, header, 詳情): mark equity − cash paid in (margin + open fee).
     *  Close fee is not deducted until you actually close (same as spot: value = qty × mark, sell fee on close). */
    levOpenPnl(pos, mark) { const m = levMark(pos, mark); const paid = pos.margin + (pos.openFee || 0); const value = Math.max(0, m.equity); return { value, paid, pnl: value - paid, pct: paid ? (value / paid - 1) * 100 : 0, m }; },
  };

  async function livePrice(chain, pair) {
    if (chain === "binance") {
      if (window.MCE.live) {
        try { await window.MCE.live.ensureBoard(false); } catch {}
        // Force sync so mark exists
        // BUG FIX (ux-fix): a WS mark from before the tab was hidden could be minutes old → filled at a stale price.
        // (board row .t is only bumped by real WS/REST ticks; mark .t is also bumped by bookkeeping)
        const row = window.MCE.live.board && window.MCE.live.board.get(pair);
        if (row && row.price > 0 && row.t && Date.now() - row.t < 15_000) {
          return { state: "live", price: row.price, liq: 1e12, source: "binance", p: null };
        }
      }
      // Off-board Binance pair (e.g. 急升榜 coins): one public REST price call.
      try {
        const base = (window.MCE.live && window.MCE.live.BN_REST) || "https://data-api.binance.vision";
        const r = await fetch(base + "/api/v3/ticker/price?symbol=" + encodeURIComponent(pair));
        if (r.ok) {
          const px = parseFloat((await r.json()).price);
          if (px > 0) return { state: "live", price: px, liq: 1e12, source: "binance", p: null };
        }
      } catch (_) {}
      throw new Error("暫時攞唔到 Binance 報價");
    }
    await fetchPairs([{ chain, pair }], true);
    const li = liveInfo(chain, pair);
    if (li.state !== "live") throw new Error(li.state === "dead" ? "交易對已死或冇流動性，唔可以交易" : "暫時攞唔到報價");
    return li;
  }
  async function ensureMarketBenchmark() {
    if (!S.picks) await loadPicks();
    const last = S.picks?.batches?.[S.picks.batches.length - 1];
    const bm = pickBenchmark(last) || { key: "BTC", chain: "binance", pair_address: "BTCUSDT", price_usd: null };
    if (!bm.pair_address) return null;
    // Prefer live Binance board mark when chain is binance
    if (bm.chain === "binance" && window.MCE.live) {
      try { await window.MCE.live.ensureBoard(false); } catch {}
      const m = window.MCE.live.getMark("binance", bm.pair_address);
      if (m && m.price > 0) bm.price_usd = m.price;
    } else {
      await fetchPairs([{ chain: bm.chain, pair: bm.pair_address }], false);
    }
    return bm;
  }
  async function touchFirstBuy() {
    if (P.firstBuyAt) return;
    P.firstBuyAt = new Date().toISOString();
    const bm = await ensureMarketBenchmark();
    if (bm) {
      let px = bm.price_usd;
      if (bm.chain === "binance" && window.MCE.live) {
        const m = window.MCE.live.getMark("binance", bm.pair_address);
        if (m && m.price > 0) px = m.price;
      } else {
        const sl = liveInfo(bm.chain, bm.pair_address);
        if (sl.state === "live") px = sl.price;
      }
      const locked = { chain: bm.chain, pair: bm.pair_address, price: px, symbol: bm.key || "BTC" };
      P.bmAtFirstBuy = locked;
      // Keep legacy field so old localStorage still renders
      P.solAtFirstBuy = locked;
    }
  }

  /** Generic dialog. opts: {modePicker, defaultMode, levDefault, preview(amt, {mode, lev})} → {amt, mode, lev} | null */
  function disposeTradeOrb() {
    const wrap = $("tradeOrb");
    if (!wrap) return;
    if (window.MCE && window.MCE.coin3d && window.MCE.coin3d.dispose) {
      const host = wrap.querySelector(".coin3d-host") || wrap;
      window.MCE.coin3d.dispose(host);
    }
    wrap.textContent = "";
    wrap.hidden = true;
  }
  function paintTradeOrb(symbol) {
    const wrap = $("tradeOrb");
    if (!wrap) return;
    const base = String(symbol || "").replace(/USDT$/i, "").toUpperCase();
    if (!base) { disposeTradeOrb(); return; }
    wrap.hidden = false;
    const c3 = window.MCE && window.MCE.coin3d;
    if (c3 && c3.mount) {
      let host = wrap.querySelector(".coin3d-host");
      if (!host) {
        wrap.textContent = "";
        host = document.createElement("div");
        host.className = "coin3d-host";
        host.setAttribute("aria-hidden", "true");
        wrap.append(host);
      }
      c3.mount(host, { base, size: 56 }).catch(() => {});
      return;
    }
    wrap.textContent = "";
    if (window.MCE && window.MCE.buildCoinOrb) wrap.append(window.MCE.buildCoinOrb(base, 56));
  }
  /** Order sheet (buy / sell / close). Minimal: title, one info line, mode seg, amount + % chips, one preview line,
   *  one exit line. opts.onAllin → shows 「孤注一擲」 which resolves { allin: true }. */
  function askTrade({ title, info, label, value, quick = [], preview, okLabel, modePicker = false, defaultMode = "spot", levDefault = null, callout = null, symbol = null, exitGuide = null, onAllin = null, minAmt = 0, maxAmt = Infinity }) {
    return new Promise((resolve) => {
      const dlg = $("tradeDlg"), inp = $("tradeAmt");
      let mode = defaultMode;
      let lev = levDefault != null ? levDefault : risk().defaultLev;
      if (mode === "lev" && !risk().allowLev) mode = "spot";
      lev = Math.min(lev, risk().maxLev);

      paintTradeOrb(symbol);
      $("tradeTitle").textContent = title;
      $("tradeInfo").textContent = info;
      paintTradeExitGuide(typeof exitGuide === "function" ? exitGuide(parseFloat(value) || 0, { mode, lev }) : exitGuide);
      $("tradeAmtLabel").textContent = label;
      $("tradeModeRow").hidden = !modePicker;
      const trr = $("tradeRiskRow"); if (trr) trr.hidden = true;
      setRisk(riskId);
      rebuildLevPresets(lev);
      const allinB = $("tradeAllin");
      if (allinB) { allinB.hidden = !onAllin; allinB.onclick = onAllin ? () => done({ allin: true }) : null; }
      const co = $("tradeCallout");
      const paintCallout = (text, hot) => {
        if (!text) { co.hidden = true; co.textContent = ""; return; }
        co.hidden = false; co.className = "risk-callout" + (hot ? " hot" : ""); co.textContent = text;
      };
      const paintModeCards = () => {
        document.querySelectorAll("#tradeModeRow .mode-card").forEach((b) => b.classList.toggle("active", b.dataset.trademode === mode));
        $("tradeLevRow").hidden = mode !== "lev";
        $("tradeAmtLabel").textContent = mode === "lev" ? "保證金 (USD)" : label;
        const ok = $("tradeOk");
        if (ok) { ok.classList.toggle("lev-ok", mode === "lev"); ok.textContent = mode === "lev" ? "開 " + lev + "x" : (okLabel || "確認"); }
      };
      document.querySelectorAll("#tradeModeRow .mode-card").forEach((b) => {
        b.onclick = () => { mode = b.dataset.trademode; paintModeCards(); upd(); };
      });
      $("tradeLev").onchange = () => { lev = parseInt($("tradeLev").value, 10) || risk().defaultLev; paintModeCards(); upd(); };
      inp.value = value;
      const q = $("tradeQuick"); q.textContent = "";
      const chips = [];
      for (const [t, v] of quick) {
        const b = el("button", { type: "button", class: "chip pct-chip", onclick: () => { inp.value = typeof v === "function" ? v({ mode, lev }) : v; upd(); } }, t);
        b._v = v; chips.push(b); q.append(b);
      }
      const upd = () => {
        lev = Math.min(parseInt($("tradeLev").value, 10) || risk().defaultLev, risk().maxLev);
        $("tradeLev").value = String(lev);
        const amt = parseFloat(inp.value) || 0;
        for (const b of chips) { const v = typeof b._v === "function" ? b._v({ mode, lev }) : b._v; b.classList.toggle("active", Math.abs((parseFloat(v) || 0) - amt) < 0.005 && amt > 0); }
        $("tradePreview").textContent = preview(amt, { mode, lev });
        if (typeof exitGuide === "function") paintTradeExitGuide(exitGuide(amt, { mode, lev }));
        if (typeof callout === "function") paintCallout(...(callout(amt, { mode, lev }) || [null, false]));
        else paintCallout(null, false);
        const ok = $("tradeOk"); if (ok) ok.disabled = !(amt > minAmt) || amt > maxAmt + 1e-9;
      };
      paintModeCards();
      inp.oninput = upd; upd();
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        dlg.onclose = null;
        try { dlg.close(); } catch (_) {}
        disposeTradeOrb();
        paintTradeExitGuide(null);
        $("tradeForm").onsubmit = null; $("tradeCancel").onclick = null;
        if (allinB) allinB.onclick = null;
        resolve(v);
      };
      $("tradeForm").onsubmit = (ev) => {
        ev.preventDefault();
        const amt = parseFloat(inp.value);
        if (!(amt > minAmt) || amt > maxAmt + 1e-9) return;
        const L = Math.min(parseInt($("tradeLev").value, 10) || risk().defaultLev, risk().maxLev);
        if (mode === "lev" && L >= 20) {
          if (!confirm(`${L}x：跌 ${(LIQ_MARGIN_FRAC / L * 100).toFixed(1)}% 就爆倉。繼續？`)) return;
        }
        done({ amt, mode, lev: L });
      };
      $("tradeCancel").onclick = () => done(null);
      dlg.onclose = () => done(null);
      dlg.showModal();
      try { inp.focus({ preventScroll: true }); } catch (_) {}
    });
  }

  async function doBuySpot(info, li, usd, { allowAllin = false } = {}) {
    pfSyncFromStorage();
    if (allinActive() && !allowAllin) assertNotAllin("加倉");
    if (!(li && li.price > 0)) throw new Error("暫時攞唔到報價");
    usd = Math.min(usd, P.cash);
    if (P.cash - usd < 0.01) usd = P.cash; // 全倉: spend the cents too
    if (!(usd > 0)) throw new Error("模擬現金唔夠");
    await touchFirstBuy();
    const fee = calc.spotBuy(usd, li.price).fee;
    const imp = li.source === "binance" ? { impactPct: 0 } : estimateImpact(usd, li.liq || 0);
    const fillPx = buyFillPx(li, usd); // buy worse (same fn as the buy window)
    const qty = (usd - fee) / fillPx;
    const k = posKey(info.chain, info.pair);
    const pos = P.positions[k] || { chain: info.chain, pair: info.pair, token: info.token, symbol: info.symbol, name: info.name, qty: 0, cost: 0, source: info.source || (info.chain === "binance" ? "binance" : "dex") };
    if (!pos.openedAt) {
      pos.openedAt = new Date().toISOString();
      Object.assign(pos, lockExitMetaForInfo(info));
    }
    if (!(pos.fillNotional > 0)) pos.fillNotional = pos.qty > 0 ? pos.cost : 0; // legacy: cost basis
    pos.fillNotional += qty * fillPx;
    pos.qty += qty; pos.cost += usd; pos.source = pos.source || info.source || (info.chain === "binance" ? "binance" : "dex"); P.positions[k] = pos; P.cash -= usd;
    P.trades.unshift({ t: new Date().toISOString(), kind: "spot", side: "BUY", chain: info.chain, pair: info.pair, symbol: info.symbol, price: fillPx, qty, usd, fee, pnl: null, leverage: null, impactPct: imp.impactPct });
    pf.save(P);
  }

  async function doOpenLev(info, li, margin, leverage, { allowAllin = false } = {}) {
    pfSyncFromStorage();
    if (allinActive() && !allowAllin) assertNotAllin("開槓桿");
    if (!(li && li.price > 0)) throw new Error("暫時攞唔到報價");
    leverage = Math.min(50, Math.max(2, leverage || risk().defaultLev));
    const notional = margin * leverage;
    const fee = calc.levOpen(margin, leverage, li.price).openFee;
    const imp = li.source === "binance" ? { impactPct: 0 } : estimateImpact(notional, li.liq || 0);
    if (margin + fee > P.cash + 1e-9) throw new Error(`現金唔夠：要保證金 ${money2(margin)} + 開倉費 ${money2(fee)}`);
    if (!(margin > 0)) throw new Error("保證金要大於 0");
    await touchFirstBuy();
    const fillPx = buyFillPx(li, notional);
    const qty = notional / fillPx;
    const id = levKey();
    const exitLock = lockExitMetaForInfo(info);
    P.levPositions[id] = {
      id, chain: info.chain, pair: info.pair, token: info.token, symbol: info.symbol, name: info.name,
      side: "long", leverage, margin, notional, entry: fillPx, qty, openFee: fee, openedAt: new Date().toISOString(), impactPct: imp.impactPct,
      ...exitLock,
    };
    P.cash -= margin + fee;
    if (Math.abs(P.cash) < 1e-6) P.cash = 0; // all-in: float dust
    P.trades.unshift({ t: new Date().toISOString(), kind: "lev", side: "OPEN", chain: info.chain, pair: info.pair, symbol: info.symbol, price: fillPx, qty, usd: margin, fee, pnl: null, leverage, notional, impactPct: imp.impactPct });
    pf.save(P);
    return id;
  }


  // ---------- 孤注一擲 ----------
  const ALLIN_ROUNDS_KEY = "mce:allin:rounds:v1";
  function loadAllinRounds() { try { return JSON.parse(localStorage.getItem(ALLIN_ROUNDS_KEY) || "[]"); } catch { return []; } }
  function saveAllinRound(r) {
    const list = loadAllinRounds(); list.unshift(r); localStorage.setItem(ALLIN_ROUNDS_KEY, JSON.stringify(list.slice(0, 50)));
  }
  function allinActive() { return !!(P.allin && P.allin.status === "open"); }
  function assertNotAllin(action) {
    if (allinActive()) throw new Error("孤注一擲進行中，唔可以" + action + "。請先平倉或重置。");
  }

  /** 孤注一擲 preview grid = open at price0 then CLOSE at each price, through calc.* (same maths as executeAllin + 平倉).
   *  val = cash you'd hold after closing (incl. leftover cents); ret = val / cash − 1. */
  function allinScenarioHTML(mode, cash, price0, lev) {
    const rows = [];
    if (mode === "spot") {
      const b = calc.spotBuy(cash, price0);
      for (const m of [0, 0.5, 1, 2, 5, 10]) {
        const val = calc.spotSell(b.qty, price0 * m).proceeds;
        rows.push({ label: m === 0 ? "歸零" : m === 0.5 ? "跌一半" : m === 1 ? "不變" : `×${m}`, mult: m, val, ret: (val / cash - 1) * 100 });
      }
    } else {
      const margin = calc.allinMargin(cash, lev);
      const pos = calc.levOpen(margin, lev, price0);
      const left = cash - margin - pos.openFee;
      const lp = liqPriceLong(price0, lev);
      rows.push({ label: "爆倉", mult: null, val: left, ret: (left / cash - 1) * 100, note: `價 ≤ ${price(lp)}（跌約 ${(LIQ_MARGIN_FRAC / lev * 100).toFixed(1)}%）` });
      for (const m of [1, 2, 5, 10]) {
        const c = calc.levClose(pos, price0 * m);
        const val = left + c.back;
        rows.push({ label: m === 1 ? "不變" : `×${m}`, mult: m, val, ret: (val / cash - 1) * 100 });
      }
    }
    return rows;
  }

  function renderAllinScenarios(mode, cash, px, lev) {
    const box = $("allinScenarios"); box.textContent = "";
    const table = el("div", { class: "allin-scen-grid" });
    for (const r of allinScenarioHTML(mode, cash, px, lev)) {
      table.append(el("div", { class: "allin-scen " + cls(r.ret) },
        el("div", { class: "k", text: r.label }),
        el("div", { class: "v", text: money2(r.val) }),
        el("div", { class: "s", text: pct(r.ret) + (r.note ? " · " + r.note : "") })));
    }
    box.append(table);
  }

  /** BUG FIX (ux-fix): picker used to list only picks.json coins (no search; ANIME / 急升 coins unreachable).
   *  Now = every TRADING Binance USDT coin, searchable, 🔥 / 持 / AI first. */
  async function pickAllinCoin() {
    if (!window.MCE.market) return null;
    return window.MCE.market.pickCoin({ title: "孤注一擲 · 揀幣" });
  }

  async function openAllinFlow(preselected) {
    try {
      if (allinActive()) { toast("已經有一鋪進行中"); goView("portfolio"); return; }
      // clear other positions? User should start clean — warn if has positions
      pfSyncFromStorage();
      if (Object.keys(P.positions).length || Object.keys(P.levPositions).length) {
        if (!confirm("孤注一擲要空倉：重置模擬倉（清晒持倉，現金返到起始資金）再開始？")) return;
        const fee = P.feePct, start = P.start; P = pf.fresh(start); P.feePct = fee; pf.save(P);
      }
      const info = withCoinExit(preselected || await pickAllinCoin());
      if (!info) return;
      const li = await livePrice(info.chain, info.pair);
      let mode = "spot";
      const cash = P.cash;
      if ($("allinTitle")) $("allinTitle").textContent = `孤注一擲 ${info.symbol}`;
      $("allinInfo").textContent = `${price(li.price)} · 現金 ${money2(cash)}`;
      const allinPlan = exitPlanFromEntry(Object.assign({}, lockExitMetaForInfo(info), { created_at: new Date().toISOString(), entry_snapshot: info.entry_snapshot }));
      const paintExit = (lev) => {
        const n = $("allinExit"); if (!n) return;
        const g = exitGuideCopy(allinPlan, li.price, li.price, lev);
        if (g) withStopLoss(g, lev > 1 ? stopLossUsd("lev", { margin: calc.allinMargin(cash, lev), lev, entry: li.price }, g.stopPx) : stopLossUsd("spot", { usd: cash, entry: li.price }, g.stopPx));
        const tgt = g && g.momentum && g.target2Px ? `${price(g.targetPx)}／${price(g.target2Px)}` : g ? price(g.targetPx) : "";
        n.textContent = g ? (lev > 1 ? `爆 ${price(g.liqPx)} · ` : "") + `🎯 ${tgt}` + (g.untilText ? ` · ${g.untilText}` : "") + `\n止蝕 ${g.stop}` + (g.levStopAdj ? `\n${LEV_STOP_NOTE}` : "") : "";
        n.dataset.stop = g ? String(g.stopPx) : ""; n.dataset.loss = g && g.lossUsd != null ? String(g.lossUsd) : ""; n.dataset.liq = g && g.liqPx ? String(g.liqPx) : ""; n.dataset.basis = String(li.price);
      };
      const paint = () => {
        document.querySelectorAll("#allinModeSeg .segbtn").forEach((b) => b.classList.toggle("active", b.dataset.allinmode === mode));
        if (mode === "spot") {
          $("allinCallout").textContent = `用晒 ${money2(cash)} 買 ${info.symbol} · 歸零就輸晒`;
          renderAllinScenarios("spot", cash, li.price, 50);
          paintExit(null);
        } else {
          const lev = 50;
          const notional = calc.levOpen(calc.allinMargin(cash, lev), lev, li.price).notional;
          const drop = LIQ_MARGIN_FRAC / lev * 100;
          $("allinCallout").textContent = `${lev}x · 名義 ${money2(notional)} · 跌 ${drop.toFixed(1)}% 就爆倉`;
          renderAllinScenarios("lev", cash, li.price, lev);
          paintExit(lev);
        }
      };
      document.querySelectorAll("#allinModeSeg .segbtn").forEach((b) => {
        b.onclick = () => { mode = b.dataset.allinmode; paint(); };
      });
      paint();
      const dlg = $("allinDlg");
      await new Promise((resolve) => {
        const done = (ok) => { dlg.close(); $("allinForm").onsubmit = null; $("allinCancel").onclick = null; resolve(ok); };
        $("allinForm").onsubmit = (ev) => { ev.preventDefault(); done(true); };
        $("allinCancel").onclick = () => done(false);
        dlg.onclose = () => resolve(false);
        dlg.showModal();
      }).then(async (ok) => {
        if (!ok) return;
        await executeAllin(info, li, mode);
      });
    } catch (e) { alert(e.message); }
  }

  async function executeAllin(info, li, mode) {
    const cashBefore = P.cash;
    await touchFirstBuy();
    if (mode === "spot") {
      const usd = P.cash;
      if (!(usd > 1)) throw new Error("現金唔夠");
      await doBuySpot(info, li, usd, { allowAllin: true });
      const k = posKey(info.chain, info.pair);
      P.allin = { status: "open", mode: "spot", symbol: info.symbol, name: info.name, chain: info.chain, pair: info.pair, token: info.token,
        key: k, entry: buyFillPx(li, usd), startedAt: new Date().toISOString(), cashBefore, leverage: null };
    } else {
      const lev = 50;
      // use max margin such that margin + notional*fee <= cash
      const margin = calc.allinMargin(P.cash, lev);
      if (!(margin > 1)) throw new Error("現金唔夠開槓桿");
      const id = await doOpenLev(info, li, margin, lev, { allowAllin: true });
      P.allin = { status: "open", mode: "lev", symbol: info.symbol, name: info.name, chain: info.chain, pair: info.pair, token: info.token,
        key: id, entry: li.price, startedAt: new Date().toISOString(), cashBefore, leverage: lev };
    }
    pf.save(P);
    const modeLabel = mode === "lev" ? "50x 槓桿" : "現貨全倉";
    await playOverlay({
      emoji: mode === "lev" ? "×" : "★",
      title: "孤注一擲！",
      sub: "一舖過",
      coin: `$${info.symbol} · ${modeLabel}`,
      kind: "",
      ms: 1600,
    });
    toast(`孤注一擲已開始：$${info.symbol}（${mode === "lev" ? "50x" : "現貨"}）`);
    ensureLiveLoop(true);
    goView("portfolio");
    await renderPortfolio(true);
    const ban = $("allinBanner");
    if (ban && !reduceMotion()) { ban.classList.remove("slam"); void ban.offsetWidth; ban.classList.add("slam"); }
    _lastAllinPct = null;
  }

  async function endAllinRound({ reason, exitPrice, retPct, pnl }) {
    if (!P.allin) return;
    const a = P.allin;
    saveAllinRound({
      t: new Date().toISOString(), symbol: a.symbol, mode: a.mode, leverage: a.leverage,
      entry: a.entry, exit: exitPrice, returnPct: retPct, pnl, reason, cashBefore: a.cashBefore,
    });
    P.allin = { ...a, status: "closed", closedAt: new Date().toISOString(), exitPrice, retPct, pnl, reason };
    pf.save(P);
    showAllinResult(P.allin);
  }

  function showAllinResult(a) {
    const box = $("allinResult"), body = $("allinResultBody");
    if (!box) return;
    box.hidden = false;
    $("allinBanner").hidden = true;
    const bust = (a.retPct || 0) <= -99.5 || a.reason === "爆倉";
    const win = (a.retPct || 0) > 0;
    box.classList.remove("show-anim", "bust-theme", "win-theme");
    void box.offsetWidth;
    box.classList.add("show-anim"); // BUG FIX (ux-fix): add("") threw on a flat/losing round → close looked broken
    if (bust || win) box.classList.add(bust ? "bust-theme" : "win-theme");
    body.textContent = "";
    body.append(
      el("div", { class: "allin-title", text: bust ? "爆倉／歸零" : win ? "今鋪贏咗" : "今鋪完結" }),
      el("div", { class: "allin-result-pct " + cls(a.retPct), text: pct(a.retPct) }),
      el("p", { text: `$${a.symbol} · ${a.mode === "lev" ? (a.leverage || 50) + "x 槓桿" : "現貨"} · ${a.reason || ""}` }),
      el("p", { class: "muted", text: `入場 ${price(a.entry)} → 出場 ${price(a.exitPrice)} · 盈虧 ${money2(a.pnl)}` })
    );
    // Fire-and-forget dramatic overlay
    playOverlay({
      emoji: bust ? "💀" : win ? "🤑" : "🎲",
      title: bust ? "爆倉！" : win ? "贏咗！" : "完場",
      sub: bust ? "歸零 · 假錢唔使喊" : win ? "假錢勝利" : "再嚟？",
      coin: pct(a.retPct) + " · $" + a.symbol,
      kind: bust ? "bust" : win ? "win" : "",
      ms: bust ? 1700 : 1400,
    });
  }

  async function closeAllinFromBanner({ markPrice = null } = {}) {
    if (!allinActive()) return;
    const priceAt = async (chain, pair) => (markPrice > 0 ? { price: markPrice, source: "binance" } : livePrice(chain, pair));
    const a = P.allin;
    try {
      if (a.mode === "spot") {
        const k = a.key;
        if (!P.positions[k]) { // already gone
          await endAllinRound({ reason: "已無持倉", exitPrice: a.entry, retPct: -100, pnl: -a.cashBefore });
          renderPortfolio(false); return;
        }
        const li = await priceAt(a.chain, a.pair).catch(() => ({ price: 0, writeoff: true }));
        const pos = P.positions[k];
        const { fee, proceeds } = calc.spotSell(pos.qty, li.price);
        const pnl = proceeds - pos.cost;
        // BUG FIX (ux-fix): result % ignored leftover cash → equity after / equity before.
        const retPct = a.cashBefore ? ((P.cash + proceeds) / a.cashBefore - 1) * 100 : (pnl / pos.cost) * 100;
        P.cash += proceeds; P.realizedSpot += pnl;
        delete P.positions[k];
        P.trades.unshift({ t: new Date().toISOString(), kind: "spot", side: "SELL", chain: a.chain, pair: a.pair, symbol: a.symbol, price: li.price, qty: pos.qty, usd: proceeds, fee, pnl, leverage: null });
        pf.save(P);
        await endAllinRound({ reason: "手動平倉", exitPrice: li.price, retPct, pnl });
      } else {
        const id = a.key;
        if (!P.levPositions[id]) {
          // maybe liquidated already — find last trade
          const last = P.trades.find((t) => t.symbol === a.symbol && t.side === "LIQUIDATE");
          const lost = last && last.pnl != null ? last.pnl : -(a.cashBefore || 0);
          await endAllinRound({ reason: "爆倉", exitPrice: last?.price ?? 0, retPct: a.cashBefore ? (P.cash / a.cashBefore - 1) * 100 : -100, pnl: lost });
          renderPortfolio(false); return;
        }
        const pos = P.levPositions[id];
        const li = await priceAt(pos.chain, pos.pair);
        const m = levMark(pos, li.price);
        if (m.dead) {
          await closeLev(id, { forceLiq: true, markPrice: li.price });
          await endAllinRound({ reason: "爆倉", exitPrice: li.price, retPct: a.cashBefore ? (P.cash / a.cashBefore - 1) * 100 : -100, pnl: -pos.margin - (pos.openFee || 0) });
        } else {
          const { closeFee, back, pnl } = calc.levClose(pos, li.price);
          const retPct = a.cashBefore ? ((P.cash + back) / a.cashBefore - 1) * 100 : (pnl / pos.margin) * 100;
          // use closeLev path manually to avoid double dialog
          P.cash += back; P.realizedLev += pnl;
          P.trades.unshift({ t: new Date().toISOString(), kind: "lev", side: "CLOSE", chain: pos.chain, pair: pos.pair, symbol: pos.symbol, price: li.price, qty: pos.qty, usd: back, fee: closeFee, pnl, leverage: pos.leverage, notional: pos.notional });
          delete P.levPositions[id];
          pf.save(P);
          await endAllinRound({ reason: "手動平倉", exitPrice: li.price, retPct, pnl });
        }
      }
      renderPortfolio(false);
    } catch (e) { alert(e.message); }
  }

  function againAllin() {
    $("allinResult").hidden = true;
    const fee = P.feePct, start = P.start;
    P = pf.fresh(start); P.feePct = fee; pf.save(P);
    openAllinFlow();
  }

  function renderAllinChrome(spotValue, levEquity) {
    const ban = $("allinBanner"), res = $("allinResult"), entry = $("allinEntryBar");
    if (!ban) return;
    if (P.allin && P.allin.status === "closed") {
      ban.hidden = true; if (res && res.hidden) showAllinResult(P.allin);
      if (entry) entry.hidden = true;
      return;
    }
    if (res) res.hidden = !(P.allin && P.allin.status === "closed");
    if (!allinActive()) {
      ban.hidden = true;
      if (entry) entry.hidden = false;
      return;
    }
    if (entry) entry.hidden = true;
    ban.hidden = false;
    const a = P.allin;
    // Same numbers as the position row (same mark choice, same formula): value + P&L of THE position; cash separate.
    let livePct = null, value = null, pnl = null, extra = "", exitG = null;
    const markOf = (pos) => { const li = liveInfo(a.chain, a.pair); return li.state === "live" ? li.price : li.state === "dead" ? 0 : knownPx(pos); };
    if (a.mode === "spot") {
      const pos = P.positions[a.key];
      if (pos) {
        const px = markOf(pos);
        exitG = exitGuideCopy(exitPlanForPosition(pos), posBasisPx(pos), px, null);
        if (px != null) { value = pos.qty * px; pnl = value - pos.cost; livePct = pos.cost ? (value / pos.cost - 1) * 100 : null; extra = `標記 ${price(px)}`; }
      }
    } else {
      const pos = P.levPositions[a.key];
      if (pos) {
        const px = markOf(pos);
        exitG = exitGuideCopy(exitPlanForPosition(pos), posBasisPx(pos), px, pos.leverage);
        if (px != null) {
          const op = calc.levOpenPnl(pos, px);
          value = op.value; pnl = op.pnl; livePct = op.pct;
          const toLiq = px ? (px - liqPriceLong(pos.entry, pos.leverage)) / px * 100 : -100;
          extra = `距爆倉 ${toLiq.toFixed(2)}% · ${pos.leverage}x`;
        }
      } else {
        extra = "可能已爆倉";
      }
    }
    const live = $("allinLive");
    live.textContent = "";
    live.append(
      el("div", {}, el("b", { text: "$" + a.symbol }), " · ", a.mode === "lev" ? (a.leverage || 50) + "x" : "現貨"),
      el("div", { class: cls(pnl), "data-allin": "pnl" }, "盈虧 ", pnl == null ? "…" : `${pnl >= 0 ? "+" : ""}${money2(pnl)} · ${pct(livePct)}`),
      el("div", { "data-allin": "value", text: "倉值 " + (value == null ? "…" : money2(value)) }),
      exitG ? el("div", { class: "allin-exit-line", "data-allin": "exit", "data-stop": String(exitG.stopPx), text: `🎯 ${price(exitG.targetPx)} · 止 ${price(exitG.stopPx)}` + (exitG.levStopAdj ? "（槓桿）" : "") }) : "",
      exitG && exitG.stopHit ? el("div", { class: "stop-hit-txt", "data-allin": "stophit", text: STOP_HIT_TXT }) : "",
      el("div", { class: "muted", text: `入場 ${price(a.entry)} · ${extra}` + (P.cash >= 0.01 ? ` · 現金 ${money2(P.cash)}` : "") })
    );
    if (livePct != null) flashAllinPnl(livePct);
  }

  async function openBuy(info) {
    info = withCoinExit(info);
    const fillGen = navGen;
    try {
      if (allinActive()) { toast("孤注一擲進行中，請先平倉"); goView("portfolio"); return; }
      // BUG FIX (ux-fix): after one 孤注一擲 the risk profile stuck on "allin" and EVERY later 買 was hijacked
      // into the all-in reset flow. 孤注一擲 now has its own buttons; 買 always opens the order sheet.
      const li = await livePrice(info.chain, info.pair);
      const defMode = riskId === "safe" ? "spot" : "spot";
      const liqNote = info.chain === "binance" || li.source === "binance"
        ? "來源 Binance 即時"
        : `流動性 ${money(li.liq)}`;
      // ROOT-CAUSE FIX (20261025c1): the window used the PICK's entry_price_usd (e.g. WLD $0.5484 → +8% = $0.5923)
      // while the position's exit block uses the actual fill price. Now both use the fill price + the same plan.
      const lockNow = new Date().toISOString();
      const spotKey = posKey(info.chain, info.pair);
      const buyExitGuide = (amt, { mode, lev } = {}) => {
        if (mode === "lev") {
          const fill = buyFillPx(li, (amt || 0) * (lev || 1));
          const gl = exitGuideCopy(exitPlanFromEntry(Object.assign({}, lockExitMetaForInfo(info), { created_at: lockNow, entry_snapshot: info.entry_snapshot })), fill, li.price, lev || 1);
          return gl ? withStopLoss(gl, stopLossUsd("lev", { margin: amt || 0, lev: lev || 1, entry: fill }, gl.stopPx)) : gl;
        }
        const fill = buyFillPx(li, amt || 0);
        const ex = P.positions[spotKey];
        if (ex && ex.qty > 0 && ex.openedAt) { // adding: blended basis, keeps the position's locked plan
          const qty = Math.max(0, (amt || 0) - (amt || 0) * P.feePct / 100) / fill;
          const fillNotional = (ex.fillNotional > 0 ? ex.fillNotional : ex.cost) + qty * fill;
          const merged = Object.assign({}, ex, { fillNotional, qty: ex.qty + qty });
          const gm = exitGuideCopy(exitPlanForPositionNoSave(merged), posBasisPx(merged), li.price);
          return gm ? withStopLoss(gm, stopLossUsd("spot", { pos: { qty: merged.qty, cost: (ex.cost || 0) + (amt || 0) } }, gm.stopPx)) : gm;
        }
        const gs = exitGuideCopy(exitPlanFromEntry(Object.assign({}, lockExitMetaForInfo(info), { created_at: lockNow, entry_snapshot: info.entry_snapshot })), fill, li.price);
        return gs ? withStopLoss(gs, stopLossUsd("spot", { usd: amt || 0, entry: fill }, gs.stopPx)) : gs;
      };
      const cash0 = P.cash;
      const pctAmt = (f) => ({ mode, lev }) => {
        if (mode === "lev") { const m = cash0 * f / (1 + (lev || 1) * levFeePct() / 100); return Math.floor(m * 100) / 100; }
        return f >= 1 ? Math.floor(cash0 * 100) / 100 : Math.floor(cash0 * f * 100) / 100;
      };
      const chg = window.MCE.live && window.MCE.live.board && window.MCE.live.board.get(info.pair);
      const chgTxt = chg && chg.chg24 != null ? " " + pct(chg.chg24) : "";
      const res = await askTrade({
        title: `買 ${info.symbol}` + (info.exitRegime === "momentum" ? " 🔥" : ""),
        info: `${price(li.price)}${chgTxt} · 現金 ${money2(cash0)}`,
        label: "金額 (USD)",
        value: Math.min(Math.max(100, Math.round(cash0 * 0.1 * (info.sizeMult > 0 ? info.sizeMult : 1))), Math.floor(cash0 * 100) / 100),
        quick: [["25%", pctAmt(0.25)], ["50%", pctAmt(0.5)], ["75%", pctAmt(0.75)], ["全倉", pctAmt(1)]],
        modePicker: !info.forceSpot, defaultMode: "spot", levDefault: risk().defaultLev,
        symbol: info.symbol,
        exitGuide: buyExitGuide,
        maxAmt: cash0,
        preview: (v, { mode, lev }) => {
          if (!(v > 0)) return "";
          if (mode === "lev") {
            const o = calc.levOpen(v, lev, li.price);
            return `名義 ${money2(o.notional)} · 費 ${levFeePct()}% ${money2(o.openFee)} · 爆倉 ${price(liqPriceLong(li.price, lev))}`;
          }
          const b = calc.spotBuy(v, buyFillPx(li, v));
          return `≈ ${fmtQty(b.qty)} ${info.symbol} · 費 ${P.feePct}% ${money2(b.fee)}`;
        },
        callout: (v, { mode, lev }) => {
          if (mode !== "lev" || !(v > 0)) return [null, false];
          if (v * (1 + lev * levFeePct() / 100) > cash0 + 1e-9) return ["現金唔夠（保證金 + 開倉費）", true];
          return lev >= 10 ? [`跌 ${(LIQ_MARGIN_FRAC / lev * 100).toFixed(1)}% 就爆倉`, true] : [null, false];
        },
        okLabel: "買入",
        onAllin: true,
      });
      if (!res) return;
      if (res.allin) { await openAllinFlow(info); return; }
      if (res.mode === "lev") {
        await doOpenLev(info, li, res.amt, res.lev);
        toast(`已開 ${res.lev}x ${info.symbol} · ${money2(res.amt)}`, "lev");
        floatPop((res.lev || "") + "x"); pfMode = "lev";
      } else {
        await doBuySpot(info, li, res.amt);
        if (info.onFilled) { try { info.onFilled(res); } catch (_) {} }
        toast(`已買 ${info.symbol} · ${money2(res.amt)}`, "ok");
        floatPop("✓"); pfMode = "spot";
      }
      ensureLiveLoop(true);
      await renderPortfolio(true);
      if (navGen !== fillGen) {
        // User already left during price/dialog awaits — do not yank back
        return;
      }
      afterFillUX({ mode: res.mode, symbol: info.symbol });
    } catch (e) { alert(e.message); }
  }

  async function openSell(k, presetPct = null) {
    pfSyncFromStorage();
    const pos = P.positions[k]; if (!pos) return;
    if (allinActive()) {
      if (P.allin.mode === "spot" && P.allin.key === k) return closeAllinFromBanner();
      return alert("孤注一擲進行中，請用上方平倉");
    }
    try {
      const li = await livePrice(pos.chain, pos.pair).catch((e) => { if (confirm(e.message + "。要以 $0 銷帳嗎？")) return { price: 0, liq: 0, writeoff: true }; throw e; });
      const basis = posBasisPx(pos);
      const pctSell = li.writeoff ? 100 : (await askTrade({
        title: `賣 ${pos.symbol}`,
        info: `${price(li.price)} · 持有 ${fmtQty(pos.qty)}` + (basis > 0 ? ` · ${pct((li.price / basis - 1) * 100)}` : ""),
        label: "賣出比例 %", value: presetPct || 100, quick: [["25%", 25], ["50%", 50], ["100%", 100]],
        modePicker: false, symbol: pos.symbol, minAmt: 0, maxAmt: 100,
        preview: (v) => {
          const f = Math.min(100, Math.max(0, v)) / 100, sl = calc.spotSell(pos.qty * f, li.price);
          const pnl = sl.proceeds - pos.cost * f;
          return `收 ${money2(sl.proceeds)} · 費 ${P.feePct}% ${money2(sl.fee)} · 盈虧 ${pnl >= 0 ? "+" : ""}${money2(pnl)}`;
        },
        okLabel: "賣出",
      }))?.amt;
      if (pctSell == null) return;
      pfSyncFromStorage();
      const cur = P.positions[k]; if (!cur) return;
      let f = Math.min(100, Math.max(0, pctSell)) / 100;
      if (!(f > 0)) return;
      // BUG FIX (ux-fix): a partial sell that leaves < $0.01 (or < 0.01% of qty) left an undeletable dust row.
      if (f < 1 && (cur.qty * (1 - f) * (li.price || 0) < DUST_USD || f > 0.9999)) f = 1;
      const qty = f >= 1 ? cur.qty : cur.qty * f, { gross, fee, proceeds } = calc.spotSell(qty, li.price);
      const costPart = f >= 1 ? cur.cost : cur.cost * f, pnl = proceeds - costPart;
      if (f >= 1) delete P.positions[k];
      else { cur.qty -= qty; cur.cost -= costPart; if (cur.fillNotional > 0) cur.fillNotional *= (1 - f); }
      P.cash += proceeds; P.realizedSpot += pnl;
      P.trades.unshift({ t: new Date().toISOString(), kind: "spot", side: li.writeoff ? "WRITE-OFF" : "SELL", chain: cur.chain, pair: cur.pair, symbol: cur.symbol, price: li.price, qty, usd: proceeds, fee, pnl, leverage: null });
      pf.save(P); toast(`已賣 ${Math.round(f * 100)}% ${cur.symbol} · ${pnl >= 0 ? "+" : ""}${money2(pnl)}`); renderPortfolio(false);
    } catch (e) { alert(e.message); }
  }

  async function closeLev(id, { forceLiq = false, markPrice = null } = {}) {
    if (!forceLiq) pfSyncFromStorage();
    const pos = P.levPositions[id]; if (!pos) return;
    if (allinActive() && !forceLiq) {
      if (P.allin.mode === "lev" && P.allin.key === id) return closeAllinFromBanner();
      return alert("孤注一擲進行中，請用上方橫幅平倉");
    }
    let mark = markPrice;
    if (mark == null) {
      const li = await livePrice(pos.chain, pos.pair).catch(() => null);
      mark = li ? li.price : pos.entry;
    }
    const m = levMark(pos, mark);
    const cc = calc.levClose(pos, mark, levFeePct(), forceLiq);
    const isLiq = cc.dead;
    if (isLiq) {
      // 保證金歸零，唔退回 cash
      const pnl = -pos.margin - (pos.openFee || 0);
      P.realizedLev += pnl;
      P.liquidations = (P.liquidations || 0) + 1;
      P.trades.unshift({ t: new Date().toISOString(), kind: "lev", side: "LIQUIDATE", chain: pos.chain, pair: pos.pair, symbol: pos.symbol, price: mark, qty: pos.qty, usd: 0, fee: 0, pnl, leverage: pos.leverage, notional: pos.notional });
      delete P.levPositions[id];
      pf.save(P);
      toast(`$${pos.symbol} ${pos.leverage}x 已爆倉，保證金 ${money2(pos.margin)} 歸零`);
      return;
    }
    const res = await askTrade({
      title: `平倉 ${pos.symbol} ${pos.leverage}x`,
      info: `${price(mark)} · 盈虧 ${m.unreal >= 0 ? "+" : ""}${money2(m.unreal)}`,
      label: "平倉 %", value: 100, quick: [["100%", 100]],
      modePicker: false, symbol: pos.symbol, minAmt: 99.99, maxAmt: 100,
      preview: () => `退回 ${money2(cc.back)} · 費 ${money2(cc.closeFee)} · 淨 ${cc.pnl >= 0 ? "+" : ""}${money2(cc.pnl)}`,
      okLabel: "平倉",
    });
    if (!res) return;
    const { closeFee, back, pnl } = cc;
    P.cash += back;
    P.realizedLev += pnl;
    P.trades.unshift({ t: new Date().toISOString(), kind: "lev", side: "CLOSE", chain: pos.chain, pair: pos.pair, symbol: pos.symbol, price: mark, qty: pos.qty, usd: back, fee: closeFee, pnl, leverage: pos.leverage, notional: pos.notional });
    delete P.levPositions[id];
    pf.save(P);
    toast(`已平槓桿 $${pos.symbol}：${money2(pnl)}`);
    renderPortfolio(false);
  }

  /** Check all lev positions against mark; auto-liquidate if needed. */
  function checkLiquidations(priceMap) {
    let n = 0;
    for (const [id, pos] of Object.entries(P.levPositions)) {
      const mark = priceMap[id];
      if (mark == null) continue;
      const m = levMark(pos, mark);
      if (m.dead) {
        const pnl = -pos.margin - (pos.openFee || 0);
        P.realizedLev += pnl;
        P.liquidations = (P.liquidations || 0) + 1;
        P.trades.unshift({ t: new Date().toISOString(), kind: "lev", side: "LIQUIDATE", chain: pos.chain, pair: pos.pair, symbol: pos.symbol, price: mark, qty: pos.qty, usd: 0, fee: 0, pnl, leverage: pos.leverage, notional: pos.notional });
        delete P.levPositions[id];
        n++;
      }
    }
    if (n) pf.save(P);
    return n;
  }

  async function copyPicks() {
    if (allinActive()) return alert("孤注一擲進行中，唔可以跟晒今批");
    if (riskId === "allin") return alert("孤注一擲請撳「孤注一擲」揀一隻幣，唔好用跟晒");
    if (!S.picks) await loadPicks();
    const last = S.picks.batches[S.picks.batches.length - 1];
    const buys = last.entries.filter((e) => e.type === "buy");
    if (!buys.length) return alert("今批冇買入推薦");
    const allowLevCopy = riskId !== "safe";
    const res = await askTrade({
      title: `跟晒今批（${batchLabel(last)} · ${risk().label}）`,
      info: buys.map((b) => "$" + b.symbol).join("、") + ` · 現金 ${money2(P.cash)}` + (allowLevCopy ? " · 可選「槓桿」用細保證金高倍（危險）" : " · 穩陣檔只限現貨"),
      label: "總金額／總保證金 (USD)", value: Math.min(3000, Math.floor(P.cash)),
      quick: [["$500", 500], ["$1k", 1000], ["$3k", 3000], ["$5k", 5000], ["全倉", Math.floor(P.cash)]].map(([t, v]) => [t, Math.min(v, Math.floor(P.cash))]),
      modePicker: allowLevCopy, defaultMode: "spot", levDefault: risk().defaultLev,
      preview: (v, { mode, lev }) => {
        const each = v / buys.length;
        if (mode === "lev") return `每幣保證金 ${money2(each)} · ${lev}x · 名義各 ${money2(each * lev)} · 總名義 ${money2(v * lev)} · 開倉費共約 ${money2(v * lev * levFeePct() / 100)}`;
        return `現貨每幣 ${money2(each)}，每筆扣 ${P.feePct}%`;
      },
      callout: (v, { mode, lev }) => {
        if (mode !== "lev") return [`現貨平均分 ${buys.length} 隻 · 總額 ${money2(v)}`, false];
        const drop = LIQ_MARGIN_FRAC / lev * 100;
        return [`⚠️ 高風險跟倉：${buys.length} 隻各 ${lev}x，任何一隻跌 ~${drop.toFixed(1)}% 就爆該倉保證金`, true];
      },
      okLabel: "確認跟倉",
    });
    if (!res) return;
    if (res.mode === "lev") {
      if (!confirm(`確定用 ${res.lev}x 細保證金跟晒 ${buys.length} 隻？`)) return;
    }
    const each = Math.min(res.amt, P.cash) / buys.length, errs = [];
    for (const b of buys) {
      const info = { chain: b.chain, pair: b.pair_address, token: b.token_address, symbol: b.symbol, name: b.name };
      try {
        const li = await livePrice(info.chain, info.pair);
        if (res.mode === "lev") await doOpenLev(info, li, each, res.lev);
        else await doBuySpot(info, li, each);
      } catch (e) { errs.push(`$${b.symbol}: ${e.message}`); }
    }
    toast(errs.length ? "部分失敗：" + errs.join("；") : `已跟倉 ${buys.length} 隻（${res.mode === "lev" ? res.lev + "x" : "現貨"}）`);
    pfMode = res.mode === "lev" ? "lev" : "spot";
    ensureLiveLoop(true);
    goView("portfolio");
    renderPortfolio(false);
  }

  function posOpenedAt(pos) {
    if (!pos) return null;
    if (pos.openedAt) return pos.openedAt;
    const t = (P.trades || []).find((tr) =>
      (tr.side === "BUY" || tr.side === "OPEN") && tr.pair === pos.pair && tr.chain === pos.chain && tr.symbol === pos.symbol);
    return t ? t.t : null;
  }

  /** Migrate old positions missing exit lock → default normal 24h/+8/−5, persist once. */
  function ensurePosExitLock(pos) {
    if (!pos) return false;
    let changed = false;
    if (!pos.openedAt) {
      const t = posOpenedAt(pos);
      pos.openedAt = t || new Date().toISOString();
      changed = true;
    }
    if (pos.exitRegime !== "weak" && pos.exitRegime !== "normal" && pos.exitRegime !== "momentum") {
      Object.assign(pos, {
        exitRegime: "normal",
        suggested_exit_h: 24,
        suggested_second_h: 72,
        take_profit_pct: 8,
        stop_loss_pct: 5,
      });
      changed = true;
    }
    return changed;
  }

  function exitPlanForPosition(pos) {
    if (ensurePosExitLock(pos)) {
      try { pf.save(P); } catch (_) {}
    }
    return exitPlanForPositionNoSave(pos);
  }
  function exitPlanForPositionNoSave(pos) {
    const opened = pos.openedAt || posOpenedAt(pos);
    const entryPx = posBasisPx(pos);
    return paperExitPlan({
      createdAt: opened,
      momentum: pos.exitRegime === "momentum",
      tp2Pct: pos.take_profit2_pct,
      weak: pos.exitRegime === "weak",
      entryPx,
      tpPct: pos.take_profit_pct,
      slPct: pos.stop_loss_pct,
      reviewH: pos.suggested_exit_h,
      secondH: pos.suggested_second_h,
    });
  }

  /** Last known price when no live mark yet: stale mark → board row → last trade → entry basis. */
  function knownPx(pos) {
    const L = window.MCE.live;
    const m = L && L.getMark(pos.chain, pos.pair); if (m && m.price > 0) return m.price;
    const r = L && L.board && L.board.get(pos.pair); if (r && r.price > 0) return r.price;
    const u = window.MCE.market && window.MCE.market.getRow(pos.pair); if (u && u.price > 0) return u.price;
    const t = (P.trades || []).find((x) => x.pair === pos.pair && x.price > 0); if (t) return t.price;
    return posBasisPx(pos);
  }

  // ---------- compact holdings list (keyed; WS ticks patch text in place so buttons never move under a finger) ----------
  let pfListKey = "";
  function posRowExit(r) {
    const pos = r.pos;
    const plan = exitPlanForPosition(pos);
    const g = exitGuideCopy(plan, posBasisPx(pos), r.px, r.kind === "lev" ? pos.leverage : null);
    // Two short lines, full card width: 「爆 $x · 🎯 $y」 / 「止 $z · 揸到 hh:mm」 (spot: 🎯 / 止 · 揸到)
    if (!g) return { text: "", due: false };
    const shortT = (d) => {
      if (!d) return "";
      const ms = +d, sh = (x) => new Date(x + 8 * 3600e3).toISOString();
      const hm = sh(ms).slice(11, 16), day = sh(ms).slice(0, 10), today = sh(Date.now()).slice(0, 10), tmr = sh(Date.now() + 86400e3).slice(0, 10);
      return day === today ? hm : day === tmr ? "明 " + hm : `${+day.slice(5, 7)}/${+day.slice(8, 10)} ${hm}`;
    };
    const until = plan.pastReview ? "宜決定" : plan.momentum ? `最遲 ${shortT(plan.secondAt || plan.reviewAt)}` : `揸到 ${shortT(plan.reviewAt)}`;
    const tgt = "🎯 " + price(g.targetPx);
    const l1 = r.kind === "lev" && r.px > 0 ? `爆 ${price(liqPriceLong(pos.entry, pos.leverage))} · ${tgt}` : tgt;
    const l2 = g.stopHit ? `止 ${price(g.stopPx)} · ${STOP_HIT_TXT}` : `止 ${price(g.stopPx)} · ${until}`;
    return { text: l1 + "\n" + l2, due: !!(g.reached || g.pastReview), hit: !!g.stopHit, stopPx: g.stopPx, adj: !!g.levStopAdj };
  }
  function renderPosList(rows) {
    const box = $("posList"); if (!box) return;
    const emp = $("posEmpty"); if (emp) emp.hidden = rows.length > 0;
    const key = rows.map((r) => r.kind + ":" + r.key).join("|");
    const liveApi = window.MCE.live;
    rows = [...rows.filter((r) => r.kind !== "lev"), ...rows.filter((r) => r.kind === "lev")];
    const nSpot = rows.filter((r) => r.kind !== "lev").length, nLev = rows.length - nSpot;
    const nKids = rows.length + (nSpot ? 1 : 0) + (nLev ? 1 : 0);
    if (key !== pfListKey || box.childElementCount !== nKids) {
      pfListKey = key;
      box.textContent = "";
      let lastKind = null;
      for (const r of rows) {
        const kd = r.kind === "lev" ? "lev" : "spot";
        if (kd !== lastKind) {
          lastKind = kd;
          box.append(el("div", { class: "pos-grp pos-grp-" + kd, "data-grp": kd },
            el("span", { text: kd === "lev" ? "槓桿" : "現貨" }), el("span", { class: "muted num", "data-grp-sum": kd })));
        }
        const sym = r.pos.symbol;
        const logo = liveApi && liveApi.coinLogoEl ? liveApi.coinLogoEl(sym, "coin-logo", 36) : el("span", { class: "coin-logo letter", text: String(sym).slice(0, 2) });
        const act = r.kind === "lev"
          ? el("button", { type: "button", class: "secondary sm pr-act", onclick: (e) => { e.stopPropagation(); closeLev(r.key); } }, "平倉")
          : el("button", { type: "button", class: "secondary sm pr-act", onclick: (e) => { e.stopPropagation(); openSell(r.key); } }, "賣");
        box.append(el("div", { class: "pos-row", role: "button", tabindex: "0", "data-pk": r.kind + ":" + r.key, "data-sym": sym, onclick: () => openPosDetail(r.kind, r.key) },
          logo,
          el("div", { class: "pr-id" },
            el("div", { class: "pr-nm" }, el("b", { text: sym }), r.kind === "lev" ? el("span", { class: "pr-lev", text: r.pos.leverage + "x" }) : "")),
          el("div", { class: "pr-num" },
            el("div", { class: "num pr-val", "data-pr": "val" }),
            el("div", { class: "num pr-pnl", "data-pr": "pnl" })),
          act,
          el("div", { class: "pr-exit", "data-pr": "exit" })));
      }
    }
    for (const r of rows) {
      const row = box.querySelector(`[data-pk="${CSS.escape(r.kind + ":" + r.key)}"]`); if (!row) continue;
      const set = (k, t, c) => { const n = row.querySelector(`[data-pr="${k}"]`); if (!n) return; if (n.textContent !== t) n.textContent = t; if (c != null) n.className = c; };
      set("val", r.value == null ? "…" : money2(r.value), null);
      set("pnl", r.pnl == null ? "…" : `${r.pnl >= 0 ? "+" : ""}${money2(r.pnl)} · ${pct(r.pnlPct)}`, "num pr-pnl " + cls(r.pnl));
      const ex = posRowExit(r);
      set("exit", ex.text, "pr-exit" + (ex.hit ? " stop-hit" : ex.due ? " due" : ""));
      { const n = row.querySelector('[data-pr="exit"]'); if (n) { n.dataset.stop = ex.stopPx != null ? String(ex.stopPx) : ""; n.dataset.levstop = ex.adj ? "1" : ""; n.dataset.hit = ex.hit ? "1" : ""; } }
      row.classList.toggle("stale", !!r.stale);
      if (r.flash && !reduceMotion()) { row.classList.remove("tick-up", "tick-down"); void row.offsetWidth; row.classList.add(r.flash === "up" ? "tick-up" : "tick-down"); }
    }
    for (const kd of ["spot", "lev"]) {
      const n = box.querySelector(`[data-grp-sum="${kd}"]`); if (!n) continue;
      const rs = rows.filter((r) => (r.kind === "lev" ? "lev" : "spot") === kd);
      const pnl = rs.reduce((a, r) => a + (r.pnl || 0), 0);
      const t = `${rs.length} 隻 · ${pnl >= 0 ? "+" : ""}${money2(pnl)}`;
      if (n.textContent !== t) n.textContent = t;
      n.className = "muted num " + cls(pnl);
    }
    if (pfDetailOpen) { try { paintPosDetail(); } catch (_) {} }
  }

  let pfDetailOpen = null;
  function openPosDetail(kind, key) {
    pfDetailOpen = { kind, key };
    paintPosDetail();
    const pos = kind === "lev" ? P.levPositions[key] : P.positions[key];
    if (!pos) return;
    window.MCE.market.openSheet(pos.symbol + (kind === "lev" ? " " + pos.leverage + "x" : ""), "posDetail");
    const dlg = $("infoSheet");
    const prev = dlg.onclose;
    dlg.onclose = () => { pfDetailOpen = null; if (prev) prev(); };
  }
  function paintPosDetail() {
    const box = $("posDetail"); if (!box || !pfDetailOpen) return;
    const { kind, key } = pfDetailOpen;
    const pos = kind === "lev" ? P.levPositions[key] : P.positions[key];
    box.textContent = "";
    if (!pos) { box.append(el("p", { class: "muted", text: "已平倉" })); return; }
    const li = liveInfo(pos.chain, pos.pair);
    const px = li.state === "live" ? li.price : knownPx(pos);
    const kv = (k, v, c = "") => [el("div", { class: "muted", text: k }), el("div", { class: "num " + c, text: v })];
    const plan = exitPlanForPosition(pos);
    const g = exitGuideCopy(plan, posBasisPx(pos), px, kind === "lev" ? pos.leverage : null);
    if (g) withStopLoss(g, stopLossUsd(kind, { pos }, g.stopPx));
    let rows;
    if (kind === "lev") {
      const op = calc.levOpenPnl(pos, px), m = op.m, cc = calc.levClose(pos, px);
      rows = [kv("標記價", price(px)), kv("入場", price(pos.entry)), kv("保證金", money2(pos.margin)), kv("名義", money2(pos.notional)),
        kv("開倉費", money2(pos.openFee || 0)), kv("倉值（保證金 + 浮盈虧）", money2(op.value)),
        kv("盈虧（連開倉費）", `${op.pnl >= 0 ? "+" : ""}${money2(op.pnl)} · ${pct(op.pct)}`, cls(op.pnl)),
        kv("% 基數", `保證金 + 開倉費 = ${money2(op.paid)}`),
        kv("而家平倉：平倉費", money2(cc.closeFee)), kv("而家平倉：退回", money2(cc.back)),
        kv("爆倉價", price(m.liq), "neg")];
    } else {
      const v = pos.qty * px, u = v - pos.cost;
      rows = [kv("現價", price(px)), kv("數量", fmtQty(pos.qty)), kv("平均入場", price(posBasisPx(pos))), kv("成本（連費）", money2(pos.cost)),
        kv("市值", money2(v)), kv("盈虧（連買入費）", `${u >= 0 ? "+" : ""}${money2(u)} · ${pct(pos.cost ? (v / pos.cost - 1) * 100 : 0)}`, cls(u)),
        kv("% 基數", `成本（連費）= ${money2(pos.cost)}`), kv("而家賣：賣出費", money2(calc.spotSell(pos.qty, px).fee)), kv("而家賣：收返", money2(calc.spotSell(pos.qty, px).proceeds)),
        kv("打和價", price(pos.cost / pos.qty / (1 - P.feePct / 100)))];
    }
    box.append(el("div", { class: "kv pd-kv" }, ...rows.flat()));
    if (g) box.append(el("div", { class: "pd-exit" },
      el("div", { class: "peg-kicker", text: "幾時可以放" }),
      el("div", { text: g.main }), el("div", { class: "muted", text: g.hold }),
      el("div", { class: "muted pd-stop", "data-stop": String(g.stopPx), "data-loss": g.lossUsd != null ? String(g.lossUsd) : "", text: "止蝕 " + g.stop }),
      g.stopHit ? el("div", { class: "stop-hit-txt pd-stophit", text: STOP_HIT_TXT }) : "",
      g.levStopAdj ? el("div", { class: "pd-levstop", text: LEV_STOP_NOTE }) : ""));
    const info = { chain: pos.chain, pair: pos.pair, token: pos.token, symbol: pos.symbol, name: pos.name, source: pos.source };
    const close = () => window.MCE.market.closeSheet(false);
    box.append(kind === "lev"
      ? el("div", { class: "pd-actions" }, el("button", { type: "button", class: "primary", onclick: () => { close(); closeLev(key); } }, "平倉"))
      : el("div", { class: "pd-actions" },
        el("button", { type: "button", class: "primary", onclick: () => { close(); openBuy(info); } }, "加倉"),
        ...[25, 50, 100].map((v) => el("button", { type: "button", class: "secondary", onclick: () => { close(); openSell(key, v); } }, `賣 ${v}%`))));
  }

  async function renderPortfolio(fetchPrices = true) {
    $("feePct").value = P.feePct;
    $("startCash").value = P.start;
    document.querySelectorAll(".segbtn[data-pfmode]").forEach((b) => b.classList.toggle("active", b.dataset.pfmode === pfMode));
    $("spotSection").hidden = pfMode === "lev";
    $("levSection").hidden = pfMode === "spot";

    const spotEntries = Object.entries(P.positions);
    const levEntries = Object.entries(P.levPositions);
    const need = [
      ...spotEntries.map(([, p]) => ({ chain: p.chain, pair: p.pair })),
      ...levEntries.map(([, p]) => ({ chain: p.chain, pair: p.pair })),
    ];
    const _bmNeed = P.bmAtFirstBuy || P.solAtFirstBuy; if (_bmNeed) need.push({ chain: _bmNeed.chain, pair: _bmNeed.pair });
    if (fetchPrices && need.length) await fetchPairs(need, false);

    // prices for liq check
    const levMarks = {};
    for (const [id, pos] of levEntries) {
      const li = liveInfo(pos.chain, pos.pair);
      if (li.state === "live") levMarks[id] = li.price;
      else if (li.state === "dead") levMarks[id] = 0;
    }
    const liqN = checkLiquidations(levMarks);
    if (liqN) {
      toast(`${liqN} 個槓桿倉觸發爆倉`);
      if (P.allin && P.allin.status === "open" && P.allin.mode === "lev" && !P.levPositions[P.allin.key]) {
        const last = P.trades.find((t) => t.side === "LIQUIDATE" && t.symbol === P.allin.symbol);
        const cb = P.allin.cashBefore || 0;
        endAllinRound({ reason: "爆倉", exitPrice: last?.price ?? 0, retPct: cb ? (P.cash / cb - 1) * 100 : -100, pnl: last && last.pnl != null ? last.pnl : -cb });
      }
    }
    const levEntries2 = Object.entries(P.levPositions);

    let spotValue = 0, spotCost = 0;
    const listRows = [];
    const hb = $("holdBody"); hb.textContent = "";
    for (const [k, p] of Object.entries(P.positions)) {
      const li = liveInfo(p.chain, p.pair);
      // BUG FIX (ux-fix): unknown price used to drop the position from equity (fake −100% flash after reload).
      const px = li.state === "live" ? li.price : li.state === "dead" ? 0 : knownPx(p);
      const v = px == null ? null : p.qty * px;
      if (v != null) spotValue += v; spotCost += p.cost;
      listRows.push({ key: k, kind: "spot", pos: p, px, value: v, pnl: v == null ? null : v - p.cost, pnlPct: v == null || !p.cost ? null : (v / p.cost - 1) * 100, stale: li.state !== "live" && li.state !== "dead", flash: li.flash });
      const u = v == null ? null : v - p.cost;
      const upct = u == null || !p.cost ? null : (u / p.cost) * 100;
      const flashCls = li.flash === "up" ? " tick-up" : li.flash === "down" ? " tick-down" : "";
      hb.append(el("tr", { class: "cardish spot-row" + flashCls, "data-pos": k },
        el("td", { "data-label": "幣" },
          el("span", { class: "kind-badge spot", text: "現貨" }), " ",
          el("b", { text: "$" + p.symbol }), " ", srcBadge(p.chain, p.pair, li),
          li.state === "dead" ? el("span", { class: "pill dead" }, "已死") : "",
          u != null ? el("div", { class: "pnl-glance " + cls(u), text: (u >= 0 ? "+" : "") + money2(u) + " · " + (upct == null ? "" : pct(upct)) }) : "",
          posExitGuideEl(p, px)),
        el("td", { class: "num", "data-label": "數量", text: p.qty.toLocaleString(undefined, { maximumFractionDigits: 2 }) }),
        el("td", { class: "num", "data-label": "入場", text: price(posBasisPx(p)) }), el("td", { class: "num", "data-label": "成本", text: money2(p.cost) }),
        el("td", { class: "num live-px", "data-label": "而家", text: px == null ? "…" : price(px) }), el("td", { class: "num", "data-label": "市值", text: v == null ? "…" : money2(v) }),
        el("td", { class: "num pnl-strong " + cls(upct), "data-label": "浮盈虧%", text: upct == null ? "…" : pct(upct) }),
        el("td", { class: "num pnl-strong " + cls(u), "data-label": "浮盈虧$", text: u == null ? "…" : money2(u) }),
        el("td", { "data-label": "", class: "actions" }, el("button", { class: "secondary", onclick: () => openSell(k) }, "平倉"), " ",
          el("button", { class: "primary", onclick: () => openBuy({ chain: p.chain, pair: p.pair, token: p.token, symbol: p.symbol, name: p.name }) }, "加倉"))));
    }
    $("holdEmpty").hidden = Object.keys(P.positions).length > 0;

    let levEquity = 0, levMargin = 0, levUnreal = 0;
    const lb = $("levBody"); lb.textContent = "";
    for (const [id, pos] of levEntries2) {
      const li = liveInfo(pos.chain, pos.pair);
      const px = li.state === "live" ? li.price : li.state === "dead" ? 0 : knownPx(pos);
      const m = px == null ? null : levMark(pos, px);
      if (m) { levEquity += Math.max(0, m.equity); levMargin += pos.margin; levUnreal += m.unreal; }
      else { levEquity += pos.margin; levMargin += pos.margin; }
      const op = px == null ? null : calc.levOpenPnl(pos, px);
      listRows.push({ key: id, kind: "lev", pos, px, value: op ? op.value : null, pnl: op ? op.pnl : null, pnlPct: op ? op.pct : null, stale: li.state !== "live" && li.state !== "dead", flash: li.flash });
      const dropPct = px != null ? ((px / pos.entry - 1) * 100) : null;
      const toLiq = px != null ? ((px - liqPriceLong(pos.entry, pos.leverage)) / px * 100) : null;
      const flashClsL = li.flash === "up" ? " tick-up" : li.flash === "down" ? " tick-down" : "";
      // BUG FIX (ux-fix): was price% × leverage (ignored fees) → disagreed with the $ P&L. Now unrealised / margin.
      const levPnlPct = op ? op.pct : null;
      lb.append(el("tr", { class: "cardish lev-row" + flashClsL, "data-lev": id },
        el("td", { "data-label": "幣" },
          el("span", { class: "kind-badge lev", text: pos.leverage + "x" }), " ",
          el("b", { text: "$" + pos.symbol }), " ", srcBadge(pos.chain, pos.pair, li),
          op ? el("div", { class: "pnl-glance " + cls(op.pnl), text: (op.pnl >= 0 ? "+" : "") + money2(op.pnl) + " · " + pct(op.pct) }) : "",
          toLiq != null ? el("div", { class: "dist" + (toLiq < 5 ? " hot" : ""), text: `爆倉價 ${price(liqPriceLong(pos.entry, pos.leverage))} · 距 ${toLiq.toFixed(1)}%` }) : el("div", { class: "dist", text: "爆倉價 " + price(liqPriceLong(pos.entry, pos.leverage)) }),
          posExitGuideEl(pos, px)),
        el("td", { class: "num", "data-label": "倍數", text: pos.leverage + "x" }),
        el("td", { class: "num", "data-label": "保證金", text: money2(pos.margin) }),
        el("td", { class: "num", "data-label": "名義", text: money2(pos.notional) }),
        el("td", { class: "num", "data-label": "入場", text: price(pos.entry) }),
        el("td", { class: "num live-px", "data-label": "標記", text: px == null ? "…" : price(px) }),
        el("td", { class: "num neg", "data-label": "爆倉價", text: price(liqPriceLong(pos.entry, pos.leverage)) }),
        el("td", { class: "num pnl-strong " + cls(op?.pnl), "data-label": "盈虧（連開倉費）", text: op ? `${money2(op.pnl)} (${pct(op.pct)})` : "…" }),
        el("td", { class: "num " + cls(m?.equity - pos.margin), "data-label": "倉權益", text: m ? money2(m.equity) : "…" }),
        el("td", { "data-label": "", class: "actions" }, el("button", { class: "secondary", onclick: () => closeLev(id) }, "平倉"))));
    }
    $("levEmpty").hidden = levEntries2.length > 0;
    renderPosList(listRows);

    // Total equity = cash + spot value + lev position equity (margin already out of cash, counted in lev equity)
    const equity = P.cash + spotValue + levEquity;
    if (equity > (P.equityPeak || P.start)) { P.equityPeak = equity; pf.save(P); }
    const dd = P.equityPeak ? (equity / P.equityPeak - 1) * 100 : 0;
    const unrealSpot = spotValue - spotCost;
    const total = equity - P.start, totalPct = (total / P.start) * 100;
    let solRet = null;
    const bmLock = P.bmAtFirstBuy || P.solAtFirstBuy;
    const bmSym = (bmLock && bmLock.symbol) || (bmLock && String(bmLock.pair || "").replace(/USDT$/, "")) || "BTC";
    if (bmLock) {
      if (bmLock.chain === "binance" && window.MCE.live) {
        const m = window.MCE.live.getMark("binance", bmLock.pair);
        if (m && m.price > 0 && bmLock.price > 0) solRet = (m.price / bmLock.price - 1) * 100;
      } else {
        const sl = liveInfo(bmLock.chain, bmLock.pair);
        if (sl.state === "live") solRet = (sl.price / bmLock.price - 1) * 100;
      }
    }
    const st = $("pfStats"); st.textContent = "";
    const stat = (k, v, s, c = "") => el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v " + c, text: v }), s ? el("div", { class: "s", text: s }) : "");
    renderAllinChrome(spotValue, levEquity);
    const spotN = Object.keys(P.positions).length, levN = Object.keys(P.levPositions).length;
    // Glance strip (portfolio + home mini)
    const setTxt = (id, t) => { const n = $(id); if (n) n.textContent = t; };
    const pnlTxt = (total >= 0 ? "+" : "") + money2(total);
    const pgPnl0 = $("pgPnl");
    if (pgPnl0 && pgPnl0.textContent && pgPnl0.textContent !== pnlTxt) {
      const dir = equity >= (_lastEquity == null ? equity : _lastEquity) ? "up" : "down";
      pgPnl0.classList.remove("tick-up", "tick-down");
      void pgPnl0.offsetWidth;
      if (!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) {
        pgPnl0.classList.add(dir === "up" ? "tick-up" : "tick-down");
        clearTimeout(pgPnl0._tickT);
        pgPnl0._tickT = setTimeout(() => pgPnl0.classList.remove("tick-up", "tick-down"), 420);
      }
    }
    setTxt("pgEquity", money2(equity));
    setTxt("pgEquitySub", "起始 " + money2(P.start));
    setTxt("pgPnl", pnlTxt);
    setTxt("pgPnlPct", pct(totalPct));
    setTxt("pgCash", money2(P.cash));
    setTxt("pgPos", String(spotN + levN));
    setTxt("pgPosSub", `現貨 ${spotN} · 槓桿 ${levN}`);
    const pgPnl = $("pgPnl"), pgPct = $("pgPnlPct");
    if (pgPnl) pgPnl.className = ("pg-v " + cls(total) + (pgPnl.classList.contains("tick-up") ? " tick-up" : pgPnl.classList.contains("tick-down") ? " tick-down" : "")).trim();
    if (pgPct) pgPct.className = "pg-s " + cls(total);
    if (_lastEquity != null && Math.abs(equity - _lastEquity) / Math.max(P.start, 1) >= 0.0005) {
      flashGlance(equity >= _lastEquity ? "up" : "down");
    }
    _lastEquity = equity;

    const simpleSt = $("simplePfStats");
    if (simpleSt) {
      simpleSt.textContent = "";
      const sstat = (k, v, s, c = "") => el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v " + c, text: v }), s ? el("div", { class: "s", text: s }) : "");
      simpleSt.append(
        sstat("總資產", money2(equity), `起始 ${money2(P.start)}`),
        sstat("總盈虧", (total >= 0 ? "+" : "") + money2(total), pct(totalPct), cls(total)),
        sstat("持倉", String(spotN + levN), `現貨 ${spotN} · 槓桿 ${levN}`),
        sstat("現金", money2(P.cash)));
    }
    const mini = $("simplePfMini");
    if (mini) {
      mini.textContent = "";
      mini.className = "simple-pf-mini pf-glance mini";
      const cell = (k, v, s, c = "") => el("a", { href: "#portfolio", class: "pg-cell " + c },
        el("div", { class: "pg-k", text: k }),
        el("div", { class: "pg-v", text: v }),
        s ? el("div", { class: "pg-s", text: s }) : "");
      mini.append(
        cell("模擬倉", money2(equity), ""),
        cell("盈虧", (total >= 0 ? "+" : "") + money2(total), pct(totalPct), cls(total)),
        cell("現金", money2(P.cash), ""));
    }
    st.append(
      stat("總資產", money2(equity), `起始 ${money2(P.start)}`),
      stat("總盈虧", `${money2(total)} (${pct(totalPct)})`, P.firstBuyAt ? `由 ${localTime(P.firstBuyAt)}` : "未開倉", cls(total)),
      stat("現金", money2(P.cash)),
      stat("現貨市值", money2(spotValue), `浮盈虧 ${money2(unrealSpot)}`, cls(unrealSpot)),
      stat("槓桿倉權益", money2(levEquity), `保證金 ${money2(levMargin)} · 浮 ${money2(levUnreal)}`, cls(levUnreal)),
      stat("現貨已實現", money2(P.realizedSpot || 0), "", cls(P.realizedSpot)),
      stat("槓桿已實現", money2(P.realizedLev || 0), `爆倉 ${P.liquidations || 0} 次`, cls(P.realizedLev)),
      stat("最大回撤", pct(dd), `峰值 ${money2(P.equityPeak || P.start)}`, cls(dd)),
      stat("同期 " + bmSym, solRet == null ? "–" : pct(solRet), bmLock ? `基準 $${Number(bmLock.price).toFixed(2)}` : "第一次落倉鎖定", cls(solRet)),
      stat("跑贏 " + bmSym, solRet == null ? "–" : (totalPct - solRet > 0 ? "+" : "") + (totalPct - solRet).toFixed(1) + " pts", "總回報 − " + bmSym, cls(solRet == null ? 0 : totalPct - solRet)));

    const tb = $("tradeBody"); tb.textContent = "";
    const sideZh = { BUY: "現貨買", SELL: "現貨賣", "WRITE-OFF": "銷帳", OPEN: "開槓桿", CLOSE: "平槓桿", LIQUIDATE: "爆倉" };
    for (const t of P.trades.slice(0, 200))
      tb.append(el("tr", {},
        el("td", { text: localTime(t.t) }),
        el("td", { text: t.kind === "lev" ? "槓桿" : "現貨" }),
        el("td", { text: (sideZh[t.side] || t.side) + (t.leverage ? ` ${t.leverage}x` : ""), class: t.side === "BUY" || t.side === "OPEN" ? "pos" : "neg" }),
        el("td", { text: "$" + t.symbol }),
        el("td", { class: "num", text: price(t.price) }),
        el("td", { class: "num", text: t.notional ? money2(t.notional) : t.qty.toLocaleString(undefined, { maximumFractionDigits: 2 }) }),
        el("td", { class: "num", text: money2(t.usd) }),
        el("td", { class: "num", text: money2(t.fee) }),
        el("td", { class: "num " + cls(t.pnl), text: t.pnl == null ? "–" : money2(t.pnl) })));
    updateLiveStrip();
    ensureLiveLoop(false);
  }

  function portfolioFeed() {
    return {
      spot: Object.values(P.positions).map((p) => ({ chain: p.chain, pair: p.pair, token: p.token, symbol: p.symbol })),
      lev: Object.values(P.levPositions).map((p) => ({ chain: p.chain, pair: p.pair, token: p.token, symbol: p.symbol })),
    };
  }
  function updateLiveStrip() {
    const strip = $("liveStrip"), txt = $("liveStripText");
    if (!strip || !txt) return;
    const n = Object.keys(P.positions).length + Object.keys(P.levPositions).length;
    if (!n) { strip.hidden = true; return; }
    strip.hidden = false;
    let bn = 0, dex = 0;
    for (const p of Object.values(P.positions)) {
      const m = window.MCE.live && window.MCE.live.getMark(p.chain, p.pair);
      if (m?.source === "binance") bn++; else dex++;
    }
    for (const p of Object.values(P.levPositions)) {
      const m = window.MCE.live && window.MCE.live.getMark(p.chain, p.pair);
      if (m?.source === "binance") bn++; else dex++;
    }
    const parts = [];
    if (bn) parts.push(`Binance 即時 ×${bn}`);
    if (dex) parts.push(`Dex 即時（每 ${(window.MCE.live?.DEX_POLL_MS || 4000) / 1000} 秒）×${dex}`);
    txt.textContent = "持倉報價：" + (parts.join(" · ") || "連接中…");
  }
  let liveStarted = false, liveRenderBusy = false, liveTickBound = false;
  function ensureLiveLoop(forceStart) {
    if (!window.MCE.live) return;
    const n = Object.keys(P.positions).length + Object.keys(P.levPositions).length;
    if (n === 0 && !forceStart) return;
    if (!liveTickBound) {
      liveTickBound = true;
      window.MCE.live.onTick(() => {
        const view = (location.hash || "").slice(1);
        if (view === "picks" || view === "" || view === "home") {
          if (!S._frTickAt || Date.now() - S._frTickAt > 4000) {
            S._frTickAt = Date.now();
            try { refreshFollowReportLive(); } catch (_) {}
          }
        }
        if (liveRenderBusy) return;
        if (view !== "portfolio" && view !== "picks") return;
        if (!Object.keys(P.positions).length && !Object.keys(P.levPositions).length) return;
        liveRenderBusy = true;
        Promise.resolve(renderPortfolio(false)).finally(() => { liveRenderBusy = false; });
      });
    }
    if (!liveStarted) {
      liveStarted = true;
      window.MCE.live.start({ getPositions: portfolioFeed });
    } else {
      window.MCE.live.sync(portfolioFeed);
    }
  }

  function renderHotBuys(rows) { /* deprecated Dex path */ renderHotBuysFromBn([]); }

  // ---------- Cartoon FX ----------
  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function spawnParticles(host, n = 18) {
    if (!host || reduceMotion()) return;
    host.textContent = "";
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 * i) / n + Math.random() * 0.3;
      const dist = 80 + Math.random() * 120;
      const p = el("i");
      p.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      p.style.setProperty("--dy", Math.sin(ang) * dist + "px");
      p.style.background = ["#F0B90B", "#c084fc", "#34d399", "#f472b6", "#60a5fa"][i % 5];
      p.style.animationDelay = (Math.random() * 0.15) + "s";
      host.append(p);
    }
  }
  function playOverlay({ emoji, title, sub, coin, kind = "", ms = 1500 } = {}) {
    return new Promise((resolve) => {
      const box = $("allinFx"); if (!box) return resolve();
      box.className = "fx-overlay" + (kind ? " " + kind : "");
      $("allinFxEmoji").textContent = emoji || "★";
      $("allinFxTitle").textContent = title || "孤注一擲！";
      $("allinFxSub").textContent = sub || "一舖過";
      $("allinFxCoin").textContent = coin || "";
      box.hidden = false; box.setAttribute("aria-hidden", "false");
      spawnParticles(box.querySelector(".fx-burst"), kind === "bust" ? 22 : 18);
      if (!reduceMotion()) {
        document.body.classList.add("fx-shaking");
        setTimeout(() => document.body.classList.remove("fx-shaking"), 450);
      }
      const wait = reduceMotion() ? 80 : ms;
      setTimeout(() => {
        box.hidden = true; box.setAttribute("aria-hidden", "true");
        resolve();
      }, wait);
    });
  }
  function coinPopEl(node) {
    if (!node || reduceMotion()) return;
    node.classList.remove("popping", "bounce");
    void node.offsetWidth;
    node.classList.add(node.classList.contains("tab") ? "bounce" : "popping");
    setTimeout(() => node.classList.remove("popping", "bounce"), 450);
  }
  function floatPop(text, x, y) {
    if (reduceMotion()) return;
    const n = $("popFx") || document.body;
    const t = el("div", { class: "pop-fx", text });
    t.style.left = (x || window.innerWidth / 2) + "px";
    t.style.top = (y || window.innerHeight / 2) + "px";
    t.hidden = false;
    document.body.append(t);
    setTimeout(() => t.remove(), 700);
  }
  let _lastAllinPct = null;
  function flashAllinPnl(pctVal) {
    const live = $("allinLive"); if (!live || pctVal == null || reduceMotion()) { _lastAllinPct = pctVal; return; }
    if (_lastAllinPct != null && Math.abs(pctVal - _lastAllinPct) >= 0.15) {
      live.classList.remove("flash-up", "flash-down");
      void live.offsetWidth;
      live.classList.add(pctVal >= _lastAllinPct ? "flash-up" : "flash-down");
      setTimeout(() => live.classList.remove("flash-up", "flash-down"), 750);
    }
    _lastAllinPct = pctVal;
  }

  function toast(msg, kind = "ok") {
    const t = el("div", { class: "toast pop toast-" + kind, text: msg });
    document.body.append(t); setTimeout(() => t.remove(), 3200);
  }
  function flashGlance(dir) {
    const g = $("pfGlance"); if (!g || reduceMotion()) return;
    g.classList.remove("flash-up", "flash-down");
    void g.offsetWidth;
    g.classList.add(dir === "up" ? "flash-up" : "flash-down");
    setTimeout(() => g.classList.remove("flash-up", "flash-down"), 700);
  }
  function pulseEl(node, clsName = "just-filled") {
    if (!node || reduceMotion()) return;
    node.classList.remove(clsName);
    void node.offsetWidth;
    node.classList.add(clsName);
    setTimeout(() => node.classList.remove(clsName), 1200);
  }
  let navGen = 0; // bumps in show() — cancels stale afterFillUX highlight / yank
  let applyingHash = false;
  function goView(view) {
    const allowed = uiMode === "simple"
      ? ["picks", "browse", "portfolio", "more", "news", "explore"]
      : ["explore", "picks", "browse", "portfolio", "news", "more"];
    if (!allowed.includes(view)) view = "picks";
    // Close any leftover modal so it cannot eat pointer events
    for (const id of ["tradeDlg", "allinDlg", "allinPickDlg", "coinPickDlg", "infoSheet"]) {
      const d = $(id);
      if (d && d.open) { try { d.close(); } catch (_) {} }
    }
    if ((location.hash || "").slice(1) !== view) {
      applyingHash = true;
      location.hash = view;
      applyingHash = false;
    }
    show(view); // sync — do not wait for async hashchange
    return view;
  }
  function afterFillUX({ mode, symbol }) {
    const tab = document.querySelector('.tab[data-view="portfolio"]');
    if (tab) coinPopEl(tab);
    const cards = document.querySelectorAll(".simple-card");
    for (const c of cards) {
      const nm = c.querySelector(".nm");
      if (nm && nm.textContent === symbol) { pulseEl(c, "fill-pulse"); break; }
    }
    // Arrive on portfolio, then lock highlight gen AFTER nav bumps
    goView("portfolio");
    const myGen = navGen;
    const highlight = () => {
      if (myGen !== navGen) return; // user left portfolio after fill
      if ((location.hash || "").slice(1) !== "portfolio") return;
      const glance = $("pfGlance");
      if (glance) {
        glance.classList.add("pf-highlight");
        setTimeout(() => glance.classList.remove("pf-highlight"), 1600);
      }
      const rows = document.querySelectorAll("#posList .pos-row");
      for (const tr of rows) {
        if (tr.dataset.sym === symbol && (mode === "lev") === tr.dataset.pk.startsWith("lev:")) {
          pulseEl(tr, "just-filled");
          try { tr.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (_) {}
          break;
        }
      }
    };
    setTimeout(highlight, 220);
  }

  // ---------- 重點新聞 ----------
  let newsData = null, newsTag = "all";
  function newsAgeBadge(iso) {
    if (!iso) return { text: "未知時間", stale: true };
    const h = (Date.now() - new Date(iso).getTime()) / 3.6e6;
    if (h < 24) return { text: `更新於 ${h.toFixed(0)} 小時前`, stale: false };
    if (h < 48) return { text: `更新於 ${(h/24).toFixed(1)} 日前`, stale: false };
    return { text: `可能過時 · ${(h/24).toFixed(1)} 日前`, stale: true };
  }
  async function loadNews() {
    try {
      if (!newsData) newsData = await (await fetch("data/news.json", { cache: "no-cache" })).json();
      S.news = newsData;
      const age = newsAgeBadge(newsData.fetched_at);
      $("newsMeta").textContent = "快照 " + localTime(newsData.fetched_at) + " · " + (newsData.stories || []).length + " 則";
      const nf = $("newsFreshness");
      if (nf) { nf.textContent = age.text; nf.className = "age" + (age.stale ? " stale" : ""); }
      const strip = $("simpleNewsStrip");
      if (strip && newsData.stories?.[0]) {
        strip.hidden = false;
        const st = newsData.stories[0];
        $("simpleNewsText").textContent = st.title;
        const sa = $("simpleNewsAge");
        if (sa) { sa.textContent = age.stale ? "· 可能過時" : ""; sa.className = "age" + (age.stale ? " stale" : ""); }
        const link = $("simpleNewsLink");
        if (link) link.onclick = (e) => { if (uiMode === "simple") { /* stay */ } };
      }
      renderNews();
    } catch (e) { $("newsList").textContent = "載入新聞失敗：" + e.message; }
  }
  function renderNews() {
    const list = $("newsList"); list.textContent = "";
    const stories = (newsData.stories || []).filter((n) => newsTag === "all" || (n.tags || []).includes(newsTag));
    if (!stories.length) { list.append(el("p", { class: "muted", text: "呢個標籤暫時冇新聞。" })); return; }
    for (const n of stories) {
      const href = safeUrl(n.url);
      list.append(el("article", { class: "news-card" },
        el("div", { class: "news-tags" }, (n.tags || []).map((t) => el("span", { class: "pill " + (t === "rug" || t === "scam" ? "bad" : t === "regulation" ? "" : "good"), text: t }))),
        el("h3", { text: n.title }),
        n.title_en ? el("p", { class: "muted en", text: n.title_en }) : "",
        el("p", { text: n.summary }),
        el("p", { class: "why" }, el("b", { text: "點解重要：" }), " ", n.why_it_matters),
        el("div", { class: "news-foot" },
          el("span", { class: "muted", text: (n.source || "X") + (n.published_at ? " · " + localTime(n.published_at) : "") }),
          href ? el("a", { href, target: "_blank", rel: "noopener nofollow", text: "睇原文 ↗" }) : "")));
    }
  }

  function applyLens(lens) {
    document.querySelectorAll(".lens").forEach((b) => b.classList.toggle("active", b.dataset.lens === lens));
    if (lens === "scalp") {
      location.hash = "browse";
      setTimeout(() => {
        if (window.MCE.loadBinanceBoard) window.MCE.loadBinanceBoard(false);
        toast("短線模式：去睇幣（Binance 現貨），急升盤當參考唔好盲目追");
      }, 200);
    } else if (lens === "careful") {
      location.hash = "picks";
      toast("謹慎模式：只跟 AI 買入推薦，撳「落倉」或「跟晒今批」");
    } else if (lens === "research") {
      location.hash = "news";
      toast("研究模式：先睇重點新聞同避過清單");
    } else if (lens === "lev") {
      goView("portfolio");
      pfMode = "lev";
      const el = document.getElementById("lens-lev");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("槓桿模式：可開到 50x");
      setTimeout(() => renderPortfolio(true), 200);
    } else if (lens === "allin") {
      goView("portfolio");
      const el = document.getElementById("lens-allin");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("孤注一擲：假錢 All-in 一隻幣，一舖過");
      setTimeout(() => openAllinFlow(), 400);
    }
    // Also expand howto and highlight section
    const howto = document.getElementById("howto");
    if (howto) howto.open = true;
    document.querySelectorAll(".howto-sec").forEach((sec) => {
      sec.classList.toggle("hilite", sec.id === "lens-" + lens);
    });
  }

  function show(view) {
    const allowed = uiMode === "simple"
      ? ["picks", "browse", "portfolio", "more", "news", "explore"]
      : ["explore", "picks", "browse", "portfolio", "news", "more"];
    if (!allowed.includes(view)) view = "picks";
    navGen++;
    for (const v of ["explore", "picks", "browse", "portfolio", "news", "more"]) {
      const node = $("view-" + v);
      if (!node) continue;
      const on = v === view;
      node.hidden = !on;
      if (on) {
        node.classList.remove("view-enter");
        // force reflow so re-enter anim plays
        void node.offsetWidth;
        node.classList.add("view-enter");
      } else {
        node.classList.remove("view-enter");
      }
    }
    document.querySelectorAll(".tab").forEach((a) => {
      const on = a.dataset.view === view;
      if (on && !a.classList.contains("active")) coinPopEl(a);
      a.classList.toggle("active", on);
    });
    try {
      if (view === "picks") {
        loadPicks(); loadNews();
        loadLiveBnPicks(false);
      }
      if (view === "browse") {
        if (window.MCE.loadBinanceBoard) window.MCE.loadBinanceBoard(false);
      }
      if (view === "portfolio") { renderPortfolio(true); ensureLiveLoop(true); }
      if (view === "news") loadNews();
      if (view === "explore" && window.MCE.ensureExplore) window.MCE.ensureExplore();
    } catch (err) {
      console.warn("show view load error", view, err);
    }
  }
  window.addEventListener("hashchange", () => {
    if (applyingHash) return; // already handled synchronously in goView
    show((location.hash || "#picks").slice(1));
  });
  // Explicit tab routing — works even if hash unchanged / overlay ate the default nav
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest && ev.target.closest("a.tab[data-view], a.more-item[href^='#']");
    if (!a || a.tagName !== "A") return;
    const href = a.getAttribute("href") || "";
    if (!href.startsWith("#")) return;
    const view = a.dataset.view || href.slice(1);
    if (!view) return;
    ev.preventDefault();
    goView(view);
  }, true);
  document.querySelectorAll(".news-filters .chip").forEach((b) => b.addEventListener("click", () => {
    newsTag = b.dataset.ntag; document.querySelectorAll(".news-filters .chip").forEach((x) => x.classList.toggle("active", x === b)); renderNews();
  }));
  document.querySelectorAll(".lens").forEach((b) => b.addEventListener("click", () => applyLens(b.dataset.lens)));
  if ($("picksRefresh")) $("picksRefresh").addEventListener("click", () => { loadPicks(true); loadLiveBnPicks(true); });
  $("followBatch").addEventListener("click", copyPicks);
  document.querySelectorAll(".segbtn[data-pfmode]").forEach((b) => b.addEventListener("click", () => {
    pfMode = b.dataset.pfmode; renderPortfolio(false);
  }));
  document.querySelectorAll("#riskProfile [data-risk], #tradeRisk [data-risk]").forEach((b) => {
    b.addEventListener("click", () => setRisk(b.dataset.risk));
  });
  document.querySelectorAll("#capitalPresets [data-cap]").forEach((b) => b.addEventListener("click", () => {
    const v = parseInt(b.dataset.cap, 10);
    $("startCash").value = v;
    document.querySelectorAll("#capitalPresets .preset").forEach((x) => x.classList.toggle("active", x === b));
  }));
  setRisk(riskId);
  applyUiMode(uiMode);
  document.querySelectorAll("#uiModeToggle [data-ui]").forEach((b) => b.addEventListener("click", () => {
    applyUiMode(b.dataset.ui);
    show((location.hash || "#picks").slice(1));
  }));
  if ($("discToggle")) $("discToggle").addEventListener("click", () => {
    const f = $("discFull"); f.hidden = !f.hidden;
    $("discToggle").textContent = f.hidden ? "詳情" : "收起";
  });
  if ($("moreToFull")) $("moreToFull").addEventListener("click", () => { applyUiMode("full"); location.hash = "picks"; });
  if ($("moreHowto")) $("moreHowto").addEventListener("click", () => {
    applyUiMode("full");
    const h = $("howto"); if (h) { h.open = true; h.scrollIntoView({ behavior: "smooth" }); }
  });
  if ($("simplePfDetail")) $("simplePfDetail").addEventListener("click", () => {
    document.querySelector(".panel .seg")?.scrollIntoView({ behavior: "smooth" });
  });
  if ($("allinStartBtn")) $("allinStartBtn").addEventListener("click", () => openAllinFlow());
  // ---------- ux-fix wiring: buy any coin, 孤注一擲 (simple mode too), 詳情 sheets ----------
  async function buyAnyCoin() {
    if (!window.MCE.market) return;
    const info = await window.MCE.market.pickCoin({ title: "買幣" });
    if (info) openBuy(info);
  }
  if ($("pfBuyBtn")) $("pfBuyBtn").addEventListener("click", buyAnyCoin);
  if ($("pfAllinBtn")) $("pfAllinBtn").addEventListener("click", () => openAllinFlow());
  if ($("pfInfoBtn")) $("pfInfoBtn").addEventListener("click", () => { window.MCE.market.openSheet("模擬倉詳情", "pfDetail"); renderPortfolio(false); });
  if ($("gainerInfoBtn")) $("gainerInfoBtn").addEventListener("click", () => window.MCE.market.openSheet("急升 · 詳情", "gbDetail"));
  /** For the coin picker: 🔥 now, held, AI picks — shown first (not exclusive). */
  window.MCE.hotSymbols = () => {
    const pump = new Set([...document.querySelectorAll('.gb-row[data-gb-tier="pump"]')].map((r) => r.dataset.gbSym));
    const held = new Set([...Object.values(P.positions), ...Object.values(P.levPositions)].filter((p) => p.chain === "binance").map((p) => p.pair));
    const picks = new Set();
    const last = S.picks && S.picks.batches && S.picks.batches[S.picks.batches.length - 1];
    if (last) for (const e of last.entries || []) if (e.type === "buy" && e.chain === "binance") picks.add(e.pair_address);
    for (const x of (window.MCE.live && window.MCE.live._lastSetupPicks) || []) if (x.symbol) picks.add(x.symbol);
    return { pump, held, picks };
  };
  if ($("allinFromPicks")) $("allinFromPicks").addEventListener("click", () => openAllinFlow());
  if ($("allinCloseBtn")) $("allinCloseBtn").addEventListener("click", () => closeAllinFromBanner());
  if ($("allinAgain")) $("allinAgain").addEventListener("click", () => againAllin());
  $("pfRefresh").addEventListener("click", async () => {
    const ps = [
      ...Object.values(P.positions).map((p) => ({ chain: p.chain, pair: p.pair })),
      ...Object.values(P.levPositions).map((p) => ({ chain: p.chain, pair: p.pair })),
    ];
    const _bmPs = P.bmAtFirstBuy || P.solAtFirstBuy; if (_bmPs) ps.push({ chain: _bmPs.chain, pair: _bmPs.pair });
    if (ps.length) await fetchPairs(ps, true);
    renderPortfolio(false);
  });
  $("copyPicks").addEventListener("click", copyPicks);
  $("pfReset").addEventListener("click", () => {
    const start = parseFloat($("startCash").value) || START_CASH;
    if (confirm(`重置 Crypto.M 到 $${start.toLocaleString()}，並清空現貨＋槓桿＋孤注一擲？`)) {
      const fee = P.feePct; P = pf.fresh(start); P.feePct = fee; pf.save(P);
      if ($("allinResult")) $("allinResult").hidden = true;
      if ($("allinBanner")) $("allinBanner").hidden = true;
      renderPortfolio(false);
    }
  });
  $("feePct").addEventListener("change", () => { const v = parseFloat($("feePct").value); P.feePct = isFinite(v) ? Math.max(0, Math.min(20, v)) : SPOT_FEE_DEFAULT; pf.save(P); });
  // Expose helpers for headless tests
  window.MCE.paper = {
    openBuy, openSell, copyPicks, state: () => P,
    doOpenLev, doBuySpot, closeLev, checkLiquidations, liqPriceLong, levMark,
    calc, allinScenarios: allinScenarioHTML, effectiveStop, stopLossUsd, coinExitMeta, withCoinExit, fees: () => ({ spot: P.feePct, fut: levFeePct() }),
    LIQ_MARGIN_FRAC, setState(s) { P = s; pf.save(P); },
    openAllinFlow, executeAllin, allinActive, loadAllinRounds, endAllinRound, playOverlay, reduceMotion, closeAllinFromBanner, buyAnyCoin, openPosDetail,
    ingestPair, ensureLiveLoop, renderPortfolio,
  };
  window.MCE.onBrowseLoaded = () => {};
  window.MCE.onBnBoardLoaded = (rows) => {
    if (window.MCE.live && window.MCE.live.scoreBoardRows) renderHotBuysFromBn(window.MCE.live.scoreBoardRows(rows));
  };
  if ($("livePicksRefresh")) $("livePicksRefresh").addEventListener("click", () => loadLiveBnPicks(true));
  if ($("gainerRefresh")) $("gainerRefresh").addEventListener("click", () => loadGainerBoard(true));
  // 急升榜: own boot + rescan every 90s on ANY tab (decoupled from loadPicks / renderPicks).
  function bootGainer() {
    loadGainerBoard(false);
    if (window.MCE.live && window.MCE.live.onTick) window.MCE.live.onTick(onGainerTick);
    setInterval(() => { if (document.visibilityState === "visible") loadGainerBoard(false); }, 90_000);
    setInterval(paintGainerLive, 10_000);
    setInterval(() => { if (document.visibilityState === "visible") gbLoadX(true).then(paintXChips).catch(() => {}); }, GBX_REFRESH);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - gbLastScan > 90_000) loadGainerBoard(false); });
  }
  bootGainer();
  // Kick live BN picks ASAP for home
  loadLiveBnPicks(false);

  // 預設落地：簡單模式 + #picks
  if (!location.hash) location.replace("#picks");
  else show(location.hash.slice(1));
  window.MCE.ui = { applyUiMode, get mode() { return uiMode; } };
})();
