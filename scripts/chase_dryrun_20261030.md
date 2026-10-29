# 🚀 續升買 (chase) dry-run — 2026-10-25 .. 2026-10-29 (Asia/Shanghai)

Branch `chase-calls-20261030` · script `scripts/dryrun_chase.py` · raw `/workspace/chase-dryrun-20261030.json`
Generated 2026-10-30 ~03:30 HKT.

## Rule (Strategy BOT final, = `gainer_core.chase_ok`)
- 24h change +10% .. +30% · price within 5% of 24h high · 1h quote vol ≥ 2x prior-24h hourly avg · 1h candle up (close > open)
- 24h quote vol ≥ $1.5M; < $3M = 細盤 (bonus size 1.5x)
- Exit: TP +20% (half) / +50% (clear) / SL −10% / sell_by 24h

## Method
- Universe: 395 Binance USDT spot (stables, tokenized stocks, leveraged tokens excluded); 0 fetch failures.
- Signals on CLOSED 1h bars (entry = that bar's close). One entry per symbol per 24h.
- Exits on 5m bars for 24h after entry; stop checked first if a 5m bar touches both.
- **A = seal model** (what exit-aware `outcomes.json` sealing measures: single TP +20% / SL −10% / close at 24h).
- **B = ladder**: half at +20% then stop on the rest → entry, rest at +50% or 24h close.
- No fees (add ≈ −0.2% per round trip).

## Result (35 signals with a full 24h; 4 more still open)
| | n | TP +20% first | SL −10% first | 24h close | W / L | EW per trade | per $100 |
|---|---|---|---|---|---|---|---|
| A seal | 35 | 3 (8.6%) | 11 (31%) | 21 | 9 / 25 (1 flat) | **−2.32%** | **−$2.32** (−$81 on $3,500) |
| B ladder | 35 | — | — | — | 9 / 25 | −2.55% | −$2.55 |
| A, 細盤 1.5x sized | 35 | | | | | −2.01% | −$90 on $4,500 |
| incl. 4 open (MTM) | 39 | 3 | 12 | | 10 / 28 | −2.39% | |

- **Hit rate of +20% before −10%: 3 / 14 resolved (21%); 3 / 35 overall (8.6%).** No signal touched +50%.
- By leg: main (≥ $3M) n=15 **−4.21%** (0 TP, 6 SL); 細盤 n=20 **−0.91%** (3 TP, 5 SL).
- Per day signals: 10-25 4 · 10-26 10 · 10-27 10 · 10-28 10 · 10-29 4 (+1 closing 10-30 00:00).

**Verdict: as specified, 🚀 loses on this window (EW −2.3%/trade).** It's still better than daily follow-buys (−4.3% exit-aware), but it is not green.

## Slices (in-sample, small n: treat as hypotheses, not rules)
| slice | n | W/L | TP/SL | EW A |
|---|---|---|---|---|
| from-high ≥ −2% | 15 | 7/7 | 1/0 | **+1.56%** |
| from-high < −2% | 20 | 2/18 | 2/11 | −5.24% |
| 24h ≥ +15% | 11 | 4/7 | 2/4 | +0.32% |
| 24h < +15% | 24 | 5/18 | 1/7 | −3.54% |
| vol ≥ 5x | 20 | 4/15 | 1/6 | −3.70% |

The clearest split is distance from the 24h high. Coins 2–5% below the high mostly kept fading (2/18 W/L). Tightening to ≤ 2% off the high is the obvious next test, but it needs an out-of-sample window before Strategy adopts it.

## All signals (close time HKT · c24 · fh · vr · 1h% · A · B)
See the JSON file. Notable: HAEDAL 10-27 20:00 +20% half → max +40%; INIT 10-28 01:00 max +48.5%; DODO 10-26 TP then back to entry.
