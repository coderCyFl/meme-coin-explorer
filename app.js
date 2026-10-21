/* Meme Coin Explorer: vanilla JS, no build, no keys.
 * Market data: DexScreener public API (CORS *), cached in localStorage.
 * X buzz: static data/x_buzz.json (the site never calls X). */
(() => {
  "use strict";
  const API = "https://api.dexscreener.com";
  const CACHE_TTL_MS = 3 * 60 * 1000;      // 3 minutes
  const CACHE_PREFIX = "mce:v1:";
  const LOW_LIQ = 50_000, NEW_PAIR_MS = 24 * 3600 * 1000, VOL_LIQ_EXTREME = 50, DUMP_PCT = -50;

  const $ = (id) => document.getElementById(id);
  const state = { rows: [], buzz: null, buzzBySym: new Map(), sortKey: "vol24", sortDir: -1, boosted: new Map() };

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  function money(v) {
    if (v == null || isNaN(v)) return "–";
    const a = Math.abs(v);
    if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "k";
    return "$" + v.toFixed(0);
  }
  function price(v) {
    if (v == null || isNaN(v)) return "–";
    if (v >= 1) return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (v === 0) return "$0";
    const z = Math.floor(-Math.log10(v));           // leading zeros after "0."
    if (z >= 4) return "$0.0" + toSub(z) + Math.round(v * 10 ** (z + 4)).toString().slice(0, 4); // e.g. $0.0₄1927
    return "$" + v.toPrecision(4);
  }
  function toSub(n) { return String(n).split("").map((d) => "₀₁₂₃₄₅₆₇₈₉"[d]).join(""); }
  function age(ms) {
    if (!ms) return "–";
    const h = (Date.now() - ms) / 3.6e6;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + "m";
    if (h < 48) return Math.round(h) + "h";
    if (h < 24 * 60) return Math.round(h / 24) + "d";
    return (h / 24 / 365).toFixed(1) + "y";
  }
  const pct = (v) => (v == null || isNaN(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(1) + "%");
  const fmtInt = (n) => (n == null ? "–" : Number(n).toLocaleString());
  const localTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };

  // ---------- cached fetch ----------
  async function cachedJson(url, { force = false } = {}) {
    const key = CACHE_PREFIX + url;
    if (!force) {
      try {
        const hit = JSON.parse(localStorage.getItem(key) || "null");
        if (hit && Date.now() - hit.t < CACHE_TTL_MS) return { data: hit.d, cached: true, t: hit.t };
      } catch {}
    }
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
    const d = await r.json();
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); }
    catch { pruneCache(); }
    return { data: d, cached: false, t: Date.now() };
  }
  function pruneCache() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    }
  }

  // ---------- data loading ----------
  async function resolvePairs(tokens, force) {
    // tokens: [{chainId, tokenAddress}] -> best pair (highest liquidity) per token, batched 30/call.
    const byChain = new Map();
    for (const t of tokens) {
      if (!byChain.has(t.chainId)) byChain.set(t.chainId, new Set());
      byChain.get(t.chainId).add(t.tokenAddress);
    }
    const calls = [];
    for (const [chain, set] of byChain) {
      const addrs = [...set];
      for (let i = 0; i < addrs.length; i += 30)
        calls.push(cachedJson(`${API}/tokens/v1/${encodeURIComponent(chain)}/${addrs.slice(i, i + 30).join(",")}`, { force }));
    }
    const res = await Promise.allSettled(calls);
    const pairs = res.flatMap((r) => (r.status === "fulfilled" && Array.isArray(r.value.data) ? r.value.data : []));
    return bestPerToken(pairs);
  }
  function bestPerToken(pairs) {
    const best = new Map();
    for (const p of pairs) {
      if (!p || !p.baseToken) continue;
      const k = p.chainId + ":" + p.baseToken.address;
      const liq = p.liquidity?.usd || 0;
      if (!best.has(k) || liq > (best.get(k).liquidity?.usd || 0)) best.set(k, p);
    }
    return [...best.values()];
  }

  async function load(force = false) {
    const src = $("source").value;
    setStatus("抓緊 DexScreener…");
    try {
      let pairs = [];
      state.boosted = new Map();
      if (src === "search") {
        const q = $("q").value.trim() || "meme";
        const r = await cachedJson(`${API}/latest/dex/search?q=${encodeURIComponent(q)}`, { force });
        pairs = bestPerToken(r.data.pairs || []);
      } else {
        const path = src === "profiles" ? "/token-profiles/latest/v1" : "/token-boosts/top/v1";
        const r = await cachedJson(API + path, { force });
        const list = Array.isArray(r.data) ? r.data : [];
        for (const t of list) if (t.totalAmount) state.boosted.set(t.chainId + ":" + t.tokenAddress, t.totalAmount);
        pairs = await resolvePairs(list, force);
      }
      state.rows = pairs.map(toRow);
      fillChains();
      render();
      setStatus(`${state.rows.length} 隻幣 · ${new Date().toLocaleTimeString()} 更新 · 快取 ${CACHE_TTL_MS / 60000} 分鐘`);
    } catch (e) {
      console.error(e);
      setStatus("⚠️ 載入失敗：" + e.message);
    }
  }

  function toRow(p) {
    const sym = (p.baseToken.symbol || "").toUpperCase();
    const liq = p.liquidity?.usd ?? null, vol24 = p.volume?.h24 ?? null;
    const addrKey = p.chainId + ":" + p.baseToken.address;
    const r = {
      p, sym, name: p.baseToken.name || sym, chain: p.chainId, address: p.baseToken.address,
      price: p.priceUsd ? parseFloat(p.priceUsd) : null, chg24: p.priceChange?.h24 ?? null, vol24, liq,
      mcap: p.marketCap ?? p.fdv ?? null, created: p.pairCreatedAt || null,
      age: p.pairCreatedAt ? Date.now() - p.pairCreatedAt : null, url: p.url,
      img: p.info?.imageUrl || null, boost: state.boosted.get(addrKey) || p.boosts?.active || 0,
    };
    r.flags = riskFlags(r);
    r.risk = r.flags.length;
    const b = matchBuzz(r);
    r.buzzEntry = b.entry; r.buzzMatch = b.match;
    r.buzz = b.entry && b.match === "exact" ? (b.entry.mentions_7d ?? b.entry.search_hits ?? 0) : (b.entry ? -1 : -2);
    return r;
  }

  function riskFlags(r) {
    const f = [];
    if (r.liq == null || r.liq < LOW_LIQ) f.push(["💧", `Low liquidity (${money(r.liq)} < ${money(LOW_LIQ)}): hard to sell, easy to manipulate`]);
    if (r.created && Date.now() - r.created < NEW_PAIR_MS) f.push(["🐣", `Very new pair (${age(r.created)} old)`]);
    if (r.liq && r.vol24 && r.vol24 / r.liq > VOL_LIQ_EXTREME) f.push(["🌀", `24h volume is ${Math.round(r.vol24 / r.liq)}× liquidity: possible wash trading or bot churn`]);
    if (r.chg24 != null && r.chg24 <= DUMP_PCT) f.push(["📉", `Down ${r.chg24.toFixed(0)}% in 24h`]);
    if (r.boost) f.push(["🚀", `Boosted on DexScreener (paid promotion, ${r.boost} boosts)`]);
    return f;
  }

  // ---------- X buzz ----------
  async function loadBuzz() {
    try {
      const r = await fetch("data/x_buzz.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      state.buzz = await r.json();
      for (const c of state.buzz.coins || []) state.buzzBySym.set(String(c.symbol).toUpperCase(), c);
      renderBuzzBar();
    } catch (e) { console.warn("x_buzz.json not loaded", e); }
  }
  // Matching: same ticker AND same contract address = "exact". Ticker only = "weak"
  // (likely a different token sharing the ticker, so its buzz isn't counted).
  function matchBuzz(r) {
    const c = state.buzzBySym.get(r.sym);
    if (!c) return { entry: null, match: null };
    const exact = (c.tokens || []).some((t) => t.address === r.address && t.chain === r.chain);
    const noAddrs = !(c.tokens || []).length;
    return { entry: c, match: exact || noAddrs ? "exact" : "weak" };
  }
  function renderBuzzBar() {
    const b = state.buzz; if (!b) return;
    $("buzzbar").hidden = false;
    $("buzzMeta").textContent = `Snapshot ${localTime(b.fetched_at)} · counts window ${b.window?.start ? localTime(b.window.start) : "?"} → ${b.window?.end ? localTime(b.window.end) : "?"}`;
    const chips = $("buzzChips"); chips.textContent = "";
    const coins = [...(b.coins || [])].filter((c) => c.mentions_7d || c.search_hits)
      .sort((a, z) => (z.mentions_7d || 0) - (a.mentions_7d || 0) || z.search_hits - a.search_hits);
    for (const c of coins) {
      const n = c.mentions_7d != null ? fmtInt(c.mentions_7d) + " 則/7日" : c.search_hits + " 則樣本";
      const fl = (c.flags || []).map((f) => ({ spiking: " 📈", ticker_collision: " ⚠️", common_word: " ❔" }[f] || "")).join("");
      chips.append(el("span", { class: "chip", title: "撳嚟篩選", onclick: () => { $("filter").value = c.symbol; render(); } },
        el("b", { text: "$" + c.symbol }), el("span", { class: "n", text: n + fl })));
    }
    chips.append(el("span", { class: "muted", text: "📈 急升 · ⚠️ 多幣共用代號 · ❔ 代號係日常用字（用 crypto 語境查詢）" }));
  }

  // ---------- render ----------
  function fillChains() {
    const sel = $("chain"), cur = sel.value;
    const chains = [...new Set(state.rows.map((r) => r.chain))].sort();
    sel.textContent = "";
    sel.append(el("option", { value: "", text: "全部" }));
    for (const c of chains) sel.append(el("option", { value: c, text: c }));
    sel.value = chains.includes(cur) ? cur : "";
  }
  function filtered() {
    const chain = $("chain").value, minLiq = +$("minLiq").value, q = $("filter").value.trim().toLowerCase();
    const buzzOnly = $("buzzOnly").checked, hideRisky = $("hideRisky").checked;
    return state.rows.filter((r) =>
      (!chain || r.chain === chain) &&
      (r.liq || 0) >= minLiq &&
      (!q || r.name.toLowerCase().includes(q) || r.sym.toLowerCase().includes(q) || r.address.toLowerCase() === q) &&
      (!buzzOnly || r.buzzMatch === "exact") &&
      (!hideRisky || !r.flags.some(([i]) => i !== "🚀")));
  }
  function render() {
    const rows = filtered();
    const k = state.sortKey, d = state.sortDir;
    rows.sort((a, b) => {
      let x = a[k], y = b[k];
      if (typeof x === "string" || typeof y === "string") return d * String(x ?? "").localeCompare(String(y ?? ""));
      x = x ?? -Infinity; y = y ?? -Infinity; return d * (x - y);
    });
    document.querySelectorAll("th[data-k]").forEach((th) => {
      th.classList.toggle("sorted-asc", th.dataset.k === k && d === 1);
      th.classList.toggle("sorted-desc", th.dataset.k === k && d === -1);
    });
    const tb = $("tbody"); tb.textContent = "";
    for (const r of rows) tb.append(rowEl(r));
    $("empty").hidden = rows.length > 0;
  }
  function rowEl(r) {
    const img = safeUrl(r.img);
    let buzzCell;
    if (r.buzzMatch === "exact") {
      const c = r.buzzEntry;
      buzzCell = el("span", { class: "buzz exact", title: c.count_query ? "Query: " + c.count_query : "Posts with $" + r.sym + " in sample" },
        c.mentions_7d != null ? fmtInt(c.mentions_7d) : c.search_hits ? c.search_hits + "*" : "–", (c.flags || []).includes("spiking") ? " 📈" : "");
    } else if (r.buzzMatch === "weak") {
      buzzCell = el("span", { class: "buzz weak", title: "Buzz exists for a different token with the same ticker, so it isn't counted here" }, "≠ ticker");
    } else buzzCell = el("span", { class: "muted", text: "–" });
    const href = safeUrl(r.url);
    return el("tr", { onclick: () => openDrawer(r) },
      el("td", {}, el("div", { class: "tok" }, img ? el("img", { src: img, alt: "", loading: "lazy" }) : el("img", { alt: "" }),
        el("div", {}, el("div", { class: "nm", text: r.name, title: r.name }), el("div", { class: "sy", text: "$" + r.sym })))),
      el("td", {}, el("span", { class: "chainbadge", text: r.chain })),
      el("td", { class: "num", text: price(r.price) }),
      el("td", { class: "num " + (r.chg24 > 0 ? "pos" : r.chg24 < 0 ? "neg" : ""), text: pct(r.chg24) }),
      el("td", { class: "num", text: money(r.vol24) }),
      el("td", { class: "num", text: money(r.liq) }),
      el("td", { class: "num", text: money(r.mcap) }),
      el("td", { class: "num", text: age(r.created) }),
      el("td", { class: "num" }, buzzCell),
      el("td", { class: "flags" }, r.flags.map(([i, t]) => el("span", { title: t, text: i }))),
      el("td", {}, href ? el("a", { href, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation(), text: "DexScreener ↗" }) : ""));
  }

  function openDrawer(r) {
    const body = $("drawerBody"); body.textContent = "";
    const c = r.buzzEntry, href = safeUrl(r.url);
    body.append(
      el("h2", { text: `${r.name} ($${r.sym})` }),
      el("div", { class: "muted", text: `${r.chain} · ${r.address}` }),
      el("div", { class: "kv" },
        el("div", { text: "Price" }), el("div", { text: price(r.price) }),
        el("div", { text: "24h change" }), el("div", { text: pct(r.chg24) }),
        el("div", { text: "1h / 6h change" }), el("div", { text: `${pct(r.p.priceChange?.h1)} / ${pct(r.p.priceChange?.h6)}` }),
        el("div", { text: "24h volume" }), el("div", { text: money(r.vol24) }),
        el("div", { text: "24h txns (buys/sells)" }), el("div", { text: `${fmtInt(r.p.txns?.h24?.buys)} / ${fmtInt(r.p.txns?.h24?.sells)}` }),
        el("div", { text: "Liquidity" }), el("div", { text: money(r.liq) }),
        el("div", { text: "Market cap / FDV" }), el("div", { text: `${money(r.p.marketCap)} / ${money(r.p.fdv)}` }),
        el("div", { text: "Pair age" }), el("div", { text: age(r.created) }),
        el("div", { text: "DEX" }), el("div", { text: r.p.dexId || "–" })),
      el("p", {}, href ? el("a", { href, target: "_blank", rel: "noopener", text: "Open on DexScreener ↗" }) : "", "  ",
        el("button", { class: "primary sm", onclick: () => { $("drawer").hidden = true; window.MCE.paper && window.MCE.paper.openBuy({ chain: r.chain, pair: r.p.pairAddress, token: r.address, symbol: r.sym, name: r.name, price: r.price }); } }, "落倉")),
      el("h3", { text: "Risk flags" }),
      r.flags.length ? el("ul", {}, r.flags.map(([i, t]) => el("li", { text: `${i} ${t}` }))) : el("p", { class: "muted", text: "No automatic flags. That does not mean it's safe." }));
    const links = [...(r.p.info?.websites || []).map((w) => [w.label || "Website", w.url]), ...(r.p.info?.socials || []).map((s) => [s.type, s.url])]
      .map(([l, u]) => [l, safeUrl(u)]).filter(([, u]) => u);
    if (links.length) body.append(el("p", {}, links.map(([l, u]) => [el("a", { href: u, target: "_blank", rel: "noopener nofollow", text: l }), " "])));

    body.append(el("h3", { text: "X buzz (snapshot)" }));
    if (!c) body.append(el("p", { class: "muted", text: "Not in the X snapshot. Only the top boosted tokens are tracked, to keep costs low." }));
    else if (r.buzzMatch === "weak") body.append(el("p", { class: "warn", text: `The X snapshot tracks a different token with ticker $${r.sym} (${(c.tokens || []).map((t) => t.name + " on " + t.chain).join(", ")}). It isn't shown here to avoid mixing them up.` }));
    else {
      if (c.mentions_7d != null) {
        body.append(el("p", {}, el("b", { text: fmtInt(c.mentions_7d) }), " posts in ~7 days ", el("span", { class: "muted", text: `(query: ${c.count_query})` })));
        if (Array.isArray(c.mentions_daily)) {
          const max = Math.max(1, ...c.mentions_daily);
          body.append(el("div", { class: "spark", title: "Posts per day, oldest → newest" }, c.mentions_daily.map((n) => el("i", { style: `height:${Math.max(2, (n / max) * 36)}px`, title: fmtInt(n) }))));
        }
      } else body.append(el("p", { class: "muted", text: `${c.search_hits} post(s) with $${c.symbol} in the search sample (no count query run).` }));
      if (c.count_note) body.append(el("p", { class: "muted", text: c.count_note }));
      if ((c.flags || []).includes("ticker_collision")) body.append(el("p", { class: "warn", text: `⚠️ Several tokens use $${c.symbol}: ${(c.tokens || []).map((t) => t.name).join(", ")}. Posts may be about any of them.` }));
      if ((c.flags || []).includes("common_word")) body.append(el("p", { class: "warn", text: "❔ This ticker is also a common word, so mention counts are rough." }));
      for (const p of c.top_posts || []) {
        const u = safeUrl(p.url);
        body.append(el("div", { class: "post" }, el("div", { text: p.text }),
          el("div", { class: "meta" }, el("span", { text: "@" + (p.author || "?") }), el("span", { text: `♥ ${fmtInt(p.likes)}` }), el("span", { text: `⟲ ${fmtInt(p.reposts)}` }),
            el("span", { text: localTime(p.created_at) }), u ? el("a", { href: u, target: "_blank", rel: "noopener nofollow", text: "View on X ↗" }) : "")));
      }
      body.append(el("p", { class: "muted", text: "Posts are shown as-is. Many are shills or paid promos." }));
    }
    $("drawer").hidden = false;
  }

  const setStatus = (t) => ($("status").textContent = t);

  // ---------- wire up ----------
  let exploreLoaded = false;
  window.MCE = { el, money, price, pct, age, fmtInt, localTime, safeUrl, cachedJson, API,
    ensureExplore() { if (!exploreLoaded) { exploreLoaded = true; loadBuzz().then(() => load()); } } };
  function boot() {
    document.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k;
      state.sortDir = state.sortKey === k ? -state.sortDir : (["name", "chain"].includes(k) ? 1 : -1);
      state.sortKey = k; render();
    }));
    ["chain", "minLiq", "buzzOnly", "hideRisky"].forEach((id) => $(id).addEventListener("change", render));
    $("filter").addEventListener("input", render);
    $("source").addEventListener("change", () => { $("searchGroup").hidden = $("source").value !== "search"; load(); });
    $("go").addEventListener("click", () => load());
    $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
    $("refresh").addEventListener("click", () => load(true));
    $("closeDrawer").addEventListener("click", () => ($("drawer").hidden = true));
    $("drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") $("drawer").hidden = true; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("drawer").hidden = true; });
    if ((location.hash || "#picks").slice(1) === "explore") { exploreLoaded = true; loadBuzz().then(() => load()); }
  }
  if (typeof document !== "undefined") document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot) : boot();
})();
