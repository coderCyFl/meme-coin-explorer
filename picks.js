/* AI 揀幣 scorecard + 模擬倉. Depends on window.MCE from app.js. */
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


  const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3.6e6;
  const held = (iso) => { const h = hoursSince(iso); return h < 48 ? `${h.toFixed(1)} 小時` : `${(h / 24).toFixed(1)} 日`; };
  const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const money2 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
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
  function evalEntry(b, e) {
    const li = liveInfo(e.chain, e.pair_address);
    const sol = b.benchmarks?.SOL, sl = sol ? liveInfo(sol.chain, sol.pair_address) : { state: "unknown" };
    const ret = li.state === "dead" ? -100 : li.state === "live" ? (li.price / e.entry_price_usd - 1) * 100 : null;
    const solRet = sl.state === "live" ? (sl.price / sol.price_usd - 1) * 100 : null;
    const liqDrop = li.state === "live" && e.entry_snapshot?.liquidity_usd ? li.liq / e.entry_snapshot.liquidity_usd : null;
    return { e, b, li, ret, solRet, excess: ret != null && solRet != null ? ret - solRet : null, liqDrop };
  }
  function horizonCell(x) {
    return el("td", {}, (x.e.horizons_h || [24, 72, 168]).map((h) => {
      const rec = S.outcomes.find((o) => o.pick_id === x.e.id && o.horizon_h === h);
      const label = h === 168 ? "7日" : h + "h";
      if (rec) return el("span", { class: "pill " + (rec.status === "dead" ? "dead" : rec.return_pct >= 0 ? "good" : "bad"), title: `快照 ${localTime(rec.observed_at)} · SOL ${pct(rec.sol_return_pct)}` }, `${label} ${pct(rec.return_pct)}`);
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
    for (const x of top) {
      const tip = x.e.tip || (x.e.rationale || "").split("（")[0].slice(0, 72) || "多角度盤 · 唔係追 24h 升幅";
      const livePx = x.li && x.li.state === "live" ? x.li.price : (x.e.entry_price_usd || null);
      const chg = x.e.entry_snapshot?.chg24h_pct;
      const angle = x.e.angle || x.e.entry_snapshot?.angle || "";
      const logo = liveApi && liveApi.coinLogoEl
        ? liveApi.coinLogoEl(x.e.symbol, "coin-logo", 44)
        : el("span", { class: "coin-logo letter", text: String(x.e.symbol || "?").slice(0, 2) });
      const details = el("details", { class: "sc-details" },
        el("summary", { text: "詳情" }),
        el("div", { class: "sc-detail-body muted" },
          el("div", { text: "角度：" + (ANGLE_LABEL[angle] || angle || "setup") }),
          el("div", { text: "推薦價 " + price(x.e.entry_price_usd) + (chg != null ? " · 當時 24h " + pct(chg) : "") }),
          el("div", { text: (x.e.rationale || "").slice(0, 160) })
        )
      );
      box.append(el("article", { class: "simple-card", "data-angle": angle || "" },
        el("div", { class: "sc-top" },
          logo,
          el("div", { class: "sc-id" },
            el("div", { class: "nm", text: x.e.symbol }),
            el("div", { class: "sy" },
              el("span", { class: "angle-pill", text: ANGLE_LABEL[angle] || "留意盤" }),
              chg != null ? el("span", { class: "num " + cls(chg), text: " 24h " + pct(chg) }) : ""
            )
          ),
          el("div", { class: "sc-px" },
            el("div", { class: "num live-px", "data-bn-price": x.e.pair_address || "", text: livePx != null ? price(livePx) : "…" })
          )
        ),
        el("p", { class: "sc-why", text: tip }),
        details,
        el("div", { class: "sc-actions" },
          el("button", { class: "cta primary", onclick: () => openBuy({
            chain: x.e.chain, pair: x.e.pair_address, token: x.e.token_address,
            symbol: x.e.symbol, name: x.e.name, price: livePx,
            source: x.e.chain === "binance" ? "binance" : undefined,
          }) }, "落倉")
        )
      ));
    }
  }

  function renderChaseList(chasing) {
    const box = $("chaseList"); if (!box) return;
    box.textContent = "";
    const rows = (chasing || []).slice(0, 6);
    if (!rows.length) {
      box.append(el("p", { class: "muted tiny", text: "暫時冇極端急升對照。" }));
      return;
    }
    const liveApi = window.MCE.live;
    for (const r of rows) {
      const base = r.base || r.symbol;
      const logo = liveApi && liveApi.coinLogoEl ? liveApi.coinLogoEl(base, "coin-logo", 28) : "";
      box.append(el("div", { class: "chase-row" },
        logo,
        el("span", { class: "nm", text: base }),
        el("span", { class: "num pos", "data-bn-chg": r.symbol, text: pct(r.chg24) }),
        el("span", { class: "muted tiny", text: "勿追" })
      ));
    }
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
    renderChaseList(chasing);
    renderHotBuysFromBn(picks); // full-mode list shows setups too
    if (meta) {
      const angles = [...new Set(picks.map((p) => p.angle).filter(Boolean))];
      meta.textContent = picks.length
        ? `多角度 · ${picks.length} 隻 · ${angles.map((a) => ANGLE_LABEL[a] || a).join("／")} · 唔係 24h 升幅榜`
        : "未搵到足夠留意盤";
    }
    if (picks.length >= 4) {
      const synth = picks.slice(0, 6).map((r) => ({
        e: {
          chain: "binance", pair_address: r.symbol, token_address: "binance:" + r.symbol,
          symbol: r.base, name: (r.base || "") + " (Binance)",
          entry_price_usd: r.price, conviction: Math.round(r.setupScore || r.score),
          model_score: Math.round(r.setupScore || r.score),
          tip: r.tip, angle: r.angle, rationale: r.tip,
          entry_snapshot: {
            chg24h_pct: r.chg24, volume24h_usd: r.volQuote, high24h: r.high, low24h: r.low, angle: r.angle,
          },
        },
        li: { state: "live", price: r.price, source: "binance" },
        ret: null,
      }));
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
      box.append(el("div", { class: "hot-buy-row" },
        el("div", { class: "tok" },
          logo,
          el("div", {},
            el("div", { class: "nm", text: r.base }),
            el("div", { class: "sy", text: (ANGLE_LABEL[r.angle] || "留意盤") + " · " + (r.tip || "").slice(0, 36) })
          )
        ),
        el("div", { class: "num " + ((r.chg24 || 0) > 0 ? "pos" : (r.chg24 || 0) < 0 ? "neg" : ""), "data-bn-chg": r.symbol, text: pct(r.chg24) }),
        el("div", { class: "num live-px", "data-bn-price": r.symbol, text: price(r.price) }),
        el("button", { class: "cta primary sm", onclick: () => openBuy({
          chain: "binance", pair: r.symbol, token: "binance:" + r.symbol,
          symbol: r.base, name: (r.base || "") + " (Binance)", price: r.price, source: "binance",
        }) }, "落倉")
      ));
    }
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
        el("td", { "data-label": "批次" }, el("div", { text: x.b.id }), el("div", { class: "muted", text: localTime(x.e.created_at) })),
        el("td", { class: "num", "data-label": "信心", title: `模型 ${x.e.model_score} → 信心 ${x.e.conviction}` }, el("b", { text: x.e.conviction ?? x.e.model_score })),
        el("td", { class: "num", "data-label": "推薦價", text: price(x.e.entry_price_usd) }),
        el("td", { class: "num", "data-label": "而家", text: x.li.state === "live" ? price(x.li.price) : x.li.state === "dead" ? "–" : "…" }),
        retTd,
        el("td", { class: "num " + cls(x.solRet), "data-label": "SOL", text: pct(x.solRet) }),
        el("td", { class: "num " + cls(x.excess), "data-label": "vs SOL", text: x.excess == null ? "–" : (x.excess > 0 ? "+" : "") + x.excess.toFixed(1) + " pts" }),
        el("td", { "data-label": "持有", text: held(x.e.created_at) }),
        hz,
        el("td", { "data-label": "", class: "actions" }, el("button", { class: "cta primary buybtn", onclick: (ev) => { ev.stopPropagation(); openBuy({ chain: x.e.chain, pair: x.e.pair_address, token: x.e.token_address, symbol: x.e.symbol, name: x.e.name }); } }, "落倉"), " ",
          href ? el("a", { href, target: "_blank", rel: "noopener", onclick: (ev) => ev.stopPropagation(), text: "↗" }) : "")));
    }
    const ab = $("avoidBody"); ab.textContent = "";
    for (const x of avoidsNewest) {
      const good = x.ret != null && x.ret < -0.05, flat = x.ret != null && Math.abs(x.ret) < 0.05;
      ab.append(el("tr", { onclick: () => showDetail(x) }, tokenCell(x.e),
        el("td", {}, el("div", { text: x.b.id }), el("div", { class: "muted", text: localTime(x.e.created_at) })),
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
    renderSimpleCards(simpleBuys);
    loadLiveBnPicks(false);

    const st = $("pickStats"); st.textContent = "";
    const stat = (k, v, s, c = "") => el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v " + c, text: v }), s ? el("div", { class: "s", text: s }) : "");
    st.append(
      stat("買入推薦", String(buys.length), `${S.picks.batches.length} 批 · ${avoids.length} 條避過 · 樣本少慎讀`),
      stat("勝率", rs.length ? Math.round((rs.filter((v) => v > 0).length / rs.length) * 100) + "%" : "–", rs.length < 20 ? "樣本太少，唔好當結論" : `${rs.filter((v) => v > 0).length}/${rs.length} 賺錢中`),
      stat("平均回報", pct(avg(rs)), "等權、即時", cls(avg(rs))),
      stat("中位回報", pct(median(rs)), "", cls(median(rs))),
      stat("最好 / 最差", best.length ? `${pct(best[0].ret)} / ${pct(best[best.length - 1].ret)}` : "–", best.length ? `$${best[0].e.symbol} / $${best[best.length - 1].e.symbol}` : ""),
      stat("同期 SOL", pct(avg(sols)), "基準平均", cls(avg(sols))),
      stat("平均跑贏 SOL", ex.length ? (avg(ex) > 0 ? "+" : "") + avg(ex).toFixed(1) + " pts" : "–", `${ex.filter((v) => v > 0).length}/${ex.length} 跑贏`, cls(avg(ex))),
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
    const scoreLine = Object.keys(parts).length
      ? `${e.model_score}/100${e.conviction != null ? ` → 信心 ${e.conviction}` : ""} · ` + Object.entries(parts).map(([k, v]) => `${k} ${v}`).join(", ")
      : `${e.model_score}/100${e.conviction != null ? ` → 信心 ${e.conviction}` : ""}`;
    d.append(
      el("h3", { text: `${e.type === "buy" ? "🟢 買入推薦" : "🔴 避過"}：${e.name} ($${e.symbol}) · ${e.id}` }),
      el("p", { class: "rationale", text: e.rationale }),
      e.type === "buy" ? el("p", {}, el("button", { class: "primary buybtn", onclick: () => openBuy({ chain: e.chain, pair: e.pair_address, token: e.token_address, symbol: e.symbol, name: e.name, source: e.chain === "binance" ? "binance" : undefined }) }, "落倉 · 放入模擬倉")) : "",
      el("div", { class: "kv" },
        el("div", { text: "記錄時間" }), el("div", { text: `${localTime(e.created_at)} (${e.created_at})` }),
        el("div", { text: "推薦價" }), el("div", { text: `${price(e.entry_price_usd)} · 當時 SOL $${x.b.benchmarks?.SOL?.price_usd ?? "?"}` }),
        el("div", { text: "入場快照" }), el("div", { text: `流動性 ${money(snap.liquidity_usd)} · 24h 成交 ${money(snap.volume24h_usd)} · 市值 ${money(snap.market_cap_usd)} · 年齡 ${ageH} · 24h ${pct(snap.chg24h_pct)}` }),
        el("div", { text: "模型分數" }), el("div", { text: scoreLine }),
        el("div", { text: "旗標" }), el("div", { text: (e.flags || []).join(" · ") || "無" }),
        el("div", { text: bnEv ? "證據" : "X 證據" }), el("div", { text: evidenceText })),
      el("div", {}, (ev.posts || []).map((u) => safeUrl(u) ? [el("a", { href: safeUrl(u), target: "_blank", rel: "noopener nofollow", text: "X 帖 ↗" }), " "] : "")));
  }

  // ---------- 模擬倉（現貨 + 槓桿逐倉） ----------
  const PF_KEY = "mce:paper:v2";
  const PF_KEY_OLD = "mce:paper:v1";
  const START_CASH = 5000;
  const CAP_PRESETS = [1000, 5000, 10000, 50000];
  const LEV_ALL = [2, 3, 5, 10, 20, 50];
  const LIQ_MARGIN_FRAC = 0.9; // 浮虧達保證金 90% → 爆倉
  const RISK = {
    safe: { id: "safe", label: "穩陣", maxLev: 3, defaultLev: 2, allowLev: true, spotOnlyCopy: true },
    agg:  { id: "agg",  label: "進取", maxLev: 10, defaultLev: 5, allowLev: true, spotOnlyCopy: false },
    yolo: { id: "yolo", label: "極高風險", maxLev: 50, defaultLev: 10, allowLev: true, spotOnlyCopy: false },
    allin: { id: "allin", label: "孤注一擲", maxLev: 50, defaultLev: 50, allowLev: true, spotOnlyCopy: true },
  };
  let riskId = localStorage.getItem("mce:risk") || "agg";
  const risk = () => RISK[riskId] || RISK.agg;
  function setRisk(id) {
    if (!RISK[id]) return;
    riskId = id;
    localStorage.setItem("mce:risk", id);
    document.querySelectorAll("[data-risk]").forEach((b) => b.classList.toggle("active", b.dataset.risk === id));
    const h = $("riskHint");
    if (h) {
      h.textContent = id === "safe" ? "穩陣：偏向現貨，槓桿最多 3x。假錢都可以慢慢玩。"
        : id === "yolo" ? "💥 極高風險：最多 50x。假錢儘管試大；真錢唔好咁玩。跌一啲就爆倉。"
        : id === "allin" ? "🎰 孤注一擲：一隻幣 All-in（現貨或 50x）。輸就歸零、贏就大賺。假錢試膽。"
        : "進取：最多 10x。假錢可以試大倉；真倉請當娛樂數據。";
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
        realizedSpot: old.realized || 0, realizedLev: 0, feePct: old.feePct ?? 1,
        positions: old.positions || {}, levPositions: {}, trades: old.trades || [],
        liquidations: 0, equityPeak: old.start || START_CASH,
        firstBuyAt: old.firstBuyAt || null, solAtFirstBuy: old.solAtFirstBuy || null,
        allin: null, created: old.created || new Date().toISOString(),
      };
    },
    fresh(start) {
      const s = Number(start) > 0 ? Number(start) : START_CASH;
      return { v: 2, start: s, cash: s, realizedSpot: 0, realizedLev: 0, feePct: 1,
        positions: {}, levPositions: {}, trades: [], liquidations: 0, equityPeak: s,
        firstBuyAt: null, solAtFirstBuy: null, created: new Date().toISOString() };
    },
    load() {
      try {
        const raw = localStorage.getItem(PF_KEY) || localStorage.getItem(PF_KEY_OLD);
        if (!raw) return this.fresh(START_CASH);
        const s = JSON.parse(raw);
        if (s.v === 2) return s;
        if (s.v === 1) { const m = this.migrate(s); this.save(m); return m; }
      } catch {}
      return this.fresh(START_CASH);
    },
    save(s) { localStorage.setItem(PF_KEY, JSON.stringify(s)); },
  };
  let P = pf.load();
  let pfMode = "all"; // spot | lev | all — portfolio section filter
  const posKey = (chain, pair) => chain + ":" + pair;
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

  async function livePrice(chain, pair) {
    if (chain === "binance") {
      if (window.MCE.live) {
        try { await window.MCE.live.ensureBoard(false); } catch {}
        // Force sync so mark exists
        const m = window.MCE.live.getMark("binance", pair);
        if (m && m.price > 0) {
          return { state: "live", price: m.price, liq: 1e12, source: "binance", p: null };
        }
        // Last resort REST via board seed
        const rows = window.MCE.live.getBoardRows() || [];
        const row = rows.find((r) => r.symbol === pair);
        if (row && row.price > 0) {
          return { state: "live", price: row.price, liq: 1e12, source: "binance", p: null };
        }
      }
      throw new Error("暫時攞唔到 Binance 報價");
    }
    await fetchPairs([{ chain, pair }], true);
    const li = liveInfo(chain, pair);
    if (li.state !== "live") throw new Error(li.state === "dead" ? "交易對已死或冇流動性，唔可以交易" : "暫時攞唔到報價");
    return li;
  }
  async function ensureSolBenchmark() {
    if (!S.picks) await loadPicks();
    const last = S.picks?.batches?.[S.picks.batches.length - 1];
    const sol = last?.benchmarks?.SOL;
    if (!sol) return null;
    await fetchPairs([{ chain: sol.chain, pair: sol.pair_address }], false);
    return sol;
  }
  async function touchFirstBuy() {
    if (P.firstBuyAt) return;
    P.firstBuyAt = new Date().toISOString();
    const sol = await ensureSolBenchmark();
    if (sol) {
      const sl = liveInfo(sol.chain, sol.pair_address);
      P.solAtFirstBuy = { chain: sol.chain, pair: sol.pair_address, price: sl.state === "live" ? sl.price : sol.price_usd };
    }
  }

  /** Generic dialog. opts: {modePicker, defaultMode, levDefault, preview(amt, {mode, lev})} → {amt, mode, lev} | null */
  function askTrade({ title, info, label, value, quick = [], preview, okLabel, modePicker = false, defaultMode = "spot", levDefault = null, callout = null }) {
    return new Promise((resolve) => {
      const dlg = $("tradeDlg"), inp = $("tradeAmt");
      let mode = defaultMode;
      let lev = levDefault != null ? levDefault : risk().defaultLev;
      const maxL = risk().maxLev;
      if (mode === "lev" && !risk().allowLev) mode = "spot";
      if (riskId === "safe" && modePicker) { /* still allow choosing lev but capped */ }
      lev = Math.min(lev, maxL);

      $("tradeTitle").textContent = title;
      $("tradeInfo").textContent = info;
      $("tradeAmtLabel").textContent = label;
      $("tradeOk").textContent = okLabel || "確認";
      $("tradeModeRow").hidden = !modePicker;
      setRisk(riskId);
      document.querySelectorAll("#tradeRisk [data-risk]").forEach((b) => {
        b.classList.toggle("active", b.dataset.risk === riskId);
        b.onclick = () => { setRisk(b.dataset.risk); lev = Math.min(lev, risk().maxLev); rebuildLevPresets(lev); if (mode === "lev" && riskId === "safe") {/* ok */} upd(); };
      });
      rebuildLevPresets(lev);
      $("tradeLevRow").hidden = !modePicker || mode !== "lev";
      $("tradeSimNote").textContent = mode === "lev"
        ? "💥 槓桿模擬：假錢儘管試大；真錢唔好咁玩。保證金可以歸零。"
        : "🧪 現貨模擬。假錢可以落大注；真錢請當娛樂。";
      const co = $("tradeCallout");
      const paintCallout = (text, hot) => {
        if (!text) { co.hidden = true; co.textContent = ""; return; }
        co.hidden = false; co.className = "risk-callout" + (hot ? " hot" : ""); co.textContent = text;
      };

      document.querySelectorAll("#tradeModeRow .segbtn").forEach((b) => {
        b.classList.toggle("active", b.dataset.trademode === mode);
        b.onclick = () => {
          mode = b.dataset.trademode;
          if (mode === "lev" && riskId === "safe") {
            // allow but warn
          }
          document.querySelectorAll("#tradeModeRow .segbtn").forEach((x) => x.classList.toggle("active", x === b));
          $("tradeLevRow").hidden = mode !== "lev";
          $("tradeAmtLabel").textContent = mode === "lev" ? "保證金 (USD)" : label;
          $("tradeSimNote").textContent = mode === "lev"
            ? "💥 槓桿模擬：假錢儘管試大；真錢唔好咁玩。"
            : "🧪 現貨模擬。假錢可以落大注。";
          upd();
        };
      });
      $("tradeLev").onchange = () => { lev = parseInt($("tradeLev").value, 10) || risk().defaultLev; upd(); };
      inp.value = value;
      const q = $("tradeQuick"); q.textContent = "";
      for (const [t, v] of quick) q.append(el("button", { type: "button", class: "sm", onclick: () => { inp.value = v; upd(); } }, t));
      const upd = () => {
        lev = Math.min(parseInt($("tradeLev").value, 10) || risk().defaultLev, risk().maxLev);
        $("tradeLev").value = String(lev);
        const amt = parseFloat(inp.value) || 0;
        $("tradePreview").textContent = preview(amt, { mode, lev });
        if (typeof callout === "function") paintCallout(...(callout(amt, { mode, lev }) || [null, false]));
        else paintCallout(null, false);
      };
      inp.oninput = upd; upd();
      const done = (v) => { dlg.close(); $("tradeForm").onsubmit = null; $("tradeCancel").onclick = null; resolve(v); };
      $("tradeForm").onsubmit = (ev) => {
        ev.preventDefault();
        const amt = parseFloat(inp.value);
        const L = Math.min(parseInt($("tradeLev").value, 10) || risk().defaultLev, risk().maxLev);
        if (mode === "lev" && L >= 20) {
          if (!confirm(`真係要 ${L}x？假錢可以，但跌 ${(LIQ_MARGIN_FRAC / L * 100).toFixed(1)}% 就爆倉。繼續？`)) return;
        }
        done(amt > 0 ? { amt, mode, lev: L } : null);
      };
      $("tradeCancel").onclick = () => done(null);
      dlg.onclose = () => resolve(null);
      dlg.showModal(); inp.focus(); inp.select();
    });
  }

  async function doBuySpot(info, li, usd, { allowAllin = false } = {}) {
    if (allinActive() && !allowAllin) assertNotAllin("加倉");
    usd = Math.min(usd, P.cash);
    if (!(usd > 0)) throw new Error("模擬現金唔夠");
    await touchFirstBuy();
    const fee = usd * P.feePct / 100;
    const imp = estimateImpact(usd, li.liq || 0);
    const fillPx = li.price * (1 + imp.impactPct / 100); // buy worse
    const qty = (usd - fee) / fillPx;
    const k = posKey(info.chain, info.pair);
    const pos = P.positions[k] || { chain: info.chain, pair: info.pair, token: info.token, symbol: info.symbol, name: info.name, qty: 0, cost: 0, source: info.source || (info.chain === "binance" ? "binance" : "dex") };
    pos.qty += qty; pos.cost += usd; pos.source = pos.source || info.source || (info.chain === "binance" ? "binance" : "dex"); P.positions[k] = pos; P.cash -= usd;
    P.trades.unshift({ t: new Date().toISOString(), kind: "spot", side: "BUY", chain: info.chain, pair: info.pair, symbol: info.symbol, price: fillPx, qty, usd, fee, pnl: null, leverage: null, impactPct: imp.impactPct });
    pf.save(P);
  }

  async function doOpenLev(info, li, margin, leverage, { allowAllin = false } = {}) {
    if (allinActive() && !allowAllin) assertNotAllin("開槓桿");
    leverage = Math.min(50, Math.max(2, leverage || risk().defaultLev));
    const notional = margin * leverage;
    const fee = notional * P.feePct / 100;
    const imp = estimateImpact(notional, li.liq || 0);
    if (margin + fee > P.cash + 1e-9) throw new Error(`現金唔夠：要保證金 ${money2(margin)} + 開倉費 ${money2(fee)}`);
    if (!(margin > 0)) throw new Error("保證金要大於 0");
    await touchFirstBuy();
    const fillPx = li.price * (1 + imp.impactPct / 100);
    const qty = notional / fillPx;
    const id = levKey();
    P.levPositions[id] = {
      id, chain: info.chain, pair: info.pair, token: info.token, symbol: info.symbol, name: info.name,
      side: "long", leverage, margin, notional, entry: fillPx, qty, openFee: fee, openedAt: new Date().toISOString(), impactPct: imp.impactPct,
    };
    P.cash -= margin + fee;
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

  function allinScenarioHTML(mode, cash, price0, lev) {
    const rows = [];
    if (mode === "spot") {
      const qty = cash * (1 - P.feePct / 100) / price0;
      for (const m of [0, 0.5, 1, 2, 5, 10]) {
        const px = price0 * m, val = qty * px, ret = (val / cash - 1) * 100;
        const label = m === 0 ? "歸零" : m === 0.5 ? "跌一半" : m === 1 ? "不變" : `×${m}`;
        rows.push({ label, val, ret });
      }
    } else {
      const margin = cash / (1 + lev * P.feePct / 100); // leave room for open fee on notional
      const notional = margin * lev;
      const fee = notional * P.feePct / 100;
      const qty = notional / price0;
      const lp = liqPriceLong(price0, lev);
      rows.push({ label: "爆倉", val: 0, ret: -100, note: `價 ≤ ${price(lp)}（跌約 ${(LIQ_MARGIN_FRAC / lev * 100).toFixed(1)}%）` });
      for (const m of [1, 2, 5, 10]) {
        const px = price0 * m;
        const u = qty * (px - price0);
        const eq = margin + u; // before close fee
        const ret = ((eq - fee) /* rough */ / cash - 1) * 100;
        rows.push({ label: m === 1 ? "不變" : `×${m}`, val: Math.max(0, eq), ret: (eq / cash - 1) * 100 });
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

  async function pickAllinCoin() {
    if (!S.picks) await loadPicks();
    const buys = (S.picks?.batches || []).flatMap((b) => b.entries.filter((e) => e.type === "buy")
      .map((e) => ({ ...e, batch: b.id })));
    return new Promise((resolve) => {
      const dlg = $("allinPickDlg"), list = $("allinPickList");
      list.textContent = "";
      if (!buys.length) {
        list.append(el("p", { class: "muted", text: "未有 AI 買入推薦。去市場掃描揀幣後用詳情「落倉」唔適用——請等有推薦，或重置後再試。" }));
      }
      for (const e of buys) {
        list.append(el("button", { type: "button", class: "allin-pick", onclick: () => { dlg.close(); resolve({
          chain: e.chain, pair: e.pair_address, token: e.token_address, symbol: e.symbol, name: e.name, url: e.url,
        }); } },
          el("b", { text: "$" + e.symbol }), " ", el("span", { class: "muted", text: e.name + " · " + e.chain }),
          el("div", { class: "muted", text: "信心 " + (e.conviction ?? e.model_score) })));
      }
      $("allinPickCancel").onclick = () => { dlg.close(); resolve(null); };
      dlg.onclose = () => {};
      dlg.showModal();
    });
  }

  async function openAllinFlow(preselected) {
    try {
      if (allinActive()) { toast("已經有一鋪進行中"); location.hash = "portfolio"; return; }
      // clear other positions? User should start clean — warn if has positions
      if (Object.keys(P.positions).length || Object.keys(P.levPositions).length) {
        if (!confirm("孤注一擲會要求空倉。要重置模擬倉再開始嗎？（會清空現有倉同現金回到起始資金）")) return;
        const fee = P.feePct, start = P.start; P = pf.fresh(start); P.feePct = fee; pf.save(P);
      }
      setRisk("allin");
      const info = preselected || await pickAllinCoin();
      if (!info) return;
      const li = await livePrice(info.chain, info.pair);
      let mode = "spot";
      const cash = P.cash;
      $("allinInfo").textContent = `$${info.symbol}（${info.name}）· 價 ${price(li.price)} · 可用現金 ${money2(cash)}`;
      const paint = () => {
        document.querySelectorAll("#allinModeSeg .segbtn").forEach((b) => b.classList.toggle("active", b.dataset.allinmode === mode));
        if (mode === "spot") {
          $("allinCallout").textContent = `現貨 All-in：用晒約 ${money2(cash)} 買 $${info.symbol}。歸零＝輸晒；翻倍≈賺一個起始倉。`;
          renderAllinScenarios("spot", cash, li.price, 50);
        } else {
          const lev = 50;
          const margin = cash / (1 + lev * P.feePct / 100);
          const notional = margin * lev;
          const drop = LIQ_MARGIN_FRAC / lev * 100;
          $("allinCallout").textContent = `槓桿 All-in ${lev}x：保證金≈${money2(margin)} · 名義≈${money2(notional)} · 跌約 ${drop.toFixed(1)}% 就爆倉歸零。假錢儘管試；真錢唔好。`;
          renderAllinScenarios("lev", cash, li.price, lev);
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
        key: k, entry: li.price, startedAt: new Date().toISOString(), cashBefore, leverage: null };
    } else {
      const lev = 50;
      // use max margin such that margin + notional*fee <= cash
      const margin = Math.floor(P.cash / (1 + lev * P.feePct / 100) * 100) / 100;
      if (!(margin > 1)) throw new Error("現金唔夠開槓桿");
      const id = await doOpenLev(info, li, margin, lev, { allowAllin: true });
      P.allin = { status: "open", mode: "lev", symbol: info.symbol, name: info.name, chain: info.chain, pair: info.pair, token: info.token,
        key: id, entry: li.price, startedAt: new Date().toISOString(), cashBefore, leverage: lev };
    }
    pf.save(P);
    const modeLabel = mode === "lev" ? "50x 槓桿" : "現貨 All-in";
    await playOverlay({
      emoji: mode === "lev" ? "🚀" : "🎰",
      title: "孤注一擲！",
      sub: "一舖過",
      coin: `$${info.symbol} · ${modeLabel}`,
      kind: "",
      ms: 1600,
    });
    toast(`🎰 孤注一擲已開始：$${info.symbol}（${mode === "lev" ? "50x" : "現貨"}）`);
    ensureLiveLoop(true);
    location.hash = "portfolio";
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
    box.classList.add("show-anim", bust ? "bust-theme" : win ? "win-theme" : "");
    body.textContent = "";
    body.append(
      el("div", { class: "allin-title", text: bust ? "💥 爆倉／歸零" : win ? "今鋪贏咗 🎉" : "今鋪完結" }),
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

  async function closeAllinFromBanner() {
    if (!allinActive()) return;
    const a = P.allin;
    try {
      if (a.mode === "spot") {
        const k = a.key;
        if (!P.positions[k]) { // already gone
          await endAllinRound({ reason: "已無持倉", exitPrice: a.entry, retPct: -100, pnl: -a.cashBefore });
          renderPortfolio(false); return;
        }
        const li = await livePrice(a.chain, a.pair).catch(() => ({ price: 0, writeoff: true }));
        const pos = P.positions[k];
        const gross = pos.qty * li.price, fee = gross * P.feePct / 100, proceeds = gross - fee;
        const pnl = proceeds - pos.cost;
        const retPct = a.cashBefore ? (proceeds / a.cashBefore - 1) * 100 : (pnl / pos.cost) * 100;
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
          await endAllinRound({ reason: "爆倉", exitPrice: last?.price ?? 0, retPct: -100, pnl: -(a.cashBefore || 0) });
          renderPortfolio(false); return;
        }
        const pos = P.levPositions[id];
        const li = await livePrice(pos.chain, pos.pair);
        const m = levMark(pos, li.price);
        if (m.dead) {
          await closeLev(id, { forceLiq: true, markPrice: li.price });
          await endAllinRound({ reason: "爆倉", exitPrice: li.price, retPct: -100, pnl: -(a.cashBefore || pos.margin) });
        } else {
          const closeFee = pos.qty * li.price * P.feePct / 100;
          const back = pos.margin + m.unreal - closeFee;
          const pnl = m.unreal - closeFee - (pos.openFee || 0);
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
    setRisk("allin");
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
    let livePct = null, equity = P.cash, extra = "";
    if (a.mode === "spot") {
      const pos = P.positions[a.key];
      if (pos) {
        const li = liveInfo(a.chain, a.pair);
        const px = li.state === "live" ? li.price : null;
        const val = px != null ? pos.qty * px : null;
        if (val != null && a.cashBefore) livePct = (val / a.cashBefore - 1) * 100;
        equity = P.cash + (val || 0);
        extra = px != null ? `標記 ${price(px)}` : "";
      }
    } else {
      const pos = P.levPositions[a.key];
      if (pos) {
        const li = liveInfo(a.chain, a.pair);
        const px = li.state === "live" ? li.price : null;
        if (px != null) {
          const m = levMark(pos, px);
          livePct = a.cashBefore ? ((P.cash + m.equity) / a.cashBefore - 1) * 100 : (m.unreal / pos.margin) * 100;
          equity = P.cash + m.equity;
          const toLiq = (px - liqPriceLong(pos.entry, pos.leverage)) / px * 100;
          extra = `距爆倉 ${toLiq.toFixed(2)}% · ${pos.leverage}x`;
        }
      } else {
        // liquidated under us
        extra = "可能已爆倉";
      }
    }
    const live = $("allinLive");
    live.textContent = "";
    live.append(
      el("div", {}, el("b", { text: "$" + a.symbol }), " · ", a.mode === "lev" ? (a.leverage || 50) + "x" : "現貨"),
      el("div", { class: cls(livePct) }, "盈虧 ", livePct == null ? "…" : pct(livePct)),
      el("div", { text: "權益 " + money2(equity) }),
      el("div", { class: "muted", text: `入場 ${price(a.entry)} · ${extra}` })
    );
    if (livePct != null) flashAllinPnl(livePct);
  }

  async function openBuy(info) {
    try {
      if (allinActive()) { toast("孤注一擲進行中，請先平倉"); location.hash = "portfolio"; return; }
      if (riskId === "allin") { await openAllinFlow(info); return; }
      const li = await livePrice(info.chain, info.pair);
      const defMode = riskId === "safe" ? "spot" : "spot";
      const liqNote = info.chain === "binance" || li.source === "binance"
        ? "來源 Binance 即時"
        : `流動性 ${money(li.liq)}`;
      const res = await askTrade({
        title: `落倉 $${info.symbol}`,
        info: `即時價 ${price(li.price)} · ${liqNote} · 現金 ${money2(P.cash)} · 檔：${risk().label}`,
        label: "落倉金額 (USD)",
        value: Math.min(Math.max(100, Math.round(P.cash * 0.1)), Math.floor(P.cash)),
        quick: [
          ["$100", 100], ["$500", 500], ["$1k", 1000],
          ["10%現金", Math.floor(P.cash * 0.1)], ["25%現金", Math.floor(P.cash * 0.25)], ["半倉", Math.floor(P.cash / 2)],
        ].map(([t, v]) => [t, Math.min(v, Math.floor(P.cash))]),
        modePicker: true, defaultMode: defMode, levDefault: risk().defaultLev,
        preview: (v, { mode, lev }) => {
          if (mode === "lev") {
            const n = v * lev, fee = n * P.feePct / 100, lp = liqPriceLong(li.price, lev);
            const drop = (LIQ_MARGIN_FRAC / lev * 100);
            const imp = estimateImpact(n, li.liq || 0);
            return `槓桿 ${lev}x · 名義 ${money2(n)} · 費 ${money2(fee)} + 衝擊≈${imp.impactPct.toFixed(1)}% · 爆倉約跌 ${drop.toFixed(1)}% · 現金要 ${money2(v + fee)}`;
          }
          const imp = estimateImpact(v, li.liq || 0);
          return `現貨 · 費 ${money2(v * P.feePct / 100)} + 衝擊≈${imp.impactPct.toFixed(1)}% · ${imp.note}`;
        },
        callout: (v, { mode, lev }) => {
          if (!(v > 0)) return [null, false];
          if (mode === "lev") {
            const n = v * lev, drop = LIQ_MARGIN_FRAC / lev * 100;
            const imp = estimateImpact(n, li.liq || 0);
            return [`若價翻倍：浮盈約 ${money2(v * lev)}（未計費／衝擊）· 若跌 ${drop.toFixed(1)}%：💥 爆倉 · ${imp.note}`, lev >= 10 || imp.impactPct >= 5];
          }
          const imp = estimateImpact(v, li.liq || 0);
          return [`若翻倍：約賺 ${money2(v)} · 若歸零：最多蝕 ${money2(v)} · ${imp.note}`, v >= P.cash * 0.25 || imp.impactPct >= 5];
        },
        okLabel: "確認落倉",
      });
      if (!res) return;
      if (res.mode === "lev") {
        await doOpenLev(info, li, res.amt, res.lev);
        toast(`已開 ${res.lev}x $${info.symbol}，保證金 ${money2(res.amt)}`);
        floatPop("🪙 +" + res.lev + "x"); pfMode = "lev";
      } else {
        await doBuySpot(info, li, res.amt);
        toast(`已現貨落倉 ${money2(res.amt)} $${info.symbol}`);
        floatPop("🪙"); pfMode = "spot";
      }
      ensureLiveLoop(true);
      if (location.hash.slice(1) !== "portfolio") location.hash = "portfolio";
      else await renderPortfolio(true);
    } catch (e) { alert(e.message); }
  }

  async function openSell(k) {
    const pos = P.positions[k]; if (!pos) return;
    if (allinActive()) {
      if (P.allin.mode === "spot" && P.allin.key === k) return closeAllinFromBanner();
      return alert("孤注一擲進行中，請用上方橫幅平倉");
    }
    try {
      const li = await livePrice(pos.chain, pos.pair).catch((e) => { if (confirm(e.message + "。要以 $0 銷帳嗎？")) return { price: 0, liq: 0, writeoff: true }; throw e; });
      const pctSell = li.writeoff ? 100 : (await askTrade({
        title: `平倉（現貨）$${pos.symbol}`,
        info: `即時價 ${price(li.price)} · 持有 ${pos.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        label: "平倉比例 %", value: 100, quick: [["25%", 25], ["50%", 50], ["100%", 100]],
        modePicker: false,
        preview: (v) => { const q = pos.qty * Math.min(100, v) / 100, gross = q * li.price; return `大約收回 ${money2(gross * (1 - P.feePct / 100))}（扣 ${P.feePct}%）`; },
        okLabel: "確認平倉",
      }))?.amt;
      if (pctSell == null) return;
      const f = Math.min(100, pctSell) / 100, qty = pos.qty * f, gross = qty * li.price, fee = gross * P.feePct / 100, proceeds = gross - fee;
      const costPart = pos.cost * f, pnl = proceeds - costPart;
      pos.qty -= qty; pos.cost -= costPart; P.cash += proceeds; P.realizedSpot += pnl;
      if (f >= 0.9999 || pos.qty <= 0) delete P.positions[k];
      P.trades.unshift({ t: new Date().toISOString(), kind: "spot", side: li.writeoff ? "WRITE-OFF" : "SELL", chain: pos.chain, pair: pos.pair, symbol: pos.symbol, price: li.price, qty, usd: proceeds, fee, pnl, leverage: null });
      pf.save(P); toast(`已平倉 ${Math.round(f * 100)}% 現貨 $${pos.symbol}：${money2(pnl)}`); renderPortfolio(false);
    } catch (e) { alert(e.message); }
  }

  async function closeLev(id, { forceLiq = false, markPrice = null } = {}) {
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
    const isLiq = forceLiq || m.dead;
    if (isLiq) {
      // 保證金歸零，唔退回 cash
      const pnl = -pos.margin - (pos.openFee || 0);
      P.realizedLev += pnl;
      P.liquidations = (P.liquidations || 0) + 1;
      P.trades.unshift({ t: new Date().toISOString(), kind: "lev", side: "LIQUIDATE", chain: pos.chain, pair: pos.pair, symbol: pos.symbol, price: mark, qty: pos.qty, usd: 0, fee: 0, pnl, leverage: pos.leverage, notional: pos.notional });
      delete P.levPositions[id];
      pf.save(P);
      toast(`💥 $${pos.symbol} ${pos.leverage}x 已爆倉，保證金 ${money2(pos.margin)} 歸零`);
      return;
    }
    const res = await askTrade({
      title: `平倉（槓桿 ${pos.leverage}x）$${pos.symbol}`,
      info: `標記價 ${price(mark)} · 保證金 ${money2(pos.margin)} · 浮盈虧 ${money2(m.unreal)} · 爆倉價 ${price(m.liq)}`,
      label: "平倉比例 %（v1 只支援全平）", value: 100, quick: [["100%", 100]],
      modePicker: false,
      preview: () => {
        const closeFee = pos.qty * mark * P.feePct / 100;
        const back = pos.margin + m.unreal - closeFee;
        return `退回約 ${money2(back)}（保證金+浮盈虧−平倉費 ${money2(closeFee)}）`;
      },
      okLabel: "確認平倉",
    });
    if (!res) return;
    const closeFee = pos.qty * mark * P.feePct / 100;
    const back = pos.margin + m.unreal - closeFee;
    const pnl = m.unreal - closeFee - (pos.openFee || 0);
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
    if (riskId === "allin") return alert("孤注一擲請撳「🎰 孤注一擲」揀一隻幣，唔好用跟晒");
    if (!S.picks) await loadPicks();
    const last = S.picks.batches[S.picks.batches.length - 1];
    const buys = last.entries.filter((e) => e.type === "buy");
    if (!buys.length) return alert("今批冇買入推薦");
    const allowLevCopy = riskId !== "safe";
    const res = await askTrade({
      title: `跟晒今批（${last.id} · ${risk().label}）`,
      info: buys.map((b) => "$" + b.symbol).join("、") + ` · 現金 ${money2(P.cash)}` + (allowLevCopy ? " · 可選「槓桿」用細保證金高倍（危險）" : " · 穩陣檔只限現貨"),
      label: "總金額／總保證金 (USD)", value: Math.min(3000, Math.floor(P.cash)),
      quick: [["$500", 500], ["$1k", 1000], ["$3k", 3000], ["$5k", 5000], ["全倉", Math.floor(P.cash)]].map(([t, v]) => [t, Math.min(v, Math.floor(P.cash))]),
      modePicker: allowLevCopy, defaultMode: "spot", levDefault: risk().defaultLev,
      preview: (v, { mode, lev }) => {
        const each = v / buys.length;
        if (mode === "lev") return `每幣保證金 ${money2(each)} · ${lev}x · 名義各 ${money2(each * lev)} · 總名義 ${money2(v * lev)} · 開倉費共約 ${money2(v * lev * P.feePct / 100)}`;
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
      if (!confirm(`確定用 ${res.lev}x 細保證金跟晒 ${buys.length} 隻？假錢可以；真錢唔好。`)) return;
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
    location.hash = "portfolio";
    renderPortfolio(false);
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
    if (P.solAtFirstBuy) need.push({ chain: P.solAtFirstBuy.chain, pair: P.solAtFirstBuy.pair });
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
      toast(`💥 ${liqN} 個槓桿倉觸發爆倉`);
      if (P.allin && P.allin.status === "open" && P.allin.mode === "lev" && !P.levPositions[P.allin.key]) {
        const last = P.trades.find((t) => t.side === "LIQUIDATE" && t.symbol === P.allin.symbol);
        endAllinRound({ reason: "爆倉", exitPrice: last?.price ?? 0, retPct: -100, pnl: -(P.allin.cashBefore || 0) });
      }
    }
    const levEntries2 = Object.entries(P.levPositions);

    let spotValue = 0, spotCost = 0;
    const hb = $("holdBody"); hb.textContent = "";
    for (const [k, p] of Object.entries(P.positions)) {
      const li = liveInfo(p.chain, p.pair);
      const px = li.state === "live" ? li.price : li.state === "dead" ? 0 : null;
      const v = px == null ? null : p.qty * px;
      if (v != null) spotValue += v; spotCost += p.cost;
      const u = v == null ? null : v - p.cost;
      const upct = u == null || !p.cost ? null : (u / p.cost) * 100;
      const flashCls = li.flash === "up" ? " tick-up" : li.flash === "down" ? " tick-down" : "";
      hb.append(el("tr", { class: "cardish" + flashCls, "data-pos": k },
        el("td", { "data-label": "幣" }, el("b", { text: "$" + p.symbol }), " ", el("span", { class: "muted", text: p.chain }), " ", srcBadge(p.chain, p.pair, li), li.state === "dead" ? el("span", { class: "pill dead" }, "已死") : ""),
        el("td", { class: "num", "data-label": "數量", text: p.qty.toLocaleString(undefined, { maximumFractionDigits: 2 }) }),
        el("td", { class: "num", "data-label": "入場", text: price(p.cost / p.qty) }), el("td", { class: "num", "data-label": "成本", text: money2(p.cost) }),
        el("td", { class: "num live-px", "data-label": "而家", text: px == null ? "…" : price(px) }), el("td", { class: "num", "data-label": "市值", text: v == null ? "…" : money2(v) }),
        el("td", { class: "num " + cls(upct), "data-label": "浮盈虧%", text: upct == null ? "…" : pct(upct) }),
        el("td", { class: "num " + cls(u), "data-label": "浮盈虧$", text: u == null ? "…" : money2(u) }),
        el("td", { "data-label": "", class: "actions" }, el("button", { class: "cta", onclick: () => openSell(k) }, "平倉"), " ",
          el("button", { class: "cta primary", onclick: () => openBuy({ chain: p.chain, pair: p.pair, token: p.token, symbol: p.symbol, name: p.name }) }, "加倉"))));
    }
    $("holdEmpty").hidden = Object.keys(P.positions).length > 0;

    let levEquity = 0, levMargin = 0, levUnreal = 0;
    const lb = $("levBody"); lb.textContent = "";
    for (const [id, pos] of levEntries2) {
      const li = liveInfo(pos.chain, pos.pair);
      const px = li.state === "live" ? li.price : li.state === "dead" ? 0 : null;
      const m = px == null ? null : levMark(pos, px);
      if (m) { levEquity += m.equity; levMargin += pos.margin; levUnreal += m.unreal; }
      const dropPct = px != null ? ((px / pos.entry - 1) * 100) : null;
      const toLiq = px != null ? ((px - liqPriceLong(pos.entry, pos.leverage)) / px * 100) : null;
      const flashClsL = li.flash === "up" ? " tick-up" : li.flash === "down" ? " tick-down" : "";
      lb.append(el("tr", { class: "cardish" + flashClsL, "data-lev": id },
        el("td", { "data-label": "幣" }, el("b", { text: "$" + pos.symbol }), " ", el("span", { class: "pill" }, "long"), " ", srcBadge(pos.chain, pos.pair, li),
          toLiq != null ? el("div", { class: "dist" + (toLiq < 5 ? " hot" : ""), text: `距爆倉 ${toLiq.toFixed(1)}%` }) : ""),
        el("td", { class: "num", "data-label": "倍數", text: pos.leverage + "x" }),
        el("td", { class: "num", "data-label": "保證金", text: money2(pos.margin) }),
        el("td", { class: "num", "data-label": "名義", text: money2(pos.notional) }),
        el("td", { class: "num", "data-label": "入場", text: price(pos.entry) }),
        el("td", { class: "num live-px", "data-label": "標記", text: px == null ? "…" : price(px) }),
        el("td", { class: "num neg", "data-label": "爆倉價", text: price(liqPriceLong(pos.entry, pos.leverage)) }),
        el("td", { class: "num " + cls(m?.unreal), "data-label": "浮盈虧", text: m ? `${money2(m.unreal)} (${dropPct == null ? "" : pct(dropPct * pos.leverage)})` : "…" }),
        el("td", { class: "num " + cls(m?.equity - pos.margin), "data-label": "倉權益", text: m ? money2(m.equity) : "…" }),
        el("td", { "data-label": "", class: "actions" }, el("button", { class: "cta", onclick: () => closeLev(id) }, "平倉"))));
    }
    $("levEmpty").hidden = levEntries2.length > 0;

    // Total equity = cash + spot value + lev position equity (margin already out of cash, counted in lev equity)
    const equity = P.cash + spotValue + levEquity;
    if (equity > (P.equityPeak || P.start)) { P.equityPeak = equity; pf.save(P); }
    const dd = P.equityPeak ? (equity / P.equityPeak - 1) * 100 : 0;
    const unrealSpot = spotValue - spotCost;
    const total = equity - P.start, totalPct = (total / P.start) * 100;
    let solRet = null;
    if (P.solAtFirstBuy) {
      const sl = liveInfo(P.solAtFirstBuy.chain, P.solAtFirstBuy.pair);
      if (sl.state === "live") solRet = (sl.price / P.solAtFirstBuy.price - 1) * 100;
    }
    const st = $("pfStats"); st.textContent = "";
    const stat = (k, v, s, c = "") => el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v " + c, text: v }), s ? el("div", { class: "s", text: s }) : "");
    renderAllinChrome(spotValue, levEquity);
    const simpleSt = $("simplePfStats");
    if (simpleSt) {
      simpleSt.textContent = "";
      const spotN = Object.keys(P.positions).length, levN = Object.keys(P.levPositions).length;
      const sstat = (k, v, s, c = "") => el("div", { class: "stat" }, el("div", { class: "k", text: k }), el("div", { class: "v " + c, text: v }), s ? el("div", { class: "s", text: s }) : "");
      simpleSt.append(
        sstat("總資產", money2(equity), `起始 ${money2(P.start)}`),
        sstat("總回報", pct(totalPct), money2(total), cls(total)),
        sstat("持倉", String(spotN + levN), `現貨 ${spotN} · 槓桿 ${levN}`),
        sstat("現金", money2(P.cash)));
      const mini = $("simplePfMini");
      if (mini) {
        mini.textContent = "";
        mini.append(el("a", { href: "#portfolio", class: "simple-pf-link", text: `模擬倉 ${money2(equity)} · 回報 ${pct(totalPct)} →` }));
      }
    }
    st.append(
      stat("總資產", money2(equity), `起始 ${money2(P.start)}`),
      stat("總回報", `${money2(total)} (${pct(totalPct)})`, P.firstBuyAt ? `由 ${localTime(P.firstBuyAt)}` : "未開倉", cls(total)),
      stat("現金", money2(P.cash)),
      stat("現貨市值", money2(spotValue), `浮盈虧 ${money2(unrealSpot)}`, cls(unrealSpot)),
      stat("槓桿倉權益", money2(levEquity), `保證金 ${money2(levMargin)} · 浮 ${money2(levUnreal)}`, cls(levUnreal)),
      stat("現貨已實現", money2(P.realizedSpot || 0), "", cls(P.realizedSpot)),
      stat("槓桿已實現", money2(P.realizedLev || 0), `爆倉 ${P.liquidations || 0} 次`, cls(P.realizedLev)),
      stat("最大回撤", pct(dd), `峰值 ${money2(P.equityPeak || P.start)}`, cls(dd)),
      stat("同期 SOL", solRet == null ? "–" : pct(solRet), P.solAtFirstBuy ? `基準 $${P.solAtFirstBuy.price.toFixed(2)}` : "第一次落倉鎖定", cls(solRet)),
      stat("跑贏 SOL", solRet == null ? "–" : (totalPct - solRet > 0 ? "+" : "") + (totalPct - solRet).toFixed(1) + " pts", "總回報 − SOL", cls(solRet == null ? 0 : totalPct - solRet)));

    const tb = $("tradeBody"); tb.textContent = "";
    const sideZh = { BUY: "現貨買", SELL: "現貨賣", "WRITE-OFF": "銷帳", OPEN: "開槓桿", CLOSE: "平槓桿", LIQUIDATE: "💥爆倉" };
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
        if (liveRenderBusy) return;
        const view = (location.hash || "").slice(1);
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
      p.style.background = ["#fbbf24", "#c084fc", "#34d399", "#f472b6", "#60a5fa"][i % 5];
      p.style.animationDelay = (Math.random() * 0.15) + "s";
      host.append(p);
    }
  }
  function playOverlay({ emoji, title, sub, coin, kind = "", ms = 1500 } = {}) {
    return new Promise((resolve) => {
      const box = $("allinFx"); if (!box) return resolve();
      box.className = "fx-overlay" + (kind ? " " + kind : "");
      $("allinFxEmoji").textContent = emoji || "🎰";
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

  function toast(msg) {
    const t = el("div", { class: "toast pop", text: msg, style: "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#1e293b;border:1px solid #334155;padding:10px 16px;border-radius:10px;z-index:50;max-width:90%" });
    document.body.append(t); setTimeout(() => t.remove(), 3500);
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
      location.hash = "explore";
      setTimeout(() => {
        if ($("minLiq")) $("minLiq").value = "50000";
        if ($("hideRisky")) { $("hideRisky").checked = false; }
        toast("短線模式：去市場掃描，留意 📈 急升同 💧 低流動性旗標");
      }, 200);
    } else if (lens === "careful") {
      location.hash = "picks";
      toast("謹慎模式：只跟 AI 買入推薦，撳「落倉」或「跟晒今批」");
    } else if (lens === "research") {
      location.hash = "news";
      toast("研究模式：先睇重點新聞同避過清單");
    } else if (lens === "lev") {
      location.hash = "portfolio";
      pfMode = "lev";
      const el = document.getElementById("lens-lev");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("槓桿模式：可開到 50x。假錢儘管試；建議由 5–10x 起跳");
      setTimeout(() => renderPortfolio(true), 200);
    } else if (lens === "allin") {
      setRisk("allin");
      location.hash = "portfolio";
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
    for (const v of ["explore", "picks", "browse", "portfolio", "news", "more"]) {
      const node = $("view-" + v); if (node) node.hidden = v !== view;
    }
    document.querySelectorAll(".tab").forEach((a) => {
      const on = a.dataset.view === view;
      if (on && !a.classList.contains("active")) coinPopEl(a);
      a.classList.toggle("active", on);
    });
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
  }
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
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
  if ($("allinFromPicks")) $("allinFromPicks").addEventListener("click", () => openAllinFlow());
  if ($("allinCloseBtn")) $("allinCloseBtn").addEventListener("click", () => closeAllinFromBanner());
  if ($("allinAgain")) $("allinAgain").addEventListener("click", () => againAllin());
  $("pfRefresh").addEventListener("click", async () => {
    const ps = [
      ...Object.values(P.positions).map((p) => ({ chain: p.chain, pair: p.pair })),
      ...Object.values(P.levPositions).map((p) => ({ chain: p.chain, pair: p.pair })),
    ];
    if (P.solAtFirstBuy) ps.push({ chain: P.solAtFirstBuy.chain, pair: P.solAtFirstBuy.pair });
    if (ps.length) await fetchPairs(ps, true);
    renderPortfolio(false);
  });
  $("copyPicks").addEventListener("click", copyPicks);
  $("pfReset").addEventListener("click", () => {
    const start = parseFloat($("startCash").value) || START_CASH;
    if (confirm(`重置模擬倉到 $${start.toLocaleString()}，並清空現貨＋槓桿＋孤注一擲？`)) {
      const fee = P.feePct; P = pf.fresh(start); P.feePct = fee; pf.save(P);
      if ($("allinResult")) $("allinResult").hidden = true;
      if ($("allinBanner")) $("allinBanner").hidden = true;
      renderPortfolio(false);
    }
  });
  $("feePct").addEventListener("change", () => { const v = parseFloat($("feePct").value); P.feePct = isFinite(v) ? Math.max(0, Math.min(20, v)) : 1; pf.save(P); });
  // Expose helpers for headless tests
  window.MCE.paper = {
    openBuy, openSell, copyPicks, state: () => P,
    doOpenLev, doBuySpot, closeLev, checkLiquidations, liqPriceLong, levMark,
    LIQ_MARGIN_FRAC, setState(s) { P = s; pf.save(P); },
    openAllinFlow, executeAllin, allinActive, loadAllinRounds, endAllinRound, playOverlay, reduceMotion,
    ingestPair, ensureLiveLoop, renderPortfolio,
  };
  window.MCE.onBrowseLoaded = () => {};
  window.MCE.onBnBoardLoaded = (rows) => {
    if (window.MCE.live && window.MCE.live.scoreBoardRows) renderHotBuysFromBn(window.MCE.live.scoreBoardRows(rows));
  };
  if ($("livePicksRefresh")) $("livePicksRefresh").addEventListener("click", () => loadLiveBnPicks(true));
  // Kick live BN picks ASAP for home
  loadLiveBnPicks(false);

  // 預設落地：簡單模式 + #picks
  if (!location.hash) location.replace("#picks");
  else show(location.hash.slice(1));
  window.MCE.ui = { applyUiMode, get mode() { return uiMode; } };
})();
