/* Crypto.M coin universe + coin picker + 詳情 sheet.
 * Universe = every Binance spot USDT pair that is TRADING (exchangeInfo), minus stables, tokenized stocks
 * (bStocks: TRD_GRP_261 / tokenized_stocks.json fallback) and leveraged tokens. Prices from one public
 * MINI 24hr ticker call (data-api.binance.vision), refreshed while a list is on screen. Binance data only. */
(() => {
  "use strict";
  const BN_REST = "https://data-api.binance.vision";
  const TTL = 15_000;
  let assets = null, assetsP = null;
  let uni = { t: 0, rows: [], map: new Map() }, uniP = null;

  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== "") n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };
  const fmtPx = (p) => (window.MCE && window.MCE.price ? window.MCE.price(p) : "$" + p);
  const fmtPct = (v) => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%");
  const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

  function loadAssets() {
    if (assets) return Promise.resolve(assets);
    if (!assetsP) assetsP = fetch("data/bn_assets.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : { assets: {} })).catch(() => ({ assets: {} }))
      .then((j) => (assets = (j && j.assets) || {}));
    return assetsP;
  }
  const assetLogo = (base) => (assets && assets[base] && assets[base].l) || "";
  const assetName = (base) => (assets && assets[base] && assets[base].n) || "";

  function eligible(base) {
    const L = window.MCE && window.MCE.live;
    if (!base) return false;
    if (L && L.isStable && L.isStable(base)) return false;
    if (L && L.isTokenized && L.isTokenized(base)) return false;
    if (L && L.isLeveragedToken && L.isLeveragedToken(base)) return false;
    return true;
  }

  /** All tradable coins with live 24h stats. Cached TTL; force → refetch ticker. */
  async function universe({ force = false } = {}) {
    if (!force && uni.rows.length && Date.now() - uni.t < TTL) return uni.rows;
    if (uniP) return uniP;
    uniP = (async () => {
      await loadAssets();
      const L = window.MCE && window.MCE.live;
      const listed = L && L.ensureExchangeInfo ? await L.ensureExchangeInfo() : new Set();
      const r = await fetch(BN_REST + "/api/v3/ticker/24hr?type=MINI", { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("Binance ticker " + r.status);
      const all = await r.json();
      const rows = [];
      for (const x of all) {
        const sym = x.symbol;
        if (!sym || !sym.endsWith("USDT")) continue;
        if (listed && listed.size && !listed.has(sym)) continue; // TRADING + spot allowed only
        const base = sym.slice(0, -4);
        if (!eligible(base)) continue;
        const last = parseFloat(x.lastPrice), open = parseFloat(x.openPrice);
        if (!(last > 0)) continue;
        rows.push({ symbol: sym, base, name: assetName(base), price: last, chg24: open > 0 ? (last / open - 1) * 100 : 0,
          volQuote: parseFloat(x.quoteVolume) || 0, high: parseFloat(x.highPrice) || null, low: parseFloat(x.lowPrice) || null, open });
      }
      rows.sort((a, b) => b.volQuote - a.volQuote);
      // Prefer the WS mark when it is fresher than the REST ticker
      if (L && L.board) for (const row of rows) { const b = L.board.get(row.symbol); if (b && b.price > 0 && b.t > Date.now() - 10_000) row.price = b.price; }
      uni = { t: Date.now(), rows, map: new Map(rows.map((x) => [x.symbol, x])) };
      return rows;
    })().finally(() => { uniP = null; });
    return uniP;
  }
  const getRow = (sym) => uni.map.get(sym) || null;

  /** Rank rows for a query. Empty query: 🔥 > held > AI picks > volume. */
  function rank(rows, q, hot) {
    q = String(q || "").trim().toUpperCase().replace(/USDT$/, "").replace(/^\$/, "");
    const tag = (r) => (hot.pump.has(r.symbol) ? 3 : hot.held.has(r.symbol) ? 2 : hot.picks.has(r.symbol) ? 1 : 0);
    if (!q) return rows.slice().sort((a, b) => tag(b) - tag(a) || b.volQuote - a.volQuote);
    const out = [];
    for (const r of rows) {
      const b = r.base, n = (r.name || "").toUpperCase();
      let s = -1;
      if (b === q) s = 100; else if (b.startsWith(q)) s = 80; else if (n.startsWith(q)) s = 60;
      else if (b.includes(q)) s = 40; else if (n.includes(q)) s = 20;
      if (s >= 0) out.push([s + tag(r), r]);
    }
    return out.sort((a, b) => b[0] - a[0] || b[1].volQuote - a[1].volQuote).map((x) => x[1]);
  }
  function hotSets() {
    const f = window.MCE && window.MCE.hotSymbols;
    const x = (f && f()) || {};
    return { pump: x.pump || new Set(), held: x.held || new Set(), picks: x.picks || new Set() };
  }

  /** Buy payload for openBuy / openAllinFlow. */
  function info(r) {
    return { chain: "binance", pair: r.symbol, token: "binance:" + r.symbol, symbol: r.base,
      name: (r.name || r.base) + " (Binance)", price: r.price, source: "binance" };
  }

  // ---------- coin row (shared by picker + 睇幣 list) ----------
  function coinRow(r, hot, { onPick, tagName = "button" } = {}) {
    const L = window.MCE && window.MCE.live;
    const logo = L && L.coinLogoEl ? L.coinLogoEl(r.base, "coin-logo", 36) : h("span", { class: "coin-logo letter", text: r.base.slice(0, 2) });
    const badge = hot.pump.has(r.symbol) ? "🔥" : hot.held.has(r.symbol) ? "持" : hot.picks.has(r.symbol) ? "AI" : "";
    return h(tagName, { type: tagName === "button" ? "button" : null, class: "cp-row" + (hot.pump.has(r.symbol) ? " is-hot" : ""), "data-cp": r.symbol, onclick: onPick ? () => onPick(r) : null },
      logo,
      h("span", { class: "cp-id" }, h("b", { text: r.base }), badge ? h("span", { class: "cp-tag" + (badge === "🔥" ? " hot" : ""), text: badge }) : "",
        r.name ? h("span", { class: "cp-nm", text: r.name }) : ""),
      h("span", { class: "cp-px" }, h("span", { class: "num", "data-cp-px": r.symbol, text: fmtPx(r.price) }),
        h("span", { class: "num " + cls(r.chg24), "data-cp-chg": r.symbol, text: fmtPct(r.chg24) })));
  }
  function patchRows(host) {
    if (!host) return;
    host.querySelectorAll("[data-cp-px]").forEach((n) => { const r = getRow(n.dataset.cpPx); if (r) { const t = fmtPx(r.price); if (n.textContent !== t) n.textContent = t; } });
    host.querySelectorAll("[data-cp-chg]").forEach((n) => { const r = getRow(n.dataset.cpChg); if (r) { n.textContent = fmtPct(r.chg24); n.className = "num " + cls(r.chg24); } });
  }

  // ---------- coin picker ----------
  const MAX_ROWS = 80;
  function pickCoin({ title = "揀幣", hint = "" } = {}) {
    return new Promise((resolve) => {
      const dlg = $("coinPickDlg"), q = $("coinPickQ"), list = $("coinPickList");
      if (!dlg) return resolve(null);
      $("coinPickTitle").textContent = title;
      const hintEl = $("coinPickHint"); if (hintEl) { hintEl.textContent = hint; hintEl.hidden = !hint; }
      q.value = "";
      let rows = [], timer = null, settled = false;
      const done = (v) => {
        if (settled) return; settled = true;
        clearInterval(timer); dlg.onclose = null; q.oninput = null;
        try { dlg.close(); } catch (_) {}
        resolve(v);
      };
      const paint = () => {
        const hot = hotSets();
        const ranked = rank(rows, q.value, hot);
        list.textContent = "";
        if (!rows.length) { list.append(h("p", { class: "cp-empty", text: "載入緊 Binance…" })); return; }
        if (!ranked.length) { list.append(h("p", { class: "cp-empty", text: "搵唔到「" + q.value + "」" })); return; }
        for (const r of ranked.slice(0, MAX_ROWS)) list.append(coinRow(r, hot, { onPick: (x) => done(info(x)) }));
        const cnt = $("coinPickCount"); if (cnt) cnt.textContent = ranked.length + " / " + rows.length;
      };
      q.oninput = paint;
      $("coinPickClose").onclick = () => done(null);
      dlg.onclose = () => done(null);
      dlg.showModal();
      paint();
      universe({}).then((r) => { rows = r; paint(); }).catch((e) => { list.textContent = ""; list.append(h("p", { class: "cp-empty", text: "攞唔到 Binance 清單：" + e.message })); });
      timer = setInterval(() => { if (document.visibilityState === "visible") universe({ force: true }).then((r) => { rows = r; patchRows(list); }).catch(() => {}); }, TTL);
      setTimeout(() => { try { q.focus({ preventScroll: true }); } catch (_) {} }, 50);
    });
  }

  // ---------- 詳情 sheet: moves a parked section in, parks it back on close ----------
  let sheetCur = null;
  function openSheet(title, content) {
    const dlg = $("infoSheet"), body = $("infoSheetBody");
    if (!dlg) return;
    closeSheet(true);
    $("infoSheetTitle").textContent = title || "詳情";
    body.textContent = "";
    const nodes = [].concat(content || []);
    sheetCur = [];
    for (const n of nodes) {
      if (!n) continue;
      const node = typeof n === "string" ? $(n) : n;
      if (!node) continue;
      if (node.parentNode && node.dataset.park !== undefined) sheetCur.push(node);
      node.hidden = false;
      body.append(node);
    }
    dlg.onclose = () => closeSheet(true);
    if (!dlg.open) dlg.showModal();
    body.scrollTop = 0;
  }
  function closeSheet(silent) {
    const dlg = $("infoSheet"), park = $("sheetPark");
    if (sheetCur && park) for (const n of sheetCur) park.append(n);
    sheetCur = null;
    if (!silent && dlg && dlg.open) dlg.close();
  }

  window.MCE = window.MCE || {};
  window.MCE.market = { loadAssets, assetLogo, assetName, universe, getRow, rank, hotSets, info, coinRow, patchRows, pickCoin, openSheet, closeSheet, eligible };
  loadAssets();
  document.addEventListener("click", (e) => {
    const c = e.target.closest && e.target.closest("[data-sheet-close]");
    if (c) closeSheet(false);
  });
})();
