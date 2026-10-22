/* Meme Coin Explorer: vanilla JS, no build, no keys.
 * Main path (hot / browse / AI picks): Binance public REST+stream (see live.js).
 * Full-mode explore only: DexScreener public API (CORS *), cached in localStorage.
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
  /** Dex boosts sometimes return bare CMS ids; profiles/pairs often full URLs. */
  function iconUrl(raw) {
    if (!raw || typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return safeUrl(s);
    // bare cms id → CDN
    if (/^[A-Za-z0-9_-]{8,}$/.test(s)) {
      return safeUrl(`https://cdn.dexscreener.com/cms/images/${s}?width=64&height=64&fit=crop&quality=95&format=auto`);
    }
    return null;
  }
  const iconMap = new Map(); // chain:token -> icon url
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
        for (const t of list) {
          const k = t.chainId + ":" + t.tokenAddress;
          if (t.totalAmount) state.boosted.set(k, t.totalAmount);
          const ic = iconUrl(t.icon);
          if (ic) iconMap.set(k, ic);
        }
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
      img: iconUrl(p.info?.imageUrl) || iconMap.get(addrKey) || null, boost: state.boosted.get(addrKey) || p.boosts?.active || 0,
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
      el("td", { class: "actions" },
        el("button", { class: "cta primary sm", onclick: (e) => {
          e.stopPropagation();
          window.MCE.paper && window.MCE.paper.openBuy({
            chain: r.chain, pair: r.p.pairAddress, token: r.address, symbol: r.sym, name: r.name, price: r.price
          });
        } }, "落倉"),
        href ? el("a", { href, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation(), text: " ↗" }) : ""));
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
        if (Array.isArray(c.mentions_daily) && c.mentions_daily.length && c.mentions_daily.some((n) => n > 0)) {
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

  // ---------- Coin Mood / Binance browse (NO Dex hot list) ----------
  const mood = { selected: "BNBUSDT", rows: [] };

  function fmtVol(v) {
    if (v == null || isNaN(v)) return "–";
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  }
  function moodLabel(chg) {
    if (chg == null || isNaN(chg)) return { en: "Feeling…", zh: "載入中" };
    if (chg >= 1.5) return { en: "Feeling good", zh: "心情好好" };
    if (chg <= -1.5) return { en: "Feeling careful", zh: "小心啲" };
    return { en: "Feeling okay", zh: "心情一般" };
  }
  function bnBuyPayload(r) {
    return {
      chain: "binance", pair: r.symbol, token: "binance:" + r.symbol,
      symbol: r.base || r.symbol.replace(/USDT$/, ""),
      name: (r.base || "") + " (Binance)",
      price: r.price, source: "binance",
    };
  }
  function paintMoodHero(r) {
    if (!r) return;
    const live = window.MCE.live;
    const feel = moodLabel(r.chg24);
    const up = (r.chg24 || 0) >= 0;
    const set = (id, t) => { const n = $(id); if (n) n.textContent = t; };
    set("moodFeel", feel.en);
    set("moodFeelZh", feel.zh);
    const mascot = $("moodMascot");
    if (mascot) {
      mascot.textContent = "";
      if (live && live.coinLogoEl) mascot.append(live.coinLogoEl(r.base, "coin-logo mood-logo", 72));
      else mascot.textContent = (r.base || "?").slice(0, 2);
    }
    const ico = $("moodIco");
    if (ico) {
      ico.textContent = "";
      if (live && live.coinLogoEl) ico.append(live.coinLogoEl(r.base, "coin-logo", 22));
    }
    set("moodSym", (r.base || "—") + " /USDT");
    set("moodPrice", price(r.price).replace(/^\$/, ""));
    const chgEl = $("moodChg");
    if (chgEl) {
      chgEl.textContent = pct(r.chg24);
      chgEl.className = "mood-chg " + (up ? "pos" : "neg");
    }
    set("moodLow", "L " + (r.low != null ? price(r.low).replace(/^\$/, "") : "—"));
    set("moodHigh", "H " + (r.high != null ? price(r.high).replace(/^\$/, "") : "—"));
    set("moodVol", "Vol " + fmtVol(r.volQuote));
    const bar = $("moodDot");
    if (bar && r.low != null && r.high != null && r.high > r.low && r.price != null) {
      const pctPos = Math.max(0, Math.min(1, (r.price - r.low) / (r.high - r.low)));
      bar.style.left = (pctPos * 100) + "%";
    }
    const chart = $("moodChart");
    if (chart && live && live.sparkSvg) {
      chart.textContent = "";
      const closes = r.spark || [];
      const svg = live.sparkSvg(closes.length >= 2 ? closes : [r.open || r.low || r.price, r.low || r.price, r.high || r.price, r.price], { w: 280, h: 88, up });
      if (svg) chart.append(svg);
    }
    const buy = $("moodBuy");
    if (buy) buy.onclick = () => window.MCE.paper && window.MCE.paper.openBuy(bnBuyPayload(r));
    const link = $("moodBnLink");
    if (link) {
      link.href = "https://www.binance.com/en/trade/" + encodeURIComponent((r.base || "") + "_USDT");
    }
  }

  async function selectMood(symbol, rows) {
    mood.selected = symbol;
    const live = window.MCE.live;
    let r = (rows || mood.rows).find((x) => x.symbol === symbol) || (live && live.board.get(symbol));
    if (!r) return;
    if (live) {
      const closes = await live.fetchKlines(symbol).catch(() => []);
      if (closes.length) r = { ...r, spark: closes };
    }
    paintMoodHero(r);
    renderBnBoard(mood.rows);
  }

  function renderBnBoard(rows) {
    const list = $("bnList"); if (!list) return;
    const q = (($("bnFilter") && $("bnFilter").value) || "").trim().toLowerCase();
    let data = rows || (window.MCE.live ? window.MCE.live.getBoardRows() : []);
    mood.rows = data.slice();
    if (q) data = data.filter((r) => (r.base || "").toLowerCase().includes(q) || (r.symbol || "").toLowerCase().includes(q));
    // Prefer selected / majors first visually but keep volume sort for rest
    const sel = mood.selected;
    data = data.slice().sort((a, b) => {
      if (a.symbol === sel) return -1;
      if (b.symbol === sel) return 1;
      return (b.volQuote || 0) - (a.volQuote || 0);
    });
    list.textContent = "";
    if (!data.length) {
      list.append(el("p", { class: "muted", text: "暫時冇 Binance 資料。撳 ↻ 再試。" }));
      return;
    }
    const live = window.MCE.live;
    data.forEach((r, i) => {
      const up = (r.chg24 || 0) >= 0;
      const active = r.symbol === sel ? " active" : "";
      const flash = r._flash === "up" ? " tick-up" : r._flash === "down" ? " tick-down" : "";
      const logo = (live && live.coinLogoEl) ? live.coinLogoEl(r.base, "coin-logo", 40) : el("span", { class: "coin-logo letter", text: (r.base || "?").slice(0, 2) });
      const row = el("button", {
        type: "button",
        class: "mood-row anim-in" + active + flash,
        style: "--i:" + Math.min(i, 12),
        "data-bn": r.symbol,
        onclick: () => selectMood(r.symbol, mood.rows),
      });
      const left = el("div", { class: "mood-row-left" },
        logo,
        el("div", {},
          el("div", { class: "nm", text: r.base || r.symbol }),
          el("div", { class: "sy", text: "Vol " + fmtVol(r.volQuote) })
        )
      );
      const mid = el("div", { class: "mood-row-spark", "data-bn-spark": r.symbol });
      if (live && live.sparkSvg) {
        const closes = r.spark || [];
        const svg = live.sparkSvg(closes.length >= 2 ? closes : [r.open || r.price, r.price], { w: 72, h: 28, up });
        if (svg) mid.append(svg);
      }
      const right = el("div", { class: "mood-row-px" },
        el("div", { class: "num live-px", "data-bn-price": r.symbol, text: price(r.price).replace(/^\$/, "") }),
        el("div", { class: "num " + (up ? "pos" : "neg"), "data-bn-chg": r.symbol, text: pct(r.chg24) })
      );
      row.append(left, mid, right);
      // long-press / secondary: buy
      row.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        window.MCE.paper && window.MCE.paper.openBuy(bnBuyPayload(r));
      });
      list.append(row);
    });
    // Buy strip under list for selected
    const meta = $("bnMeta");
    if (meta) meta.textContent = `共 ${mood.rows.length} 組 USDT · Binance 公開價 · ${new Date().toLocaleTimeString("zh-HK", { hour12: false })}`;
  }

  function paintBnStrip(rows) {
    const box = $("bnStripList"); if (!box) return;
    const live = window.MCE.live;
    const data = (rows || (live ? live.getBoardRows() : [])).slice().sort((a, b) => (b.volQuote || 0) - (a.volQuote || 0)).slice(0, 12);
    box.textContent = "";
    for (const r of data) {
      const logo = live && live.coinLogoEl ? live.coinLogoEl(r.base, "coin-logo", 20) : "";
      box.append(el("button", {
        type: "button", class: "bn-chip",
        onclick: () => window.MCE.paper && window.MCE.paper.openBuy(bnBuyPayload(r)),
      },
        el("div", { class: "bn-chip-top" }, logo, el("b", { text: r.base || "" })),
        el("span", { class: "num live-px", "data-bn-price": r.symbol, text: price(r.price) }),
        el("span", { class: "num " + ((r.chg24 || 0) > 0 ? "pos" : (r.chg24 || 0) < 0 ? "neg" : ""), "data-bn-chg": r.symbol, text: pct(r.chg24) })
      ));
    }
  }

  function tickNum(n, dir) {
    if (!n || (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
    n.classList.remove("tick-up", "tick-down");
    void n.offsetWidth;
    n.classList.add(dir === "up" ? "tick-up" : "tick-down");
    clearTimeout(n._tickT);
    n._tickT = setTimeout(() => n.classList.remove("tick-up", "tick-down"), 420);
  }
  function patchBnDom(boardMap) {
    if (!boardMap) return;
    for (const [sym, r] of boardMap) {
      document.querySelectorAll(`[data-bn-price="${sym}"]`).forEach((n) => {
        const raw = price(r.price);
        const next = n.closest(".mood-row, .mood-hero") ? raw.replace(/^\$/, "") : raw;
        const prev = n.textContent;
        if (prev && prev !== next && prev !== "…" && prev !== "—") {
          const a = parseFloat(String(prev).replace(/[^0-9.\-]/g, ""));
          const b = parseFloat(String(next).replace(/[^0-9.\-]/g, ""));
          if (!isNaN(a) && !isNaN(b) && a !== b) tickNum(n, b > a ? "up" : "down");
        }
        n.textContent = next;
      });
      document.querySelectorAll(`[data-bn-chg="${sym}"]`).forEach((n) => {
        n.textContent = pct(r.chg24);
        n.className = (n.className || "").replace(/\b(pos|neg)\b/g, "").trim() + " " + ((r.chg24 || 0) > 0 ? "pos" : (r.chg24 || 0) < 0 ? "neg" : "");
      });
      document.querySelectorAll(`[data-bn-vol="${sym}"]`).forEach((n) => { n.textContent = "24h額 " + money(r.volQuote); });
    }
    // Update hero if selected
    if (mood.selected && boardMap.has(mood.selected)) {
      const r = boardMap.get(mood.selected);
      const feel = moodLabel(r.chg24);
      const set = (id, t) => { const n = $(id); if (n) n.textContent = t; };
      const mp = $("moodPrice");
      if (mp) {
        const next = price(r.price).replace(/^\$/, "");
        const prev = mp.textContent;
        if (prev && prev !== next && prev !== "—") {
          const a = parseFloat(String(prev).replace(/[^0-9.\-]/g, ""));
          const b = parseFloat(String(next).replace(/[^0-9.\-]/g, ""));
          if (!isNaN(a) && !isNaN(b) && a !== b) tickNum(mp, b > a ? "up" : "down");
        }
        mp.textContent = next;
      } else set("moodPrice", price(r.price).replace(/^\$/, ""));
      set("moodFeel", feel.en); set("moodFeelZh", feel.zh);
      set("moodVol", "Vol " + fmtVol(r.volQuote));
      const chgEl = $("moodChg");
      if (chgEl) { chgEl.textContent = pct(r.chg24); chgEl.className = "mood-chg " + ((r.chg24 || 0) >= 0 ? "pos" : "neg"); }
      if (r.low != null) set("moodLow", "L " + price(r.low).replace(/^\$/, ""));
      if (r.high != null) set("moodHigh", "H " + price(r.high).replace(/^\$/, ""));
    }
  }

  async function loadBinanceBoard(force = false) {
    const meta = $("bnMeta");
    if (meta) meta.textContent = "載入 Binance…";
    try {
      if (!window.MCE.live) throw new Error("live.js 未載入");
      const rows = await window.MCE.live.ensureBoard(force);
      mood.rows = rows.slice();
      if (!rows.find((r) => r.symbol === mood.selected) && rows[0]) mood.selected = rows[0].symbol;
      // Prefer BNB if present
      if (!force && rows.find((r) => r.symbol === "BNBUSDT")) mood.selected = "BNBUSDT";
      await selectMood(mood.selected, rows);
      paintBnStrip(rows);
      if (!window.MCE.live.running) {
        window.MCE.live.start({ getPositions: () => (window.MCE.paper && window.MCE.paper.state ? (() => {
          const P = window.MCE.paper.state();
          return {
            spot: Object.values(P.positions || {}).map((p) => ({ chain: p.chain, pair: p.pair, token: p.token, symbol: p.symbol })),
            lev: Object.values(P.levPositions || {}).map((p) => ({ chain: p.chain, pair: p.pair, token: p.token, symbol: p.symbol })),
          };
        })() : { spot: [], lev: [] }) });
      } else {
        window.MCE.live.sync();
      }
      if (window.MCE.onBnBoardLoaded) window.MCE.onBnBoardLoaded(rows);
      setStatus(`Binance ${rows.length} 組 · ${new Date().toLocaleTimeString("zh-HK", { hour12: false })}`);
      return rows;
    } catch (e) {
      console.error(e);
      if (meta) meta.textContent = "Binance 載入失敗：" + e.message;
      return [];
    }
  }

  // Dex browse kept as no-op stubs (explore still uses Dex in full mode)
  const browse = { rows: [], loaded: false };
  async function loadBrowse() { return []; }
  function renderBrowse() {}

  let bnTickBound = false;
  function bindBnTicks() {
    if (bnTickBound || !window.MCE.live) return;
    bnTickBound = true;
    window.MCE.live.onTick((_marks, boardMap) => {
      patchBnDom(boardMap || window.MCE.live.board);
    });
  }

  // ---------- wire up ----------
  let exploreLoaded = false;
  window.MCE = Object.assign(window.MCE || {}, { el, money, price, pct, age, fmtInt, localTime, safeUrl, iconUrl, cachedJson, API,
    ensureExplore() { if (!exploreLoaded) { exploreLoaded = true; loadBuzz().then(() => load()); } },
    ensureBrowse() { return loadBinanceBoard(!!arguments[0]); },
    loadBrowse, renderBrowse, getBrowseRows: () => mood.rows,
    loadBinanceBoard, renderBnBoard, paintBnStrip, selectMood, mood,
  });
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
    // Always prefetch Binance board (AI + Coin Mood)
    loadBinanceBoard(false).then(() => bindBnTicks());
    const bnf = $("bnFilter");
    if (bnf) bnf.addEventListener("input", () => renderBnBoard(mood.rows));
    const bnr = $("bnRefresh");
    if (bnr) bnr.addEventListener("click", () => loadBinanceBoard(true));
    const bns = $("bnSearchBtn");
    if (bns) bns.addEventListener("click", () => {
      const row = $("bnSearchRow");
      if (!row) return;
      row.hidden = !row.hidden;
      if (!row.hidden && $("bnFilter")) $("bnFilter").focus();
    });
  }
  if (typeof document !== "undefined") document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot) : boot();
})();
