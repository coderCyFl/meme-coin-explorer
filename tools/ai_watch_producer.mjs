#!/usr/bin/env node
/**
 * AI Watch B — secure X + Grok producer (GitHub Actions only).
 * Node 18+ built-in fetch; no packages. Secrets from env only — never commit keys.
 *
 *   node tools/ai_watch_producer.mjs --fixtures tests/fixtures/ai_watch_fixture.json
 *   node tools/ai_watch_producer.mjs --dry-cap   # show cap state, no network
 *   node tools/ai_watch_producer.mjs             # live (needs X_BEARER_TOKEN + XAI_API_KEY)
 *
 * Writes data/ai_watch.json atomically; archives prior to data/ai_watch_history/.
 * Enforces daily_cap=300 (Asia/Hong_Kong / Shanghai UTC+8 midnight reset).
 * Schedule activation is owned by the workflow (cron stays OFF until PM turns it on).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, appendFileSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "ai_watch.json");
const HIST_DIR = join(ROOT, "data", "ai_watch_history");
const CALLS = join(HIST_DIR, "calls.jsonl");
const TARGETS = join(ROOT, "data", "ai_targets.json");

export const DAILY_CAP = 300;
export const TZ_OFFSET_H = 8; // HKT / Asia/Shanghai
export const SCHEMA_VERSION = 1;
const X_SEARCH = "https://api.x.com/2/tweets/search/recent";
const X_COUNTS = "https://api.x.com/2/tweets/counts/recent";
const XAI_CHAT = "https://api.x.ai/v1/chat/completions";
const GROK_MODEL = "grok-2-latest";
const MAX_TARGETS_PER_RUN = 10;
const MAX_POSTS = 3;
const CALLS_KEEP_DAYS = 14;
const VERDICTS = new Set(["熱", "升溫", "冷"]);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1] ?? "true"]] : a), []),
);

function hktNow(d = new Date()) {
  return new Date(d.getTime() + TZ_OFFSET_H * 3600_000);
}
export function hktDate(d = new Date()) {
  return hktNow(d).toISOString().slice(0, 10);
}
export function isoHkt(d = new Date()) {
  const t = hktNow(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`;
}

export function emptyDoc(day = hktDate()) {
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: isoHkt(),
    source: {
      producer: "tools/ai_watch_producer.mjs",
      targets: "data/ai_targets.json",
      x: "api.x.com",
      grok: "api.x.ai",
      note: "Site reads same-origin JSON only; 0 client secrets / 0 browser X|Grok calls.",
    },
    cap: {
      date: day,
      daily_cap: DAILY_CAP,
      calls_today: 0,
      cap_reached: false,
      reset: "HKT midnight (UTC+8)",
    },
    entries: [],
    skipped: [],
    run: { id: null, mode: null, targets_considered: 0, x_calls: 0, grok_calls: 0 },
  };
}

export function loadCalls(path = CALLS) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

export function callsOnDay(log, day) {
  let n = 0;
  for (const row of log) {
    try {
      const ts = String(row.ts || "");
      const dayPart = ts.includes("+08:00") || ts.includes("+08")
        ? ts.slice(0, 10)
        : hktDate(new Date(ts));
      if (dayPart === day) n += 1;
    } catch {
      /* ignore */
    }
  }
  return n;
}

/** Pure: remaining budget for day. Never negative. */
export function remainingCap(callsToday, dailyCap = DAILY_CAP) {
  return Math.max(0, dailyCap - callsToday);
}

export function assertNoClientSecrets(root = ROOT) {
  const banned = [/X_BEARER_TOKEN\s*=\s*['"][^'"]+['"]/, /XAI_API_KEY\s*=\s*['"][^'"]+['"]/, /Bearer\s+[A-Za-z0-9\-_]{20,}/];
  const scan = ["js/app.js", "js/data.js", "js/i18n.js", "js/strategy.js", "index.html"];
  for (const rel of scan) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, "utf8");
    for (const re of banned) {
      if (re.test(txt)) throw new Error(`client secret pattern in ${rel}`);
    }
  }
}

function atomicWriteJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function archivePrevious(outPath = OUT, histDir = HIST_DIR) {
  mkdirSync(histDir, { recursive: true });
  if (!existsSync(outPath)) return null;
  let prev;
  try {
    prev = JSON.parse(readFileSync(outPath, "utf8"));
  } catch {
    return null;
  }
  if (!prev || !prev.updated_at) return null;
  const stamp = String(prev.updated_at).replace(/[:+]/g, (c) => (c === ":" ? "" : c === "+" ? "p" : "-"));
  const dest = join(histDir, `${stamp}.json`);
  if (!existsSync(dest)) copyFileSync(outPath, dest);
  return dest;
}

function pruneCalls(log, keepDays = CALLS_KEEP_DAYS, now = new Date()) {
  const cutoff = hktNow(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  const cutDay = cutoff.toISOString().slice(0, 10);
  return log.filter((row) => {
    try {
      const day = String(row.ts || "").slice(0, 10);
      return day >= cutDay;
    } catch {
      return false;
    }
  });
}

function rewriteCalls(rows, path = CALLS) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  renameSync(tmp, path);
}

function appendCall(row, path = CALLS) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
}

function loadTargets(path = TARGETS) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  return entries.map((e) => ({
    symbol: e.symbol,
    base: e.base || String(e.symbol || "").replace(/USDT$/, ""),
    reason: Array.isArray(e.reason) ? e.reason.slice() : [],
    score: e.score ?? null,
    change_24h: e.change_24h ?? null,
    volume_24h: e.volume_24h ?? null,
  }));
}

function cashtagQuery(base) {
  const b = String(base).replace(/[^\w\u4e00-\u9fff]/g, "");
  return `($${b} OR #${b}) (crypto OR binance OR memecoin OR usdt) -is:retweet`;
}

