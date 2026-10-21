/** Local QA: diversifySetups must yield ≥3 distinct angles for 6 picks; no catch-all same-angle pad. */
function diversifySetups(scored, n = 6) {
  const ANGLE_ORDER = ["accumulation", "rotation", "compression", "mean_reversion", "higher_lows", "relative"];
  const SOFT = 2;
  const setups = scored.filter((s) => !s.alreadyUp && !s.extended && s.setupScore >= 26)
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
    const relaxed = scored.filter((s) => (s.chg24 || 0) < 8).sort((a, b) => b.setupScore - a.setupScore);
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
let i = 0;
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
    i++;
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
// Must not be 3 compression + 2 higher_lows style
if ((counts.compression || 0) >= 3) throw new Error("too many compression");
console.log("PASS diversify");
