/** Local QA: diversifySetups must yield ≥3 distinct angles; Pass 3 must soft-skip MEGA. */
function diversifySetups(scored, n = 6) {
  const ANGLE_ORDER = ["accumulation", "rotation", "compression", "mean_reversion", "higher_lows", "relative"];
  const SOFT = 2;
  const MEGA = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]);
  const setups = scored.filter((s) => !s.alreadyUp && !s.extended && s.setupScore >= 26 && !MEGA.has(s.symbol))
    .sort((a, b) => b.setupScore - a.setupScore);
  const out = [];
  const used = new Set();
  const usedAngle = new Map();
  const angN = (a) => usedAngle.get(a) || 0;
  const add = (s) => { out.push(s); used.add(s.symbol); usedAngle.set(s.angle, angN(s.angle) + 1); };
  for (const ang of ANGLE_ORDER) {
    if (out.length >= n) break;
    const s = setups.find((x) => !used.has(x.symbol) && x.angle === ang);
    if (s) add(s);
  }
  while (out.length < n) {
    let next = setups.find((x) => !used.has(x.symbol) && angN(x.angle) === 0);
    if (!next) next = setups.find((x) => !used.has(x.symbol) && angN(x.angle) < SOFT);
    if (!next) break;
    add(next);
  }
  if (out.length < n) {
    const relaxed = scored.filter((s) => (s.chg24 || 0) < 8 && !MEGA.has(s.symbol)).sort((a, b) => b.setupScore - a.setupScore);
    for (const s of relaxed) {
      if (out.length >= n) break;
      if (used.has(s.symbol) || angN(s.angle) >= SOFT) continue;
      add(s);
    }
  }
  return out.slice(0, n);
}

// Synthetic board: many compression + higher_lows (old bug case), plus other angles weaker
const angles = ["compression", "higher_lows", "accumulation", "rotation", "mean_reversion", "relative"];
const scored = [];
for (const ang of angles) {
  const n = ang === "compression" ? 8 : ang === "higher_lows" ? 6 : 3;
  for (let k = 0; k < n; k++) {
    scored.push({
      symbol: `${ang.toUpperCase()}${k}USDT`,
      base: `${ang}${k}`,
      angle: ang,
      setupScore: (ang === "compression" ? 90 : ang === "higher_lows" ? 85 : 70) - k,
      alreadyUp: false,
      extended: false,
      chg24: 1 + k * 0.1,
    });
  }
}

const picks = diversifySetups(scored, 6);
const counts = {};
for (const p of picks) counts[p.angle] = (counts[p.angle] || 0) + 1;
const distinct = Object.keys(counts).length;
const maxPer = Math.max(...Object.values(counts));
console.log("picks", picks.map((p) => p.base + ":" + p.angle).join(", "));
console.log("counts", counts, "distinct", distinct, "maxPer", maxPer);

if (picks.length !== 6) throw new Error("expected 6 picks, got " + picks.length);
if (distinct < 3) throw new Error("expected ≥3 distinct angles, got " + distinct);
if (maxPer > 2) throw new Error("angle cap broken: max " + maxPer);
if ((counts.compression || 0) >= 3) throw new Error("too many compression");

// Pass 3 MEGA leak: only 2 weak non-mega setups so fill would pull SOL/BTC without MEGA filter
const lean = [
  { symbol: "AAAUSDT", base: "AAA", angle: "accumulation", setupScore: 40, alreadyUp: false, extended: false, chg24: 1 },
  { symbol: "BBBUSDT", base: "BBB", angle: "rotation", setupScore: 39, alreadyUp: false, extended: false, chg24: 1 },
  { symbol: "SOLUSDT", base: "SOL", angle: "compression", setupScore: 99, alreadyUp: false, extended: false, chg24: 1 },
  { symbol: "BTCUSDT", base: "BTC", angle: "mean_reversion", setupScore: 98, alreadyUp: false, extended: false, chg24: 1 },
  { symbol: "ETHUSDT", base: "ETH", angle: "higher_lows", setupScore: 97, alreadyUp: false, extended: false, chg24: 1 },
  { symbol: "BNBUSDT", base: "BNB", angle: "relative", setupScore: 96, alreadyUp: false, extended: false, chg24: 1 },
];
const leanPicks = diversifySetups(lean, 6);
const leanSyms = leanPicks.map((p) => p.symbol);
console.log("lean picks", leanSyms.join(", "));
for (const m of ["SOLUSDT", "BTCUSDT", "ETHUSDT", "BNBUSDT"]) {
  if (leanSyms.includes(m)) throw new Error("MEGA leaked via Pass 3: " + m);
}
if (!leanSyms.includes("AAAUSDT") || !leanSyms.includes("BBBUSDT")) throw new Error("expected non-mega kept");

console.log("PASS diversify + MEGA soft-skip");