async function xGet(url, token) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`X ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function grokChat(apiKey, prompt) {
  const r = await fetch(XAI_CHAT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      temperature: 0.2,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content:
            "You score crypto X buzz for a paper-trading watchlist. Reply JSON only: {\"verdict\":\"熱|升溫|冷\",\"one_line\":\"≤20 chars Cantonese or EN\",\"tone\":\"bullish|neutral|cautious\",\"summary\":\"≤140 chars\"}. No keys, no URLs inventing.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Grok ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

function parseGrokContent(raw) {
  const text = raw?.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { verdict: "冷", one_line: "無明確訊號", tone: "neutral", summary: text.slice(0, 140) };
  try {
    const j = JSON.parse(m[0]);
    const verdict = VERDICTS.has(j.verdict) ? j.verdict : "冷";
    return {
      verdict,
      one_line: String(j.one_line || "").slice(0, 20),
      tone: ["bullish", "neutral", "cautious"].includes(j.tone) ? j.tone : "neutral",
      summary: String(j.summary || "").slice(0, 140),
    };
  } catch {
    return { verdict: "冷", one_line: "解析失敗", tone: "neutral", summary: text.slice(0, 140) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Merge fixture rows into schema (offline). */
export function buildFromFixture(fixture, { day = hktDate(), callsToday = 0 } = {}) {
  const doc = emptyDoc(day);
  doc.run = {
    id: fixture.run_id || "fixture",
    mode: "fixtures",
    targets_considered: (fixture.entries || []).length,
    x_calls: fixture.x_calls || 0,
    grok_calls: fixture.grok_calls || 0,
  };
  const used = (fixture.x_calls || 0) + (fixture.grok_calls || 0);
  doc.cap.calls_today = callsToday + used;
  doc.cap.cap_reached = doc.cap.calls_today >= DAILY_CAP;
  doc.entries = (fixture.entries || []).map((e) => ({
    symbol: e.symbol,
    base: e.base || String(e.symbol).replace(/USDT$/, ""),
    reason: e.reason || [],
    x: e.x || null,
    grok: e.grok || null,
  }));
  doc.skipped = fixture.skipped || [];
  doc.updated_at = isoHkt();
  return doc;
}

async function runLive({ token, xaiKey, day, callsToday, budget }) {
  const doc = emptyDoc(day);
  doc.run.id = randomUUID().slice(0, 8);
  doc.run.mode = "live";
  const targets = loadTargets().slice(0, MAX_TARGETS_PER_RUN);
  doc.run.targets_considered = targets.length;
  let spent = 0;
  const logRows = [];

  const spend = (n, row) => {
    if (spent + n > budget) return false;
    spent += n;
    logRows.push(row);
    return true;
  };

  for (const t of targets) {
    const left = budget - spent;
    if (left < 2) {
      doc.skipped.push({ symbol: t.symbol, reason: "daily_cap" });
      doc.cap.cap_reached = true;
      break;
    }
    const q = cashtagQuery(t.base);
    const start = new Date(Date.now() - 6 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    let counts = null;
    let search = null;
    try {
      if (!spend(1, { ts: isoHkt(), symbol: t.symbol, tool: "x_counts", query: q })) break;
      const countUrl = `${X_COUNTS}?${new URLSearchParams({ query: q, granularity: "hour", start_time: start })}`;
      counts = await xGet(countUrl, token);
      doc.run.x_calls += 1;
      await sleep(1200);
      if (!spend(1, { ts: isoHkt(), symbol: t.symbol, tool: "x_search", query: q })) break;
      const searchUrl = `${X_SEARCH}?${new URLSearchParams({
        query: q,
        max_results: "10",
        "tweet.fields": "created_at,public_metrics,author_id,lang",
        expansions: "author_id",
        "user.fields": "username,public_metrics",
      })}`;
      search = await xGet(searchUrl, token);
      doc.run.x_calls += 1;
      await sleep(1200);
    } catch (err) {
      doc.skipped.push({ symbol: t.symbol, reason: `x_error:${String(err.message || err).slice(0, 80)}` });
      continue;
    }

    const series = counts?.data || [];
    const last1 = series.length ? Number(series[series.length - 1]?.tweet_count || 0) : 0;
    const prev = series.slice(0, -1);
    const prevAvg = prev.length ? prev.reduce((a, b) => a + Number(b.tweet_count || 0), 0) / prev.length : 0;
    const spike = prevAvg > 0 ? last1 / prevAvg : last1 > 0 ? last1 : 0;
    const users = Object.fromEntries((search?.includes?.users || []).map((u) => [u.id, u]));
    const posts = (search?.data || []).slice(0, MAX_POSTS).map((p) => {
      const u = users[p.author_id] || {};
      const user = u.username || "unknown";
      return {
        id: p.id,
        url: `https://x.com/${user}/status/${p.id}`,
        text: String(p.text || "").slice(0, 140),
        likes: p.public_metrics?.like_count ?? 0,
        author_username: user,
        author_followers: u.public_metrics?.followers_count ?? 0,
        created_at: p.created_at || null,
      };
    });
    const big = posts.filter((p) => (p.author_followers || 0) >= 100_000).length;
    const shill = posts.length >= 2 && posts.every((p) => (p.author_followers || 0) < 500);

    let grok = null;
    if (xaiKey && budget - spent >= 1) {
      const prompt = JSON.stringify({
        symbol: t.symbol,
        reason: t.reason,
        posts_last_1h: last1,
        posts_prev_avg_per_h: Math.round(prevAvg * 100) / 100,
        spike_ratio: Math.round(spike * 100) / 100,
        top_posts: posts.map((p) => p.text),
      });
      try {
        if (spend(1, { ts: isoHkt(), symbol: t.symbol, tool: "grok_chat", query: "watchlist" })) {
          const raw = await grokChat(xaiKey, prompt);
          grok = { ...parseGrokContent(raw), model: GROK_MODEL, checked_at: isoHkt() };
          doc.run.grok_calls += 1;
          await sleep(400);
        }
      } catch (err) {
        doc.skipped.push({ symbol: t.symbol, reason: `grok_error:${String(err.message || err).slice(0, 80)}` });
      }
    }

    const verdict = grok?.verdict || (spike >= 3 && last1 >= 5 ? "熱" : spike >= 1.5 ? "升溫" : "冷");
    doc.entries.push({
      symbol: t.symbol,
      base: t.base,
      reason: t.reason,
      x: {
        checked_at: isoHkt(),
        posts_last_1h: last1,
        posts_prev_6h_avg_per_h: Math.round(prevAvg * 100) / 100,
        spike_ratio: Math.round(spike * 100) / 100,
        verdict,
        one_line: grok?.one_line || (verdict === "熱" ? "討論急升" : verdict === "升溫" ? "討論回暖" : "討論偏冷"),
        shill_flag: shill,
        big_accounts: big,
        top_posts: posts,
      },
      grok,
    });
  }

  doc.cap.calls_today = callsToday + spent;
  doc.cap.cap_reached = doc.cap.calls_today >= DAILY_CAP || doc.skipped.some((s) => s.reason === "daily_cap");
  doc.updated_at = isoHkt();
  return { doc, logRows };
}

