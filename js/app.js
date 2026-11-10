/* Crypto.M — app: screens, paper trading, accounts. Depends on I18N, Strategy, Market, Coin3D. */
(function () {
  "use strict";
  const { t } = I18N;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { const raw = JSON.stringify(v); localStorage.setItem(k, raw); return localStorage.getItem(k) === raw; } catch (_) { return false; } },
  };
  const RESCAN_MS = 2 * 60 * 1000, FEE = 0.001, MAX_LEV = 50;
  const LEVS = [1, 2, 3, 5, 10, 20, 50];
  const liqPrice = (entry, lev) => entry * (1 - 0.9 / Math.max(1, lev));
  const isDesk = () => matchMedia("(min-width: 1080px)").matches;

  /* ---------- formatting ---------- */
  const nf = (d) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  function fmtPrice(p) {
    if (!isFinite(p)) return "–";
    if (p >= 1000) return "$" + nf(0).format(p);
    if (p >= 1) return "$" + nf(p >= 100 ? 2 : 3).format(p);
    return "$" + Number(p.toPrecision(4)).toString().replace(/e-(\d+)/, (_, x) => "e-" + x);
  }
  const fmtUsd = (v) => (v < 0 ? "−$" : "$") + nf(2).format(Math.abs(v));
  const fmtUsdS = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + "$" + nf(2).format(Math.abs(v));
  const fmtPct = (v, d) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(d ?? 1) + "%";
  const fmtVol = (v) => "$" + (v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : nf(0).format(v));
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString(I18N.lang === "zh" ? "zh-HK" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const fmtDT = (ms) => new Date(ms).toLocaleString(I18N.lang === "zh" ? "zh-HK" : "en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m"; };
  function fmtAge(ms) {
    if (!ms) return "";
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return t("status.ageSec", { n: sec });
    const min = Math.floor(sec / 60);
    if (min < 60) return t("status.ageMin", { n: min });
    return t("status.ageHr", { n: Math.floor(min / 60) });
  }
  const sign = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");

  /* ---------- state ---------- */
  const S = {
    market: null, ticks: {}, series: {}, btc: null, scores: {}, bt: null, scanAt: 0, scanning: false, prog: [0, 0],
    filter: "all", sort: "score", q: "", selected: null, trade: null, podium: null, viewer: null,
    gTicks: {}, gMode: "gainers", gHideLow: false, gAt: 0, gLoading: false, gQ: "",
    mTicks: {}, mAt: 0, mLoading: false,
    awDoc: null, awAt: 0, awLoading: false,
  };
  const G_TOP = 20, G_VOL_FLOOR = 1e6;
  let closestSig = "", gainerSig = "";
  function softFlash(el) {
    if (!el) return;
    el.classList.remove("soft-flash");
    void el.offsetWidth;
    el.classList.add("soft-flash");
    clearTimeout(el._flashT);
    el._flashT = setTimeout(() => el.classList.remove("soft-flash"), 1100);
  }
  function flashIfMoved(sigRef, key, el) {
    if (!key) return sigRef;
    if (sigRef && sigRef !== key) softFlash(el);
    return key || sigRef;
  }

  /* ================= accounts ================= */
  const AUTH_KEY = "cm2:auth";
  let auth = store.get(AUTH_KEY, { users: {}, session: null });
  if (!auth || typeof auth.users !== "object") auth = { users: {}, session: null };
  const currentUser = () => (auth.session && auth.users[auth.session] ? auth.session : null);
  const normId = (s) => String(s || "").trim().toLowerCase();
  const validId = (u) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(u) || /^[a-z0-9._-]{3,32}$/.test(u);
  async function hashPass(salt, pass) {
    const data = new TextEncoder().encode(salt + ":" + pass);
    if (crypto.subtle) { const h = await crypto.subtle.digest("SHA-256", data); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
    let h = 2166136261; for (const b of data) { h ^= b; h = Math.imul(h, 16777619); } return "f" + (h >>> 0).toString(16);
  }
  const randSalt = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

  let authMode = "login";
  function openAuth(mode) {
    authMode = mode; const d = $("#authDlg");
    $("#authTitle").textContent = t("auth.title." + mode);
    $("#authGo").textContent = t("auth.go." + mode);
    $("#authSwitch").textContent = t("auth.switch." + mode);
    $("#authPass").autocomplete = mode === "signup" ? "new-password" : "current-password";
    $("#authErr").hidden = true; // keep what the user typed when switching modes
    if (!d.open) d.showModal();
    setTimeout(() => ($("#authId").value ? $("#authPass") : $("#authId")).focus(), 30);
  }
  function authError(msg) { const e = $("#authErr"); e.textContent = msg; e.hidden = false; }
  async function submitAuth(ev) {
    ev.preventDefault();
    const u = normId($("#authId").value), p = $("#authPass").value;
    if (!validId(u)) return authError(t("auth.e.id"));
    if (p.length < 6) return authError(t("auth.e.pass"));
    auth = store.get(AUTH_KEY, auth);
    const rec = auth.users[u];
    if (authMode === "signup") {
      if (rec) return authError(t("auth.e.taken", { u }));
      const salt = randSalt();
      auth.users[u] = { salt, hash: await hashPass(salt, p), created: Date.now() };
      // first account on this device inherits the guest paper money
      const guest = store.get(pfKey(null)); if (guest && !store.get(pfKey(u))) store.set(pfKey(u), guest);
    } else {
      if (!rec) return authError(t("auth.e.none", { u }));
      if ((await hashPass(rec.salt, p)) !== rec.hash) return authError(t("auth.e.wrong", { u }));
    }
    savePf();
    auth.session = u;
    if (!store.set(AUTH_KEY, auth)) { auth.session = null; return authError(t("auth.e.save")); }
    $("#authDlg").close(); $("#authPass").value = "";
    loadPf(); paintAcct(); renderPortfolio();
    toast(t(authMode === "signup" ? "auth.ok.signup" : "auth.ok.login", { u }));
  }
  function logout() {
    savePf(); auth.session = null; store.set(AUTH_KEY, auth);
    loadPf(); paintAcct(); renderPortfolio(); toast(t("auth.ok.out"));
  }
  function paintAcct() {
    const u = currentUser();
    $$("[data-acct]").forEach((b) => {
      b.textContent = u ? (u.length > 18 ? u.slice(0, 16) + "…" : u) : t("acct.login");
      b.title = u ? t("acct.logout") : "";
      b.classList.toggle("in", !!u);
    });
    $("#pfWho") && ($("#pfWho").textContent = u || t("acct.guest"));
  }
  async function acctClick() {
    if (currentUser()) { if (await ask(t("acct.askOut", { u: currentUser() }), t("acct.logout"))) logout(); }
    else openAuth("login");
  }
  /** In-page confirm (native confirm() is blocked in some embeds and looks dated on phones). */
  function ask(msg, okLabel) {
    const d = $("#askDlg");
    $("#askMsg").textContent = msg; $("#askOk").textContent = okLabel; $("#askNo").textContent = t("t.cancel");
    return new Promise((res) => {
      const done = (v) => { d.removeEventListener("close", onClose); $("#askOk").onclick = $("#askNo").onclick = null; if (d.open) d.close(); res(v); };
      const onClose = () => done(false);
      $("#askOk").onclick = () => done(true); $("#askNo").onclick = () => done(false);
      d.addEventListener("close", onClose); d.showModal();
    });
  }

  /* ================= paper portfolio ================= */
  const pfKey = (u) => "cm2:pf:" + (u || "guest");
  const fresh = (start) => ({ start, cash: start, positions: [], history: [], created: Date.now() });
  let P = fresh(5000);
  function migratePos(x) {
    if (x.auto == null) x.auto = true;
    if (!(x.liq > 0) && x.entry > 0 && x.lev > 0) x.liq = liqPrice(x.entry, x.lev);
    return x;
  }
  function loadPf() {
    const p = store.get(pfKey(currentUser()));
    P = p && Array.isArray(p.positions) ? p : fresh(5000);
    P.positions = (P.positions || []).map(migratePos);
    if (P.cash < 0) P.cash = 0;
  }
  function savePf() { if (Array.isArray(P.history) && P.history.length > 300) P.history.length = 300; if (P.cash < 0) P.cash = 0; store.set(pfKey(currentUser()), P); }
  const priceOf = (sym) => (S.ticks[sym] ? S.ticks[sym].price : NaN);
  const posValue = (x, p) => x.frac * x.margin + x.frac * x.qty * (p - x.entry);
  function equity() { let e = P.cash; for (const x of P.positions) { const p = priceOf(x.sym); e += posValue(x, isFinite(p) ? p : x.entry); } return e; }

  function openTrade(sym, amount, lev, auto) {
    ensureTick(sym);
    const r = S.scores[sym], tk = S.ticks[sym];
    if (!tk) return false;
    lev = Math.min(MAX_LEV, Math.max(1, +lev || 1));
    const price = tk.price, notional = amount * lev, fee = notional * FEE;
    if (amount + fee > P.cash + 1e-9) { toast(t("t.nocash")); return false; }
    const atr = r && r.metrics ? r.metrics.atr : price * 0.02;
    const plan = Strategy.planFor(price, atr);
    const useAuto = auto !== false;
    P.cash -= amount + fee;
    P.positions.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sym, base: tk.base, entry: price,
      qty: notional / price, margin: amount, lev, liq: liqPrice(price, lev), auto: useAuto,
      stop: plan.stop, t1: plan.t1, t2: plan.t2, half: false, frac: 1,
      openedAt: Date.now(), until: Date.now() + plan.holdHours * 3600e3, score: r ? r.score : 0, realized: -fee, notes: [] });
    savePf(); return true;
  }
  function isTokenizedSym(sym) {
    const base = String(sym || "").replace(/USDT$/, "");
    return !!(S.tokenized && S.tokenized.has(base));
  }
  /** Merge a Gainers-board tick into S.ticks so detail/Buy work outside the score universe. Never re-inject bStocks. */
  function ensureTick(sym) {
    if (isTokenizedSym(sym)) { if (S.ticks[sym]) delete S.ticks[sym]; return null; }
    if (S.ticks[sym]) return S.ticks[sym];
    const g = S.gTicks[sym] || S.mTicks[sym];
    if (g) { S.ticks[sym] = Object.assign({}, g); return S.ticks[sym]; }
    return null;
  }
  function closePart(x, f, price, how) {
    f = Math.min(f, x.frac);
    if (f <= 0) return;
    let exit = price;
    if (how === "liq") {
      const floor = x.liq > 0 ? x.liq : liqPrice(x.entry, x.lev);
      exit = Math.max(price, floor);
    }
    let part = f * x.margin + f * x.qty * (exit - x.entry);
    let fee = f * x.qty * exit * FEE;
    let proceeds = part - fee;
    // Loss incl fees never exceeds remaining margin; cash never goes negative from this close.
    const marginLeft = f * x.margin;
    if (how === "liq" && proceeds < 0) proceeds = 0;
    if (how === "liq" && marginLeft - proceeds > marginLeft + 1e-9) proceeds = 0;
    if (how === "liq") proceeds = Math.max(0, Math.min(marginLeft, proceeds));
    P.cash += proceeds;
    if (P.cash < 0) P.cash = 0;
    x.realized += proceeds - marginLeft;
    x.frac -= f;
    x.notes.push(how);
    if (x.frac <= 1e-9) {
      P.positions = P.positions.filter((y) => y !== x);
      P.history.unshift({ sym: x.sym, base: x.base, entry: x.entry, exit, openedAt: x.openedAt, closedAt: Date.now(),
        pnl: x.realized, pct: x.realized / x.margin, how: x.notes, lev: x.lev, margin: x.margin, auto: !!x.auto });
    }
  }
  /** Exits: always liquidation; when auto on also stop / targets / time. Manual sell is always available. */
  function checkExits() {
    let changed = false;
    for (const x of [...P.positions]) {
      const p = priceOf(x.sym); if (!isFinite(p)) continue;
      const floor = x.liq > 0 ? x.liq : liqPrice(x.entry, x.lev);
      if (p <= floor) { closePart(x, x.frac, p, "liq"); changed = true; continue; }
      if (x.auto === false) continue;
      if (p <= x.stop) { closePart(x, x.frac, x.stop, x.half ? "be" : "stop"); changed = true; continue; }
      if (!x.half && p >= x.t1) { closePart(x, 0.5, x.t1, "t1"); x.half = true; x.stop = x.entry; changed = true; }
      if (x.half && p >= x.t2 && x.frac > 0) { closePart(x, x.frac, x.t2, "t2"); changed = true; continue; }
      if (Date.now() >= x.until && x.frac > 0) { closePart(x, x.frac, p, "time"); changed = true; }
    }
    if (changed) { savePf(); renderPortfolio(); }
  }

  /* ================= market + scoring ================= */
  function rescore() {
    for (const sym in S.series) {
      const s = S.series[sym], tk = S.ticks[sym]; if (!tk) continue;
      S.scores[sym] = Strategy.scoreAt(s, s.n - 1, S.btc, tk.price);
    }
  }
  async function scan() {
    if (S.scanning) return; S.scanning = true; paintStatus();
    try {
      const { ticks, series } = await S.market.scan((d, n) => { S.prog = [d, n]; paintStatus(); });
      S.tokenized = await Market.loadTokenizedBases();
      S.ticks = {}; for (const tk of ticks) { if (!isTokenizedSym(tk.sym)) S.ticks[tk.sym] = tk; }
      S.series = series;
      if (S.series) { for (const sym of Object.keys(S.series)) { if (isTokenizedSym(sym) && sym !== "BTCUSDT") delete S.series[sym]; } }
      S.scores = {}; // drop leftover scores (e.g. SOXSB) from a prior universe
      S.btc = Strategy.indexSeries(series.BTCUSDT);
      if (!S.ticks.BTCUSDT && series.BTCUSDT) { const b = series.BTCUSDT; S.ticks.BTCUSDT = { sym: "BTCUSDT", base: "BTC", name: "Bitcoin", price: b.c[b.n - 1], open24: b.c[b.n - 97], qv24: 0 }; }
      rescore(); S.scanAt = Date.now();
      logSignals();
      if (S.selected && (isTokenizedSym(S.selected) || (!S.ticks[S.selected] && !S.gTicks[S.selected]))) S.selected = null;
      if (!S.selected) { const top = ranked("early")[0] || ranked("all")[0]; if (top && isDesk()) S.selected = top; }
      const snap = takeRadarSnap();
      const closestKey = snap.slice(0, 10).map((x) => x.sym).join(",");
      closestSig = flashIfMoved(closestSig, closestKey, $("#closestList"));
      renderAll();
      setTimeout(() => { S.bt = Strategy.backtest(S.series, S.btc); renderBacktest(); renderHero(); }, 50);
    } catch (e) {
      console.warn("scan failed", e);
      if (S.market.mode === "live") { S.market = Market.demo; toast(t("status.demoWhy")); S.scanning = false; return scan(); }
    } finally { S.scanning = false; paintStatus(); }
  }
  function onPrices(m) {
    for (const sym in m) {
      const raw = m[sym];
      const px = typeof raw === "number" ? raw : +raw.c;
      if (!isFinite(px)) continue;
      const tk = S.ticks[sym];
      if (tk) {
        tk.price = px;
        if (raw && typeof raw === "object") {
          if (isFinite(+raw.o) && +raw.o > 0) tk.open24 = +raw.o;
          if (isFinite(+raw.q) && +raw.q > 0) tk.qv24 = +raw.q;
        }
        const s = S.series[sym]; if (s) { const i = s.n - 1; s.c[i] = px; if (px > s.h[i]) s.h[i] = px; if (px < s.l[i]) s.l[i] = px; }
      }
      const g = S.gTicks[sym];
      if (g) {
        g.price = px;
        if (raw && typeof raw === "object") {
          if (isFinite(+raw.o) && +raw.o > 0) g.open24 = +raw.o;
          if (isFinite(+raw.q) && +raw.q > 0) g.qv24 = +raw.q;
        }
      }
      const mk = S.mTicks[sym];
      if (mk) {
        mk.price = px;
        if (raw && typeof raw === "object") {
          if (isFinite(+raw.o) && +raw.o > 0) mk.open24 = +raw.o;
          if (isFinite(+raw.q) && +raw.q > 0) mk.qv24 = +raw.q;
        }
      }
    }
    checkExits(); scheduleLive(); scheduleGainers();
  }
  let liveT = 0, gLiveT = 0;
  function scheduleLive() {
    if (liveT) return;
    // One rescore → one radar snapshot → podium + Closest refresh together (never lists-only).
    liveT = setTimeout(() => { liveT = 0; rescore(); takeRadarSnap(); renderHero(); renderLists(); renderDetail(false); renderPortfolio(); if (document.body.dataset.view === "allin" && !document.querySelector("#aiNow button:active")) renderAllinNow(S.aiStart || 1000); }, 1500);
  }
  /** Gainers board patches ≤1/s so taps are never swallowed. */
  function scheduleGainers() {
    if (gLiveT) return;
    gLiveT = setTimeout(() => { gLiveT = 0; if (document.body.dataset.view === "gainers") renderGainers(); }, 1000);
  }
  async function loadCatalog() {
    if (!S.market || S.mLoading) return;
    S.mLoading = true;
    try {
      S.tokenized = await Market.loadTokenizedBases();
      const ticks = await S.market.tickersCatalog();
      const map = {};
      for (const tk of ticks) { if (!isTokenizedSym(tk.sym)) map[tk.sym] = tk; }
      S.mTicks = map; S.mAt = Date.now();
    } catch (e) { console.warn("catalog load failed", e); }
    finally { S.mLoading = false; renderLists(); }
  }
  async function loadGainers() {
    if (!S.market || S.gLoading) return;
    S.gLoading = true; renderGainers();
    let movedKey = "";
    try {
      const ticks = await S.market.tickersAll();
      const map = {};
      for (const tk of ticks) map[tk.sym] = tk;
      S.gTicks = map; S.gAt = Date.now();
      movedKey = gainerSyms().join(",");
    } catch (e) { console.warn("gainers load failed", e); }
    finally {
      S.gLoading = false; renderGainers();
      if (movedKey) gainerSig = flashIfMoved(gainerSig, movedKey, $("#gainerList"));
    }
  }
  function coinQueryHit(tk, q) {
    if (!tk || !q) return !q;
    const sym = String(tk.sym || "").toUpperCase();
    const base = String(tk.base || sym.replace(/USDT$/, "")).toUpperCase();
    const name = String(tk.name || "").toUpperCase();
    return sym.includes(q) || base.includes(q) || name.includes(q);
  }
  function gainerSyms() {
    let list = Object.keys(S.gTicks);
    const q = (S.gQ || "").trim().toUpperCase();
    // Non-empty query: full tickersAll / gainerEligible list (no tab slice, no $1M hide, no G_TOP cap).
    if (q) {
      list = list.filter((s) => coinQueryHit(S.gTicks[s], q));
      const exact = (s) => {
        const tk = S.gTicks[s] || {};
        const base = String(tk.base || s.replace(/USDT$/, "")).toUpperCase();
        return (base === q || s === q || s === q + "USDT") ? 1 : 0;
      };
      list.sort((a, b) => exact(b) - exact(a) || (S.gTicks[b].qv24 || 0) - (S.gTicks[a].qv24 || 0));
      return list;
    }
    if (S.gHideLow) list = list.filter((s) => S.gTicks[s].qv24 >= G_VOL_FLOOR);
    const ch = (s) => { const tk = S.gTicks[s]; return tk.open24 > 0 ? tk.price / tk.open24 - 1 : 0; };
    if (S.gMode === "losers") list.sort((a, b) => ch(a) - ch(b));
    else if (S.gMode === "all") list.sort((a, b) => S.gTicks[b].qv24 - S.gTicks[a].qv24);
    else list.sort((a, b) => ch(b) - ch(a));
    return list.slice(0, G_TOP);
  }
  function ranked(filter) {
    const out = [];
    for (const sym in S.scores) {
      const r = S.scores[sym];
      if (!r || !r.stage) continue;
      if (!S.ticks[sym] || isTokenizedSym(sym)) continue; // no leftover bStocks / prior-universe rows
      if (sym === "BTCUSDT" && filter !== "all") continue;
      // Stage chips: exact match only. "all" = every scored stage (early/build/late/quiet).
      if (filter === "all" || r.stage === filter) out.push(sym);
    }
    return out.sort((a, b) => (S.scores[b].score || 0) - (S.scores[a].score || 0));
  }
  /** Freeze ranked("all") scores once so podium + Closest never diverge mid-paint. */
  function takeRadarSnap() {
    const order = ranked("all");
    S.radarSnap = order.map((sym) => {
      const r = S.scores[sym], tk = S.ticks[sym];
      return { sym, score: r.score, stage: r.stage, ret1h: r.metrics.ret1h, base: tk ? tk.base : sym.replace(/USDT$/, "") };
    });
    return S.radarSnap;
  }
  function radarSnap() { return S.radarSnap && S.radarSnap.length ? S.radarSnap : takeRadarSnap(); }

  /* ================= signal log ================= */
  const LOG_KEY = "cm2:siglog";
  function logSignals() {
    const log = store.get(LOG_KEY, []), now = Date.now();
    for (const sym of ranked("early")) {
      if (log.some((x) => x.sym === sym && now - x.t < 4 * 3600e3)) continue;
      log.unshift({ sym, base: S.ticks[sym].base, t: now, price: S.ticks[sym].price, score: S.scores[sym].score, p1: null, p4: null, demo: S.market.mode === "demo" });
    }
    log.length = Math.min(log.length, 200);
    store.set(LOG_KEY, log); checkLog();
  }
  async function checkLog() {
    const log = store.get(LOG_KEY, []), now = Date.now(); let ch = false;
    for (const x of log) {
      for (const [k, h] of [["p1", 1], ["p4", 4]]) {
        if (x[k] != null || now < x.t + h * 3600e3) continue;
        let p = null;
        if (!x.demo && S.market.mode === "live") { try { p = await S.market.priceAt(x.sym, x.t + h * 3600e3); } catch (_) {} }
        if (p == null && x.demo) p = priceOf(x.sym);
        if (p != null && isFinite(p)) { x[k] = p; ch = true; }
      }
    }
    if (ch) store.set(LOG_KEY, log);
    renderLog();
  }

  /* ================= rendering ================= */
  /** Coin thumbnail: the 3D-rendered coin once ready, meanwhile the real logo (or initials) on a flat coin. */
  function badge(base, size) {
    const sz = size ? `--s:${size}px` : "";
    const done = Coin3D.thumb.ready && Coin3D.thumb.ready(base);
    if (done) return `<img class="coin3d" style="${sz}" src="${done}" alt="${esc(base)}">`;
    if (base !== "?") wantThumb(base);
    const c = Coin3D.colorFor(base), logo = Coin3D.logoUrl(base);
    return `<span class="coin" style="--c:${c};--c2:${Coin3D.shade(c, 0.25)};--c3:${Coin3D.shade(c, -0.25)};${sz}"><span>${esc(base.slice(0, 4))}</span>${logo ? `<img src="${esc(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span>`;
  }
  const thumbWait = new Set(); let thumbT = 0;
  function wantThumb(base) {
    if (thumbWait.has(base) || !window.THREE || !Coin3D.supported()) return;
    thumbWait.add(base);
    Coin3D.thumb(base).then((u) => { if (!u) return; clearTimeout(thumbT); thumbT = setTimeout(() => { takeRadarSnap(); renderHero(); renderLists(); renderPortfolio(); }, 120); });
  }
  /** Full-body engineer mascot image (3D-rendered), empty until the renderer has made it. */
  function mascotImg() { return `<img class="mascot-img" data-icon="engineer" alt="" ${S.mascotUrl ? `src="${S.mascotUrl}"` : "hidden"}>`; }
  /** Swap the flat SVG icons for 3D-rendered ones once the renderer has made them. */
  function load3DIcons() {
    if (!window.THREE || !Coin3D.supported()) return;
    for (const kind of ["engineerHead", "engineer", "radar", "gainers", "aiwatch", "stack", "markets", "wallet", "trophy"]) {
      Coin3D.icon(kind).then((url) => {
        if (!url) return;
        if (kind === "engineer") S.mascotUrl = url;
        $$(`img[data-icon="${kind}"]`).forEach((im) => { im.src = url; im.hidden = false; im.parentElement.classList.add("has3d"); });
      });
    }
  }
  function spark(s, w, h) {
    if (!s) return "";
    const n = 96, a = s.c.slice(s.n - n); let lo = Infinity, hi = -Infinity;
    for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const pts = Array.from(a, (v, i) => `${(i / (n - 1) * w).toFixed(1)},${(h - 2 - (v - lo) / (hi - lo || 1) * (h - 4)).toFixed(1)}`).join(" ");
    return `<svg class="spark ${sign(a[n - 1] - a[0])}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
  }
  function scoreRing(score, stage) {
    const r = 17, c = 2 * Math.PI * r, off = c * (1 - score / 100);
    return `<span class="ring ${stage}" aria-label="${t("d.score")} ${score}"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="${r}"/><circle class="v" cx="20" cy="20" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg><b>${score}</b></span>`;
  }
  function reasonChips(r) { return Strategy.reasons(r).map((x) => `<span class="chip ${x.k === "why.late" ? "late" : ""}">${esc(t(x.k, { v: x.v }))}</span>`).join(""); }

  function row(sym) {
    if (!S.scores[sym] || !S.ticks[sym]) return "";
    return `<li><button type="button" class="row ${S.selected === sym ? "sel" : ""}" data-sym="${esc(sym)}">${rowInner(sym)}</button></li>`;
  }
  function rowInner(sym) {
    const r = S.scores[sym], tk = S.ticks[sym]; if (!r || !tk || !r.stage || !r.metrics) return "";
    const ch24 = tk.open24 > 0 ? tk.price / tk.open24 - 1 : 0;
    return `${badge(tk.base)}
      <span class="r-main"><span class="r-top"><b class="sym">${esc(tk.base)}</b><span class="stage ${r.stage}">${t("stage." + r.stage)}</span></span>
        <span class="r-why">${reasonChips(r) || `<span class="muted">${esc(tk.name)}</span>`}</span></span>
      <span class="r-spark">${spark(S.series[sym], 96, 32)}</span>
      <span class="r-px"><b>${fmtPrice(tk.price)}</b><span class="${sign(r.metrics.ret1h)}">${fmtPct(r.metrics.ret1h)} <i>1h</i></span><span class="${sign(ch24)} sub">${fmtPct(ch24)} <i>24h</i></span></span>
      ${scoreRing(r.score, r.stage)}`;
  }
  /** Rebuild a list only when its order changes; otherwise patch rows in place so taps are never lost. */
  function paintList(el, syms, emptyHTML) {
    const key = syms.join(",");
    if (!syms.length) { el.dataset.key = ""; el.innerHTML = emptyHTML; return; }
    if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = syms.map(row).join(""); return; }
    for (const b of el.querySelectorAll("button.row")) {
      const html = rowInner(b.dataset.sym);
      if (b._h !== html) { b.innerHTML = html; b._h = html; }
      b.classList.toggle("sel", S.selected === b.dataset.sym);
    }
  }
  function renderLists() {
    const snap = radarSnap();
    const counts = { early: ranked("early").length, build: ranked("build").length, late: ranked("late").length, all: snap.length };
    $$("#radarFilters [data-count]").forEach((b) => (b.textContent = counts[b.dataset.count] || "0"));
    $$("#radarFilters [data-f]").forEach((b) => b.classList.toggle("on", b.dataset.f === S.filter));
    // Closest-to-early is score-rank mixed stages — only on All. Stage chips must show stage-only rows (badge match).
    const closestSec = $("#closestList") && $("#closestList").closest("section.closest");
    const closestEl = $("#closestList");
    if (S.filter === "all") {
      if (closestSec) closestSec.hidden = false;
      const closest = snap.slice(0, 10).map((x) => x.sym);
      if (closestEl) {
        paintList(closestEl, closest, `<li class="empty">${S.scanAt ? t("radar.closestNone") : `<span class="loader"></span>`}</li>`);
        const bySym = Object.fromEntries(snap.map((x) => [x.sym, x]));
        for (const b of closestEl.querySelectorAll("button.row")) {
          const x = bySym[b.dataset.sym]; if (!x) continue;
          const ring = b.querySelector(".ring b"); if (ring) ring.textContent = String(x.score);
          const st = b.querySelector(".stage"); if (st) { st.className = "stage " + x.stage; st.textContent = t("stage." + x.stage); }
        }
      }
    } else {
      if (closestSec) closestSec.hidden = true;
      if (closestEl) { closestEl.dataset.key = ""; closestEl.innerHTML = ""; }
    }
    const list = ranked(S.filter);
    const radarEl = $("#radarList");
    // Force rebuild when the stage chip changes so a failed paint cannot leave the previous "all" dump.
    if (radarEl && radarEl.dataset.filter !== S.filter) { radarEl.dataset.filter = S.filter; radarEl.dataset.key = ""; }
    const emptyKey = S.filter === "early" ? "radar.none" : S.filter === "build" ? "radar.noneBuild" : S.filter === "late" ? "radar.noneLate" : "radar.none";
    paintList(radarEl, list, `<li class="empty">${S.scanAt ? t(emptyKey) : `<span class="loader"></span>`}</li>`);
    // Markets: full eligible USDT catalog (no MAX_COINS slice, no $3M floor). Radar stays scored-60.
    const q = S.q.trim().toUpperCase();
    const mtk = (s) => S.mTicks[s] || S.ticks[s];
    let m = Object.keys(S.mTicks).filter((s) => {
      const tk = S.mTicks[s];
      if (!tk || isTokenizedSym(s)) return false;
      if (!q) return true;
      const base = (tk.base || s.replace(/USDT$/, "")).toUpperCase();
      const name = (tk.name || "").toUpperCase();
      return s.includes(q) || base.includes(q) || name.includes(q);
    });
    const ch = (s) => { const tk = mtk(s); return tk && tk.open24 > 0 ? tk.price / tk.open24 - 1 : 0; };
    const vol = (s) => (mtk(s) && mtk(s).qv24) || 0;
    const sc = (s) => (S.scores[s] && S.scores[s].score) || 0;
    m.sort(S.sort === "change" ? (a, b) => ch(b) - ch(a) : S.sort === "vol" ? (a, b) => vol(b) - vol(a) : (a, b) => sc(b) - sc(a) || vol(b) - vol(a));
    $$("#mSort [data-sort]").forEach((b) => b.classList.toggle("on", b.dataset.sort === S.sort));
    const mEmpty = (S.mAt || S.scanAt) ? t(q ? "m.empty" : "m.none") : `<span class="loader"></span>`;
    paintMarketList($("#marketList"), m, `<li class="empty">${mEmpty}</li>`);
  }
  function mRow(sym) {
    const tk = S.mTicks[sym] || S.ticks[sym]; if (!tk) return "";
    return `<li><button type="button" class="row ${S.selected === sym ? "sel" : ""}" data-sym="${esc(sym)}">${mRowInner(sym)}</button></li>`;
  }
  function mRowInner(sym) {
    const tk = S.mTicks[sym] || S.ticks[sym]; if (!tk) return "";
    const ch24 = tk.open24 > 0 ? tk.price / tk.open24 - 1 : 0;
    const r = S.scores[sym];
    // Unscored rows: price / 24h / vol only — no fake Early Score.
    const stage = r && r.stage ? `<span class="stage ${r.stage}">${t("stage." + r.stage)}</span>` : "";
    const ring = r && r.stage ? scoreRing(r.score, r.stage) : "";
    const sparkSvg = r && S.series[sym] ? `<span class="r-spark">${spark(S.series[sym], 96, 32)}</span>` : "";
    const why = r ? (reasonChips(r) || `<span class="muted">${esc(tk.name)}</span>`) : `<span class="muted">${esc(tk.name)}</span>`;
    const px1h = r && r.metrics ? `<span class="${sign(r.metrics.ret1h)}">${fmtPct(r.metrics.ret1h)} <i>1h</i></span>` : "";
    return `${badge(tk.base)}
      <span class="r-main"><span class="r-top"><b class="sym">${esc(tk.base)}</b>${stage}</span>
        <span class="r-why">${why}</span></span>
      ${sparkSvg}
      <span class="r-px"><b>${fmtPrice(tk.price)}</b>${px1h}<span class="${sign(ch24)} ${r && r.metrics ? "sub" : ""}">${fmtPct(ch24)} <i>24h</i></span><span class="g-voln">${fmtVol(tk.qv24)}</span></span>
      ${ring}`;
  }
  function paintMarketList(el, syms, emptyHTML) {
    const key = syms.join(",");
    if (!syms.length) { el.dataset.key = ""; el.innerHTML = emptyHTML; return; }
    if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = syms.map(mRow).join(""); return; }
    for (const b of el.querySelectorAll("button.row")) {
      const html = mRowInner(b.dataset.sym);
      if (b._h !== html) { b.innerHTML = html; b._h = html; }
      b.classList.toggle("sel", S.selected === b.dataset.sym);
    }
  }
  function gRow(sym) {
    const tk = S.gTicks[sym] || S.ticks[sym]; if (!tk) return "";
    return `<li><button type="button" class="row g-row ${S.selected === sym ? "sel" : ""}" data-sym="${esc(sym)}">${gRowInner(sym)}</button></li>`;
  }
  function gRowInner(sym) {
    const tk = S.gTicks[sym] || S.ticks[sym]; if (!tk) return "";
    const ch24 = tk.open24 > 0 ? tk.price / tk.open24 - 1 : 0;
    const r = S.scores[sym];
    const chip = r ? `<span class="chip score">${r.score}</span>` : "";
    return `${badge(tk.base)}
      <span class="r-main"><span class="r-top"><b class="sym">${esc(tk.base)}</b>${chip}</span>
        <span class="r-why"><span class="muted">${esc(tk.name)}</span></span></span>
      <span class="r-px"><b>${fmtPrice(tk.price)}</b><span class="${sign(ch24)}">${fmtPct(ch24)} <i>24h</i></span><span class="g-voln">${fmtVol(tk.qv24)}</span></span>`;
  }
  // Keep keyed buttons alive across rank swaps; never move a row under an active hand.
  let gInteractionUntil = 0, gPointerDown = false;
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#gainerList")) gPointerDown = true;
  });
  document.addEventListener("pointerup", () => { gPointerDown = false; gInteractionUntil = Date.now() + 350; scheduleGainers(); });
  document.addEventListener("pointercancel", () => { gPointerDown = false; gInteractionUntil = Date.now() + 350; scheduleGainers(); });
  window.addEventListener("scroll", () => { gInteractionUntil = Date.now() + 500; scheduleGainers(); }, { passive: true });
  function paintGainerList(el, syms, emptyHTML) {
    const active = document.activeElement;
    if (gPointerDown || Date.now() < gInteractionUntil || (active && el.contains(active))) {
      scheduleGainers(); return;
    }
    if (!syms.length) {
      if (el.dataset.key !== "empty") { el.replaceChildren(); el.insertAdjacentHTML("beforeend", emptyHTML); el.dataset.key = "empty"; }
      return;
    }
    const existing = new Map([...el.querySelectorAll("button.row")].map((button) => [button.dataset.sym, button.parentElement]));
    const wanted = new Set(syms);
    for (const child of [...el.children]) {
      const button = child.querySelector("button.row");
      if (!button || !wanted.has(button.dataset.sym)) child.remove();
    }
    syms.forEach((sym, index) => {
      let li = existing.get(sym);
      if (!li) {
        li = document.createElement("li");
        li.innerHTML = gRow(sym).replace(/^<li>|<\/li>$/g, "");
      }
      const button = li.querySelector("button.row");
      const html = gRowInner(sym);
      if (button._h !== html) { button.innerHTML = html; button._h = html; }
      button.classList.toggle("sel", S.selected === sym);
      if (el.children[index] !== li) el.insertBefore(li, el.children[index] || null);
    });
    el.dataset.key = syms.join(",");
  }
  function renderGainers() {
    const el = $("#gainerList"); if (!el) return;
    $$("#gMode [data-gmode]").forEach((b) => b.classList.toggle("on", b.dataset.gmode === S.gMode));
    const hide = $("#gHideLow"); if (hide) hide.checked = !!S.gHideLow;
    const q = (S.gQ || "").trim();
    const box = $("#gSearch"); if (box && box.value !== S.gQ) box.value = S.gQ;
    const syms = gainerSyms();
    const meta = $("#gMeta");
    if (meta) meta.textContent = S.gAt ? t(q ? "g.searchMeta" : "g.meta", { n: syms.length }) : "";
    const emptyKey = q ? "g.searchEmpty" : "g.empty";
    paintGainerList(el, syms, `<li class="empty">${S.gLoading || !S.gAt ? t("g.loading") : t(emptyKey)}</li>`);
  }


  /* ================= AI Watch (same-origin data/ai_watch.json; 0 client secrets) ================= */
  async function loadAiWatch() {
    S.awLoading = true; renderAiWatch();
    try {
      const r = await fetch("data/ai_watch.json", { cache: "no-store" });
      if (!r.ok) throw new Error("ai_watch " + r.status);
      const doc = await r.json();
      if (!doc || typeof doc !== "object") throw new Error("bad ai_watch");
      S.awDoc = doc; S.awAt = Date.now();
      for (const e of doc.entries || []) {
        if (e && e.symbol) ensureTick(e.symbol);
      }
    } catch (err) {
      console.warn("ai_watch load failed", err);
    }
    S.awLoading = false; renderAiWatch();
  }

  function awVerdictClass(v) {
    if (v === "熱") return "hot";
    if (v === "升溫") return "warm";
    return "cold";
  }

  function renderAiWatch() {
    const list = $("#aiWatchList"); if (!list) return;
    const doc = S.awDoc;
    const meta = $("#awMeta");
    const capEl = $("#awCap");
    const entries = (doc && Array.isArray(doc.entries)) ? doc.entries : [];
    if (meta) {
      meta.textContent = S.awAt && doc
        ? t("aw.meta", { t: doc.updated_at ? String(doc.updated_at).replace("T", " ").slice(0, 19) : fmtTime(S.awAt), n: entries.length })
        : "";
    }
    if (capEl) {
      const cap = doc && doc.cap;
      if (cap) {
        capEl.textContent = cap.cap_reached
          ? t("aw.capHit")
          : t("aw.cap", { u: cap.calls_today ?? 0, c: cap.daily_cap ?? 300 });
        capEl.classList.toggle("cap-hit", !!cap.cap_reached);
      } else {
        capEl.textContent = "";
        capEl.classList.remove("cap-hit");
      }
    }
    if (!entries.length) {
      list.innerHTML = `<li class="empty">${S.awLoading || !S.awAt ? t("aw.loading") : t("aw.empty")}</li>`;
      return;
    }
    list.innerHTML = entries.map((e) => {
      const sym = e.symbol;
      const base = e.base || (S.ticks[sym] && S.ticks[sym].base) || String(sym || "").replace(/USDT$/, "");
      const x = e.x || {};
      const g = e.grok || {};
      const reasons = (e.reason || []).map((r) => `<span class="chip">${esc(t("aw.reason." + r))}</span>`).join("");
      const verdict = x.verdict || g.verdict || "冷";
      const line = x.one_line || g.one_line || "";
      const shill = x.shill_flag ? `<span class="chip shill">${esc(t("aw.shill"))}</span>` : "";
      const spike = x.spike_ratio != null ? `<span class="chip">${esc(t("aw.spike", { v: Number(x.spike_ratio).toFixed(1) }))}</span>` : "";
      const posts = x.posts_last_1h != null ? `<span class="chip">${esc(t("aw.posts", { n: x.posts_last_1h }))}</span>` : "";
      const tone = g.tone ? `<span class="chip">${esc(t("aw.tone." + g.tone))}</span>` : "";
      const summary = g.summary ? `<p class="aw-grok"><b>${esc(t("aw.grok"))}</b> · ${esc(g.summary)}</p>` : "";
      return `<li><button type="button" class="row aw-row ${S.selected === sym ? "sel" : ""}" data-sym="${esc(sym)}">
        <span class="r-top"><b class="sym">${esc(base)}</b><span class="aw-verdict ${awVerdictClass(verdict)}">${esc(verdict)}</span>${shill}${reasons}${spike}${posts}${tone}</span>
        <span class="aw-line">${esc(line)}</span>
        ${summary}
      </button></li>`;
    }).join("");
  }

  function heroCoins() {
    // Podium = top 3 from the same radarSnap Closest uses. Do not invent Early labels just to fill it.
    return radarSnap().slice(0, 3);
  }
  let heroKey = "";
  function renderHero() {
    const topRows = heroCoins();
    const top = topRows.map((x) => x.sym);
    $("#heroMeta").textContent = S.scanAt ? t("radar.updated", { t: fmtTime(S.scanAt) }) + " · " + t("radar.tap") : "";
    // Include scores in the key so podium 3D + labels refresh when scores move without rank churn.
    const key = topRows.map((x) => x.sym + ":" + x.score + ":" + x.stage).join(",");
    if (S.podium && key !== heroKey) {
      S.podium.set(topRows.map((x) => ({ sym: x.sym, base: x.base || (S.ticks[x.sym] && S.ticks[x.sym].base), score: x.score, stage: x.stage })));
      heroKey = key;
    }
    if (!S.podium) $("#podium").innerHTML = `<div class="podium-flat">${top.map((s) => badge(S.ticks[s].base, 84)).join("")}</div>`;
    const order = [topRows[1], topRows[0], topRows[2]];
    $("#podiumLabels").innerHTML = order.map((x, i) => x ? `<button type="button" class="pl ${i === 1 ? "first" : ""}" data-sym="${esc(x.sym)}">
      <b>${esc(x.base || (S.ticks[x.sym] && S.ticks[x.sym].base) || x.sym)}</b><span class="pl-score">${x.score}</span><span class="pl-stage">${t("stage." + x.stage)}</span>
      <span class="${sign(x.ret1h)}">${fmtPct(x.ret1h)} 1h</span></button>` : `<span></span>`).join("");
    const bt = S.bt;
    $("#btLine").innerHTML = bt && bt.n ? `<span>${S.market.mode === "demo" ? esc(t("radar.btDemo")) + " · " : ""}${esc(t("radar.bt", {
      d: Math.max(1, Math.round((Date.now() - bt.from) / 864e5)), n: bt.n, win: Math.round(bt.win * 100) + "%", avg: fmtPct(bt.avg, 2), base: fmtPct(bt.baseline.avg, 2) }))}</span>
      <a href="#record">${esc(t("nav.record"))}</a>` : "";
  }

  function chart(sym, plan) {
    const s = S.series[sym]; if (!s) return "";
    const W = 600, H = 180, n = 96, a = s.c.slice(s.n - n);
    let lo = Math.min(...a, plan.stop), hi = Math.max(...a, plan.t1);
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const y = (v) => (H - (v - lo) / (hi - lo) * H).toFixed(1);
    const pts = Array.from(a, (v, i) => `${(i / (n - 1) * W).toFixed(1)},${y(v)}`).join(" ");
    const line = (v, cls) => v <= hi && v >= lo ? `<line class="${cls}" x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>` : "";
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t("d.chart"))}">
      <defs><linearGradient id="cg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      <polygon class="area" points="0,${H} ${pts} ${W},${H}"/>
      ${line(plan.t1, "l-t1")}${line(plan.entry, "l-en")}${line(plan.stop, "l-st")}
      <polyline class="pl" points="${pts}"/></svg>
      <p class="legend"><span class="lg-t1">${t("d.t1")}</span><span class="lg-en">${t("d.entry")}</span><span class="lg-st">${t("d.stop")}</span></p>`;
  }

  function detailHTML(sym) {
    ensureTick(sym);
    const r = S.scores[sym], tk = S.ticks[sym];
    if (!tk) return `<div class="d-empty">${mascotImg()}<p>${esc(t("d.pick"))}</p></div>`;
    const ch24 = tk.open24 > 0 ? tk.price / tk.open24 - 1 : 0;
    const tr = S.trade && S.trade.sym === sym ? S.trade : null;
    // Outside score universe: Buy stays on, no fake Early Score.
    if (!r) {
      const atr = tk.price * 0.02, plan = Strategy.planFor(tk.price, atr);
      return `<div class="d-head">
        <div class="d-3d" data-viewer>${badge(tk.base, 120)}</div>
        <div class="d-id"><span class="stage quiet">${t("stage.quiet")}</span><h2>${esc(tk.base)}</h2><p class="muted">${esc(tk.name)}</p>
          <p class="d-px" data-part="px"><b>${fmtPrice(tk.price)}</b> <span class="${sign(ch24)}">${fmtPct(ch24)} 24h</span></p></div>
      </div>
      <p class="muted" data-part="chart">${t("d.vol")} ${fmtVol(tk.qv24)}</p>
      <div class="d-plan" data-part="plan"><p class="label">${t("d.plan")}</p>
        <dl>
          <div><dt>${t("d.entry")}</dt><dd>${fmtPrice(plan.entry)}</dd></div>
          <div class="up"><dt>${t("d.t1")}</dt><dd>${fmtPrice(plan.t1)} <small>${fmtPct(plan.t1Pct)}</small></dd></div>
          <div class="up"><dt>${t("d.t2")}</dt><dd>${fmtPrice(plan.t2)} <small>${fmtPct(plan.t2Pct)}</small></dd></div>
          <div class="down"><dt>${t("d.stop")}</dt><dd>${fmtPrice(plan.stop)} <small>${fmtPct(-plan.stopPct)}</small></dd></div>
          <div><dt>${t("d.time")}</dt><dd>${t("d.timeV", { h: plan.holdHours })}</dd></div>
        </dl>
      </div>
      <p class="note">${t("g.noScore")}</p>
      ${tr ? tradeHTML(sym, { plan, score: 0, metrics: { atr } }, tr) : `<button type="button" class="btn primary wide" data-buy="${esc(sym)}">${t("d.buy", { c: esc(tk.base) })}</button>`}`;
    }
    const m = r.metrics, plan = r.plan;
    // Mock trading: Buy stays on for every stage (late/quiet included) so users can try high risk.
    // Stage labels + soft risk notes remain; stops / targets / leverage caps are unchanged.
    const parts = [["volume", 25], ["momentum", 20], ["breakout", 15], ["squeeze", 10], ["buyers", 15], ["strength", 15]];
    return `<div class="d-head">
        <div class="d-3d" data-viewer>${badge(tk.base, 120)}</div>
        <div class="d-id"><span class="stage ${r.stage}">${t("stage." + r.stage)}</span><h2>${esc(tk.base)}</h2><p class="muted">${esc(tk.name)}</p>
          <p class="d-px" data-part="px"><b>${fmtPrice(tk.price)}</b> <span class="${sign(m.ret1h)}">${fmtPct(m.ret1h)} 1h</span> <span class="${sign(ch24)}">${fmtPct(ch24)} 24h</span></p></div>
        <div class="d-score" data-part="score">${scoreRing(r.score, r.stage)}<span class="muted">${t("d.score")}</span></div>
      </div>
      <div class="d-chart" data-part="chart"><p class="label">${t("d.chart")} <span class="muted">· ${t("d.vol")} ${fmtVol(tk.qv24)}</span></p>${chart(sym, plan)}</div>
      <div class="d-why" data-part="why"><p class="label">${t("d.why")}</p>
        ${parts.map(([k, mx]) => `<div class="bar"><span>${t("part." + k)}</span><i><em style="width:${Math.round(r.parts[k] / mx * 100)}%"></em></i><b>${Math.round(r.parts[k])}/${mx}</b></div>`).join("")}
      </div>
      <div class="d-plan" data-part="plan"><p class="label">${t("d.plan")}</p>
        <dl>
          <div><dt>${t("d.entry")}</dt><dd>${fmtPrice(plan.entry)}</dd></div>
          <div class="up"><dt>${t("d.t1")}</dt><dd>${fmtPrice(plan.t1)} <small>${fmtPct(plan.t1Pct)}</small></dd></div>
          <div class="up"><dt>${t("d.t2")}</dt><dd>${fmtPrice(plan.t2)} <small>${fmtPct(plan.t2Pct)}</small></dd></div>
          <div class="down"><dt>${t("d.stop")}</dt><dd>${fmtPrice(plan.stop)} <small>${fmtPct(-plan.stopPct)}</small></dd></div>
          <div><dt>${t("d.time")}</dt><dd>${t("d.timeV", { h: plan.holdHours })}</dd></div>
        </dl>
      </div>
      ${r.stage === "late" ? `<p class="note warn">${t("d.lateNote")}</p>` : r.stage === "quiet" ? `<p class="note">${t("d.quietNote")}</p>` : ""}
      ${tr ? tradeHTML(sym, r, tr) : `<button type="button" class="btn primary wide" data-buy="${esc(sym)}">${t("d.buy", { c: esc(tk.base) })}</button>`}`;
  }
  function tradeHTML(sym, r, tr) {
    const tk = S.ticks[sym], plan = r.plan, amt = tr.amt, lev = tr.lev, auto = tr.auto !== false, n = amt * lev;
    const fee = n * FEE * 2, gain1 = n * plan.t1Pct, gain2 = n * (plan.t1Pct + plan.t2Pct) / 2, loss = n * plan.stopPct;
    const liq = liqPrice(tk.price, lev);
    // Capped loss at liquidation: remaining equity floor ~10% of margin, minus open+close fees, never worse than -margin.
    const liqMove = n * (1 - liq / tk.price);
    const liqLoss = Math.min(amt, Math.max(0, liqMove + fee));
    const err = amt < 10 ? t("t.low") : amt + n * FEE > P.cash ? t("t.nocash") : "";
    return `<form class="trade" data-trade="${esc(sym)}" novalidate>
      <label class="label" for="tAmt">${t("t.amount")} <span class="muted">· ${t("t.cash", { v: fmtUsd(P.cash) })}</span></label>
      <div class="amt"><span>$</span><input id="tAmt" type="number" inputmode="decimal" min="10" step="any" value="${amt}"></div>
      <div class="seg chips">${[0.1, 0.25, 0.5, 1].map((f) => `<button type="button" data-frac="${f}">${f === 1 ? "Max" : f * 100 + "%"}</button>`).join("")}</div>
      <p class="label">${t("t.lev")}</p>
      <div class="seg">${LEVS.map((L) => `<button type="button" data-lev="${L}" class="${L === lev ? "on" : ""}">${L}x</button>`).join("")}</div>
      ${lev > 1 ? `<p class="muted small-note">${t("t.levNote")}</p>` : ""}
      <label class="check"><input type="checkbox" data-auto ${auto ? "checked" : ""}> ${t("t.auto")}</label>
      <p class="muted small-note">${auto ? t("t.autoOn") : t("t.autoOff")}</p>
      <dl class="preview">
        <div><dt>${t("t.cost")}</dt><dd>${fmtUsd(amt)}</dd></div>
        ${auto ? `<div class="up"><dt>${t("t.ifT1")}</dt><dd>${fmtUsdS(gain1 / 2 - fee / 2)}</dd></div>
        <div class="up"><dt>${t("t.ifT2")}</dt><dd>${fmtUsdS(gain2 - fee)}</dd></div>
        <div class="down"><dt>${t("t.ifStop")}</dt><dd>${fmtUsdS(-loss - fee)}</dd></div>` : ""}
        ${lev >= 2 ? `<div class="down"><dt>${t("t.ifLiq")}</dt><dd>${fmtUsdS(-liqLoss)} · ${fmtPrice(liq)}</dd></div>` : ""}
      </dl>
      ${err ? `<p class="err">${err}</p>` : ""}
      <div class="trade-go"><button type="button" class="btn ghost" data-cancel>${t("t.cancel")}</button>
      <button type="submit" class="btn primary" ${err ? "disabled" : ""}>${t("t.confirm", { c: esc(tk.base), v: fmtUsd(amt) })}</button></div>
    </form>`;
  }

  function detailHost() { return isDesk() ? $("#detailDesk") : $("#detailMobile"); }
  function renderDetail(full) {
    const host = detailHost();
    if (!isDesk() && !$("#detailSheet").open) return;
    if (S.selected) ensureTick(S.selected);
    const r = S.scores[S.selected];
    const stageKey = S.selected + ":" + (r ? r.stage : "noscore") + ":" + I18N.lang;
    if (!full && host.dataset.key === stageKey) {
      // live tick: patch only the read-only parts; buttons and the trade form stay untouched
      const tmp = document.createElement("div"); tmp.innerHTML = detailHTML(S.selected);
      for (const part of tmp.querySelectorAll("[data-part]")) {
        const cur = host.querySelector(`[data-part="${part.dataset.part}"]`);
        if (cur && cur.innerHTML !== part.innerHTML) cur.innerHTML = part.innerHTML;
      }
      return;
    }
    if (!full && S.trade) return; // stage changed mid-trade: keep the form, the user can still confirm or cancel
    host.dataset.key = stageKey;
    host.innerHTML = detailHTML(S.selected);
    const slot = host.querySelector("[data-viewer]");
    if (slot && S.selected && S.ticks[S.selected] && window.THREE && Coin3D.supported()) {
      slot.innerHTML = "";
      if (!S.viewer) { S.viewerEl = document.createElement("div"); S.viewerEl.className = "viewer"; S.viewer = Coin3D.single(S.viewerEl); }
      slot.appendChild(S.viewerEl);
      S.viewer && S.viewer.set(S.ticks[S.selected].base);
    }
  }
  function select(sym) {
    if (S.selected !== sym) S.trade = null;
    S.selected = sym; ensureTick(sym); renderLists(); renderGainers(); renderAiWatch(); renderDetail(true);
    if (!isDesk()) { const d = $("#detailSheet"); if (!d.open) d.showModal(); renderDetail(true); d.scrollTop = 0; }
  }

  function renderPortfolio() {
    if (!$("#pfSummary")) return;
    const eq = equity(), pnl = eq - P.start;
    const wins = P.history.filter((h) => h.pnl > 0).length;
    $("#pfSummary").innerHTML = `
      <div class="stat big"><span>${t("p.equity")}</span><b>${fmtUsd(eq)}</b></div>
      <div class="stat"><span>${t("p.pnl")}</span><b class="${sign(pnl)}">${fmtUsdS(pnl)}</b><small class="${sign(pnl)}">${fmtPct(pnl / P.start, 2)}</small></div>
      <div class="stat"><span>${t("p.cash")}</span><b>${fmtUsd(P.cash)}</b>${P.history.length ? `<small>${t("p.winrate", { v: Math.round(wins / P.history.length * 100) + "%", n: P.history.length })}</small>` : ""}</div>`;
    $("#pfOpen").innerHTML = P.positions.length ? `<ul class="cards">${P.positions.map((x) => {
      const p = priceOf(x.sym), cur = isFinite(p) ? p : x.entry, v = posValue(x, cur), up = v - x.frac * x.margin + x.realized;
      const auto = x.auto !== false;
      const floor = x.liq > 0 ? x.liq : liqPrice(x.entry, x.lev);
      const span = auto ? (x.t2 - x.stop) : (x.entry - floor) || 1;
      const pos = auto ? Math.max(0, Math.min(1, (cur - x.stop) / span)) : Math.max(0, Math.min(1, (cur - floor) / ((x.entry - floor) || 1)));
      const en = auto ? (x.entry - x.stop) / span : 1;
      const t1 = auto ? (x.t1 - x.stop) / span : 1;
      const meta = auto
        ? `${t("p.held", { v: fmtDur(Date.now() - x.openedAt) })} · ${t("p.autoExit", { t: fmtTime(x.until) })}${x.half ? " · " + t("x.t1") : ""}`
        : `${t("p.held", { v: fmtDur(Date.now() - x.openedAt) })} · ${t("p.manualHold")}${x.lev >= 2 ? " · " + t("p.liqAt", { v: fmtPrice(floor) }) : ""}`;
      const trackL = auto
        ? `<div class="track-l"><span class="down">${fmtPrice(x.stop)}</span><span>${fmtPrice(cur)}</span><span class="up">${fmtPrice(x.t2)}</span></div>`
        : `<div class="track-l"><span class="down">${fmtPrice(floor)}</span><span>${fmtPrice(cur)}</span><span>${fmtPrice(x.entry)}</span></div>`;
      return `<li class="pos">
        <div class="pos-top">${badge(x.base, 40)}<div><b>${esc(x.base)}</b> <span class="muted">${x.lev > 1 ? x.lev + "x · " : ""}${fmtUsd(x.margin)}</span>
          <p class="muted small">${meta}</p></div>
          <div class="pos-pnl"><b class="${sign(up)}">${fmtUsdS(up)}</b><span class="${sign(cur - x.entry)}">${fmtPct(cur / x.entry - 1)}</span></div></div>
        <div class="track" aria-hidden="true"><i class="t-en" style="left:${(en * 100).toFixed(1)}%"></i>${auto ? `<i class="t-t1" style="left:${(t1 * 100).toFixed(1)}%"></i>` : ""}<em style="left:${(pos * 100).toFixed(1)}%"></em></div>
        ${trackL}
        <button type="button" class="btn ghost sm" data-sell="${esc(x.id)}">${t("p.close")}</button></li>`;
    }).join("")}</ul>` : `<div class="empty-box">${mascotImg()}<p>${t("p.empty")} <a href="#radar">${t("nav.radar")}</a></p></div>`;
    $("#pfHist").innerHTML = P.history.length ? `<ul class="hist">${P.history.slice(0, 40).map((h) => `<li>${badge(h.base, 30)}
      <span><b>${esc(h.base)}</b> <span class="muted small">${fmtDT(h.closedAt)}</span><br><span class="muted small">${h.how.map((k) => t("x." + k)).join(" → ")}</span></span>
      <span class="h-r"><b class="${sign(h.pnl)}">${fmtUsdS(h.pnl)}</b><span class="${sign(h.pnl)} small">${fmtPct(h.pct)}</span></span></li>`).join("")}</ul>`
      : `<p class="empty-box">${t("p.histEmpty")}</p>`;
    $$("#pfCap [data-cap]").forEach((b) => b.classList.toggle("on", +b.dataset.cap === (S.cap || P.start)));
  }


  /* ================= Hits (sealed gainer_board scorecard; display only) ================= */
  S.hitsDoc = null; S.hitsAt = 0;
  async function loadHits() {
    try {
      const r = await fetch("data/gainer_board/summary.json", { cache: "no-store" });
      if (!r.ok) throw new Error("hits " + r.status);
      S.hitsDoc = await r.json(); S.hitsAt = Date.now();
    } catch (e) { console.warn("hits load failed", e); }
    renderHits();
  }
  function renderHits() {
    const el = $("#hitsStrip"); if (!el) return;
    const doc = S.hitsDoc, roll = doc && doc.scorecard_7d, cards = (doc && doc.scorecards) || [];
    const last = Array.isArray(cards) && cards.length ? cards[cards.length - 1] : null;
    if (!roll && !last) {
      el.innerHTML = `<p class="muted small-note">${esc(t("hit.empty"))}</p>`;
      return;
    }
    const days = roll && roll.days != null ? roll.days : (cards.length || 0);
    const hits = roll && roll.early_hits != null ? roll.early_hits : (last && last.early_hits) || 0;
    const flagged = roll && roll.early_flagged != null ? roll.early_flagged : (last && last.early_flagged) || 0;
    const recall = roll && roll.recall_top20_pct != null ? roll.recall_top20_pct : (last && last.recall_top20_pct);
    const night = last ? t("hit.metanight", { date: last.date || "—", hits: last.early_hits ?? 0, flagged: last.early_flagged ?? 0 }) : "";
    // Sealed early-hit symbols from latest scorecard (not live Early Radar)
    const hitRows = last && Array.isArray(last.hits) ? last.hits : [];
    const syms = hitRows.map((h) => h && h.symbol).filter(Boolean);
    const caught = syms.length
      ? `<div class="hits-caught"><span class="muted small-note">${esc(t("hit.caught"))}</span>
          <div class="hits-syms">${syms.map((s) => `<span class="hit-chip">${esc(s)}</span>`).join("")}</div></div>`
      : `<p class="hits-caught-empty muted small-note">${esc(t("hit.caughtEmpty"))}</p>`;
    el.innerHTML = `<div class="hits-card">
      <div class="hits-h"><b data-t-skip>${esc(t("hit.title"))}</b><span class="muted">${esc(t("hit.sub"))}</span></div>
      ${caught}
      <p class="hits-meta">${esc(t("hit.meta7", { hits, flagged, days }))}${recall != null ? ` · ${esc(t("hit.recall", { v: recall }))}` : ""}</p>
      ${night ? `<p class="hits-night muted small-note">${esc(night)}</p>` : ""}
      <p class="muted small-note">${esc(t("hit.note"))}</p>
    </div>`;
  }

  function renderBacktest() {
    const bt = S.bt; if (!bt || !$("#btStats")) return;
    const demo = S.market.mode === "demo";
    $("#btStats").innerHTML = `
      <div class="stat"><span>${t("r.signals")}</span><b>${bt.n}</b>${demo ? `<small>${t("status.demo")}</small>` : ""}</div>
      <div class="stat"><span>${t("r.win")}</span><b>${Math.round(bt.win * 100)}%</b></div>
      <div class="stat"><span>${t("r.avg")}</span><b class="${sign(bt.avg)}">${fmtPct(bt.avg, 2)}</b></div>
      <div class="stat"><span>${t("r.base")}</span><b class="${sign(bt.baseline.avg)}">${fmtPct(bt.baseline.avg, 2)}</b></div>`;
    const good = bt.n >= 10 && bt.avg > 0 && bt.avg > bt.baseline.avg;
    $("#btVerdict").className = "verdict " + (demo ? "demo" : good ? "good" : "bad");
    $("#btVerdict").textContent = demo ? t("r.verdictDemo") : t(good ? "r.verdictGood" : "r.verdictBad");
    // cumulative curve, equal size per trade, oldest → newest
    const tr = [...bt.trades].reverse(); let cum = 0; const pts = [0];
    for (const x of tr) pts.push(cum += x.ret);
    const W = 600, H = 140, lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), y = (v) => (H - 6 - (v - lo) / (hi - lo || 1) * (H - 12)).toFixed(1);
    $("#btChart").innerHTML = tr.length ? `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Backtest">
      <line class="zero" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>
      <polyline class="${sign(cum)}" points="${pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${y(v)}`).join(" ")}"/></svg>
      <p class="muted small">${t("r.total", { n: tr.length, v: fmtPct(cum, 1) })}</p>` : "";
    renderFollow(); renderAllin();
  }
  /** "If you followed every Early signal": daily result, each trade using STAKE of the account, vs Cyrus's 20%/day goal. */
  const STAKE = 0.10, GOAL_DAY = 0.20;
  function renderFollow() {
    const bt = S.bt, el = $("#followDays"); if (!bt || !el) return;
    const days = new Map();
    for (const x of bt.trades) {
      const k = new Date(x.t).toLocaleDateString(I18N.lang === "zh" ? "zh-HK" : "en-GB", { month: "short", day: "numeric", weekday: "short" });
      const d = days.get(k) || { k, t: x.t, n: 0, ret: 0, wins: 0 }; d.n++; d.ret += x.ret * STAKE; if (x.ret > 0) d.wins++; days.set(k, d);
    }
    const list = [...days.values()].sort((a, b) => a.t - b.t);
    if (!list.length) { el.innerHTML = ""; return; }
    const avg = list.reduce((a, d) => a + d.ret, 0) / list.length, hit = list.filter((d) => d.ret >= GOAL_DAY).length;
    const max = Math.max(GOAL_DAY, ...list.map((d) => Math.abs(d.ret)));
    el.innerHTML = `<div class="follow-sum">
        <div class="stat"><span>${t("f2.avgDay")}</span><b class="${sign(avg)}">${fmtPct(avg, 2)}</b>${S.market.mode === "demo" ? `<small>${t("status.demo")}</small>` : ""}</div>
        <div class="stat"><span>${t("f2.goal")}</span><b>${hit} / ${list.length}</b><small>${t("f2.days")}</small></div></div>
      <ul class="days">${list.map((d) => `<li><span class="dd">${esc(d.k)}</span>
        <span class="dbar"><i class="goal" style="left:${(GOAL_DAY / max * 50 + 50).toFixed(1)}%"></i><em class="${sign(d.ret)}" style="${d.ret >= 0 ? "left:50%" : `right:50%`};width:${(Math.abs(d.ret) / max * 50).toFixed(1)}%"></em></span>
        <b class="${sign(d.ret)}">${fmtPct(d.ret, 2)}</b><span class="muted small">${d.n} ${t("f2.trades")}</span></li>`).join("")}</ul>
      <p class="muted small">${t("f2.how", { s: Math.round(STAKE * 100) + "%" })}</p>`;
  }
  /* ---------- All-in page ---------- */
  function btcFrom(t) {
    const b = S.btc; if (!b) return null;
    let i = 0; while (i < b.n - 1 && b.t[i] < t) i++;
    return b.c[b.n - 1] / b.c[i] - 1;
  }
  function renderAllin() {
    const el = $("#aiHero"); if (!el) return;
    const start = S.aiStart || 1000;
    $$("#aiStart [data-ai-start]").forEach((b) => b.classList.toggle("on", +b.dataset.aiStart === start));
    const bt = S.bt;
    if (!bt) { el.innerHTML = `<span class="loader"></span>`; return; }
    const r = Strategy.allIn(bt.trades, start, STAKE);
    const demo = S.market.mode === "demo";
    if (!r.n) { el.innerHTML = `<p class="empty-box">${t("ai.empty")}</p>`; $("#aiChart").innerHTML = $("#aiCompare").innerHTML = $("#aiTrades").innerHTML = ""; renderAllinNow(start); return; }
    const t0 = r.curve[0].t, t1 = r.curve[r.curve.length - 1].t, days = Math.max(1, Math.round((t1 - t0) / 864e5));
    el.innerHTML = `<div class="ai-big">
        <span>${t("ai.from", { a: fmtUsd(start) })}${demo ? ` · <em>${t("status.demo")}</em>` : ""}</span>
        <b class="${sign(r.ret)}">${fmtUsd(r.end)}</b>
        <small class="${sign(r.ret)}">${fmtPct(r.ret, 1)} · ${t("ai.over", { n: r.n, d: days })}</small>
      </div>
      <div class="ai-stats">
        <div><span>${t("ai.win")}</span><b>${Math.round(r.win * 100)}%</b></div>
        <div><span>${t("ai.dd")}</span><b class="down">${fmtPct(r.maxDD, 1)}</b></div>
        <div><span>${t("ai.best")}</span><b class="up">${fmtPct(r.best, 1)}</b></div>
        <div><span>${t("ai.worst")}</span><b class="down">${fmtPct(r.worst, 1)}</b></div>
      </div>`;
    // chart: all-in (yellow) vs 10% stake (grey)
    const W = 600, H = 170, all = r.curve, stk = r.stakeCurve;
    const vals = all.map((p) => p.v).concat(stk.map((p) => p.v)), lo = Math.min(...vals), hi = Math.max(...vals);
    const x = (tt) => ((tt - t0) / ((t1 - t0) || 1) * W).toFixed(1), y = (v) => (H - 8 - (v - lo) / ((hi - lo) || 1) * (H - 16)).toFixed(1);
    const line = (c) => c.map((p) => `${x(Math.min(p.t, t1))},${y(p.v)}`).join(" ");
    $("#aiChart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t("ai.title"))}">
        <line class="zero" x1="0" x2="${W}" y1="${y(start)}" y2="${y(start)}"/>
        <polyline class="stake" points="${line(stk)}"/><polyline class="all" points="${line(all)}"/></svg>
      <p class="legend"><span class="lg-all">${t("ai.cAll")}</span><span class="lg-stake">${t("ai.cStake")}</span></p>`;
    const btc = btcFrom(t0);
    const cmp = [[t("ai.cAll"), r.ret], [t("ai.cStake"), r.stakeRet], [t("ai.cBtc"), btc]];
    $("#aiCompare").innerHTML = `<p class="label">${t("ai.cmp")}</p><dl class="cmp">${cmp.map(([k, v]) => v == null ? "" :
      `<div><dt>${k}</dt><dd class="${sign(v)}">${fmtUsd(start * (1 + v))} <small>${fmtPct(v, 1)}</small></dd></div>`).join("")}</dl>`;
    $("#aiTrades").innerHTML = `<ul class="hist">${[...r.trades].reverse().slice(0, 40).map((x) => `<li>${badge(x.sym.replace(/USDT$/, ""), 30)}
      <span><b>${esc(x.sym.replace(/USDT$/, ""))}</b> <span class="muted small">${fmtDT(x.t)} · ${t("d.score")} ${x.score}</span></span>
      <span class="h-r"><b class="${sign(x.ret)}">${fmtPct(x.ret, 1)}</b><span class="muted small">${t("ai.bal")} ${fmtUsd(x.bal)}</span></span></li>`).join("")}</ul>`;
    renderAllinNow(start);
  }
  function renderAllinNow(start) {
    const top = ranked("early")[0], el = $("#aiNow"); if (!el) return;
    if (!top) { el.innerHTML = `<p class="empty-box">${mascotImg()}${t("ai.nowNone")}</p>`; return; }
    const r = S.scores[top], base = S.ticks[top].base, p = r.plan, fee = start * FEE * 2;
    el.innerHTML = `<div class="ai-now"><div class="ai-now-h">${badge(base, 56)}<div><b>${t("ai.nowIf", { v: fmtUsd(start), c: esc(base) })}</b>
        <p class="muted small">${t("d.score")} ${r.score} · ${reasonChips(r)}</p></div></div>
      <dl class="preview">
        <div class="up"><dt>${t("t.ifT1")}</dt><dd>${fmtUsdS(start * p.t1Pct / 2 - fee / 2)}</dd></div>
        <div class="up"><dt>${t("t.ifT2")}</dt><dd>${fmtUsdS(start * (p.t1Pct + p.t2Pct) / 2 - fee)}</dd></div>
        <div class="down"><dt>${t("t.ifStop")}</dt><dd>${fmtUsdS(-start * p.stopPct - fee)}</dd></div>
      </dl>
      <button type="button" class="btn primary wide" data-ai-go="${esc(top)}">${t("ai.go", { c: esc(base) })}</button></div>`;
  }
  function renderLog() {
    const log = store.get(LOG_KEY, []); if (!$("#sigLog")) return;
    const cell = (x, p) => p == null ? `<span class="muted">${t("r.wait")}</span>` : `<span class="${sign(p - x.price)}">${fmtPct(p / x.price - 1)}</span>`;
    $("#sigLog").innerHTML = log.length ? `<div class="tbl"><table><thead><tr><th>${t("r.coin")}</th><th>${t("r.time")}</th><th>${t("r.score")}</th><th>${t("r.after1")}</th><th>${t("r.after4")}</th></tr></thead><tbody>
      ${log.slice(0, 60).map((x) => `<tr><td><b>${esc(x.base)}</b>${x.demo ? ' <span class="muted small">demo</span>' : ""}</td><td>${fmtDT(x.t)}</td><td>${x.score}</td><td>${cell(x, x.p1)}</td><td>${cell(x, x.p4)}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="empty-box">${t("r.logEmpty")}</p>`;
  }
  function paintStatus() {
    const live = S.market && S.market.mode === "live";
    $$("[data-status]").forEach((b) => {
      b.className = "status " + (live ? "live" : "demo");
      let label;
      if (S.scanning && S.prog[1] > 1) label = t("status.scanning", { d: S.prog[0], n: S.prog[1] });
      else if (S.scanAt) label = t(live ? "status.liveAge" : "status.demoAge", { a: fmtAge(S.scanAt) });
      else label = t(live ? "status.live" : "status.demo");
      b.innerHTML = `<i></i>${label}`;
    });
  }
  function applyText() {
    $$("[data-t]").forEach((n) => (n.textContent = t(n.dataset.t)));
    $$("[data-tph]").forEach((n) => (n.placeholder = t(n.dataset.tph)));
    $$("[data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === I18N.lang));
  }
  function renderAll() { applyText(); paintStatus(); paintAcct(); takeRadarSnap(); renderHero(); renderLists(); renderHits(); renderGainers(); renderAiWatch(); renderDetail(true); renderPortfolio(); renderBacktest(); renderLog(); }

  /* ================= routing ================= */
  function route() {
    const page = (location.hash || "#radar").slice(1);
    const ok = ["radar", "gainers", "aiwatch", "allin", "markets", "portfolio", "record"].includes(page) ? page : "radar";
    $$("section[data-page]").forEach((s) => (s.hidden = s.dataset.page !== ok));
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === ok));
    document.body.dataset.view = ok;
    if ($("#detailSheet").open) $("#detailSheet").close();
    window.scrollTo(0, 0);
    if (ok === "aiwatch" && !S.awAt && !S.awLoading) loadAiWatch();
  }

  let toastT = 0;
  function toast(msg) { const n = $("#toast"); n.textContent = msg; n.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (n.hidden = true), 3800); }

  /* ================= events ================= */
  document.addEventListener("click", (e) => {
    const g = (sel) => e.target.closest(sel);
    let n;
    if ((n = g("[data-sym]"))) return select(n.dataset.sym);
    if ((n = g("[data-buy]"))) { const amt = Math.max(10, Math.floor(P.cash * 0.1 / 10) * 10); S.trade = { sym: n.dataset.buy, amt, lev: 1, auto: true }; return renderDetail(true); }
    if ((n = g("[data-cancel]"))) { S.trade = null; return renderDetail(true); }
    if ((n = g("[data-frac]")) && S.trade) { S.trade.amt = Math.max(0, Math.floor(P.cash * +n.dataset.frac / (1 + FEE * S.trade.lev))); return renderDetail(true); }
    if ((n = g("[data-lev]")) && S.trade) { S.trade.lev = Math.min(MAX_LEV, +n.dataset.lev); return renderDetail(true); }
    if ((n = g("[data-sell]"))) { const x = P.positions.find((y) => y.id === n.dataset.sell); if (x) { closePart(x, x.frac, priceOf(x.sym), "manual"); savePf(); renderPortfolio(); } return; }
    if ((n = g("[data-ai-start]"))) { S.aiStart = +n.dataset.aiStart; return renderAllin(); }
    if ((n = g("[data-ai-go]"))) { const sym = n.dataset.aiGo; select(sym); S.trade = { sym, amt: Math.max(10, Math.floor(P.cash / (1 + FEE))), lev: 1, auto: true }; return renderDetail(true); }
    if ((n = g("#radarFilters [data-f]"))) { S.filter = n.dataset.f; return renderLists(); }
    if ((n = g("[data-gmode]"))) { S.gMode = n.dataset.gmode; return renderGainers(); }
    if ((n = g("[data-sort]"))) { S.sort = n.dataset.sort; return renderLists(); }
    if ((n = g("[data-cap]"))) { S.cap = +n.dataset.cap; return renderPortfolio(); }
    if ((n = g("[data-lang]"))) { I18N.setLang(n.dataset.lang); return renderAll(); }
    if (g("[data-acct]")) return acctClick();
    if (g("[data-status]")) {
      if (S.market.mode !== "live") return toast(t("status.demoWhy"));
      return toast(S.scanAt ? t("status.liveAge", { a: fmtAge(S.scanAt) }) : t("status.live"));
    }
    if ((n = g("[data-close]"))) return n.closest("dialog").close();
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "tAmt" && S.trade) { S.trade.amt = Math.max(0, +e.target.value || 0); const pos = e.target.selectionStart;
      renderDetail(true); const i = $("#tAmt", detailHost()); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (_) {} } }
    if (e.target.id === "mSearch") { S.q = e.target.value; renderLists(); }
    if (e.target.id === "gSearch") { S.gQ = e.target.value; renderGainers(); }
  });
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-trade]"); if (!f) return;
    e.preventDefault();
    const sym = f.dataset.trade, base = S.ticks[sym].base;
    if (S.trade && S.trade.amt >= 10 && openTrade(sym, S.trade.amt, S.trade.lev, S.trade.auto !== false)) {
      S.trade = null; toast(t("t.done", { c: base })); renderDetail(true); renderPortfolio();
      if (!isDesk()) $("#detailSheet").close();
    }
  });
  $("#authForm").addEventListener("submit", submitAuth);
  $("#authSwitch").addEventListener("click", () => openAuth(authMode === "login" ? "signup" : "login"));
  $("#pfReset").addEventListener("click", async () => {
    const v = S.cap || P.start;
    if (await ask(t("p.resetQ", { v: fmtUsd(v) }), t("p.reset"))) { P = fresh(v); savePf(); renderPortfolio(); }
  });
  // close sheets by tapping the backdrop
  $$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));
  document.addEventListener("change", (e) => {
    if (e.target && e.target.matches && e.target.matches("[data-auto]") && S.trade) {
      S.trade.auto = !!e.target.checked; renderDetail(true);
    }
    if (e.target && e.target.id === "gHideLow") { S.gHideLow = !!e.target.checked; renderGainers(); }
  });
  $("#detailSheet").addEventListener("close", () => { S.trade = null; });
  window.addEventListener("hashchange", route);
  matchMedia("(min-width: 1080px)").addEventListener("change", () => { if ($("#detailSheet").open) $("#detailSheet").close(); renderDetail(true); });

  /* ================= start ================= */
  (async function start() {
    loadPf(); route(); applyText(); paintAcct(); renderPortfolio(); renderLog();
    if (window.THREE && Coin3D.supported()) { S.podium = Coin3D.podium($("#podium"), select); Coin3D.mascot($("#heroMascot")); }
    load3DIcons();
    try { const a = await (await fetch("data/bn_assets.json", { cache: "no-store" })).json(); if (a && a.assets) { Coin3D.setAssets(a.assets); Market.setNames(a.assets); } } catch (_) {}
    S.market = await Market.connect(); paintStatus();
    loadGainers();
    loadCatalog();
    loadAiWatch();
    loadHits();
    await scan();
    S.market.stream(onPrices);
    setInterval(() => { if (!document.hidden) scan(); }, RESCAN_MS);
    setInterval(() => { if (!document.hidden) loadGainers(); }, RESCAN_MS);
    setInterval(() => { if (!document.hidden) loadCatalog(); }, RESCAN_MS);
    setInterval(() => { if (!document.hidden) loadAiWatch(); }, RESCAN_MS);
    setInterval(() => { if (S.scanAt && !S.scanning && !document.hidden) paintStatus(); }, 15000);
    setInterval(() => { checkExits(); checkLog(); }, 60000);
  })();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // Test seam: same-snapshot radar face (no scoring rules).
  window.CryptoMRadar = { takeRadarSnap, radarSnap, ranked, heroCoins, loadHits, renderHits };
  window.CryptoMGainers = { gainerSyms, coinQueryHit, G_TOP, G_VOL_FLOOR, ensureTick };
  window.CryptoMAiWatch = { loadAiWatch, renderAiWatch };
  window.CryptoMLive = { RESCAN_MS, softFlash, fmtAge };
})();