async function main() {
  assertNoClientSecrets();
  mkdirSync(HIST_DIR, { recursive: true });
  const day = hktDate();
  const log = loadCalls();
  const callsToday = callsOnDay(log, day);
  const budget = remainingCap(callsToday);

  if (args["dry-cap"] === "true" || args["dry-cap"] === "") {
    const doc = emptyDoc(day);
    doc.cap.calls_today = callsToday;
    doc.cap.cap_reached = budget <= 0;
    doc.run.mode = "dry-cap";
    console.log(JSON.stringify(doc.cap, null, 2));
    return;
  }

  if (args.fixtures) {
    const fixture = JSON.parse(readFileSync(resolve(args.fixtures), "utf8"));
    const doc = buildFromFixture(fixture, { day, callsToday });
    if (doc.cap.calls_today > DAILY_CAP) {
      console.error(`KILL: fixture would exceed daily_cap=${DAILY_CAP}`);
      process.exit(2);
    }
    archivePrevious();
    atomicWriteJson(OUT, doc);
    const used = (fixture.x_calls || 0) + (fixture.grok_calls || 0);
    for (let i = 0; i < used; i++) {
      appendCall({ ts: isoHkt(), symbol: fixture.entries?.[0]?.symbol || "FIXTURE", tool: "fixture", query: "fixture" });
    }
    rewriteCalls(pruneCalls(loadCalls()));
    console.log(`fixtures → ${OUT} entries=${doc.entries.length} calls_today=${doc.cap.calls_today}`);
    return;
  }

  if (budget <= 0) {
    const doc = emptyDoc(day);
    doc.cap.calls_today = callsToday;
    doc.cap.cap_reached = true;
    doc.run.mode = "cap_block";
    doc.skipped = [{ symbol: "*", reason: "daily_cap" }];
    archivePrevious();
    atomicWriteJson(OUT, doc);
    console.log(`cap reached (${callsToday}/${DAILY_CAP}) — wrote cap state, no API calls`);
    return;
  }

  const token = process.env.X_BEARER_TOKEN;
  const xaiKey = process.env.XAI_API_KEY;
  if (!token || !xaiKey) {
    console.error("KILL: live mode needs X_BEARER_TOKEN and XAI_API_KEY in Actions secrets (never commit).");
    process.exit(2);
  }
  // Refuse if secrets accidentally look like placeholders committed nearby
  if (token.length < 20 || xaiKey.length < 20) {
    console.error("KILL: secret too short");
    process.exit(2);
  }

  const { doc, logRows } = await runLive({ token, xaiKey, day, callsToday, budget });
  archivePrevious();
  atomicWriteJson(OUT, doc);
  for (const row of logRows) appendCall(row);
  rewriteCalls(pruneCalls(loadCalls()));
  console.log(
    `live → ${OUT} entries=${doc.entries.length} x=${doc.run.x_calls} grok=${doc.run.grok_calls} calls_today=${doc.cap.calls_today}/${DAILY_CAP}`,
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
