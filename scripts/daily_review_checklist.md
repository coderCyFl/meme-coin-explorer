# 每日自檢清單（慳成本版）

目標：確認「AI 揀幣 → 模擬落倉 → 真實賺蝕」實驗仍然誠實、可用、唔燒錢。  
預計 10–15 分鐘。X 更新最多 ~15 calls／次。

## 1. Scorecard 誠實度
- [ ] `data/picks.json` 有冇被人手改過舊 entry？（應該只係 append）
- [ ] 跑 `python3 scripts/snapshot_outcomes.py` — 到期嘅 24h/72h/7d 有冇寫入 `data/outcomes.json`？
- [ ] Binance 盤（`pair_address` 如 `TRUMPUSDT`）係咪用 Binance public REST（`data-api.binance.vision`）而唔係 DexScreener？
- [ ] Crypto.M 同 AI 推薦價對照：有冇「已死／無成交」卻仲當活盤？（CEX：24h quoteVolume < $1k → dead；舊 Solana Dex：流動性 < $1k → dead）
- [ ] 勝率／平均回報樣本數：少過 20 筆就唔好寫結論

## 2. 新聞新鮮度
- [ ] `data/news.json` 嘅 `fetched_at` 係咪 48 小時內？
- [ ] 過期就用 agent `search_news`（≤5 calls）刷新，保留 `data/raw/news-NNN/`
- [ ] 每則有冇「點解重要」？空白就補

## 3. UX 摩擦
- [ ] 預設開唔開到「今日跟買／AI 揀幣」？
- [ ] 「落倉」流程：輸入金額 → 確認 → 跳去 Crypto.M，有冇 JS error？
- [ ] 「跟晒今批」平均分配係咪正確？
- [ ] 「點樣用」三個角色掣係咪仲 work？
- [ ] AI「今日跟買」有冇 majors 漏網（BTC/ETH/SOL/BNB）？跑 `node scripts/qa_diversify.mjs`（Pass 3 都要 soft-skip MEGA）
- [ ] 市況弱閘：BTC 24h < -2% 或綠幣 <30% 時，有冇「市況弱 · 細注／觀望」banner？Live 重算係咪 max 4／半注？
- [ ] 「每日新留意」表：同「今日跟買」卡分開；顯示最新 batch（幣／現價／建議賣／紙上目標／半注全注）
- [ ] 平日 9am upgrade 有冇跑 `node scripts/make_bn_setup_picks.mjs` 出新 batch？（每日至少一批新可買幣）
- [ ] 落倉 modal 「幾時可以放」：有冇「升到約 $X（+Y%）可考慮放現貨」同 hold／止蝕文案？
- [ ] 「幾時可以賣」chip：跟買卡／持倉有冇建議再睇時間 + 紙上 ±%？Reload 後 exit 時間有冇鎖死（唔好重開 24h）？

## 4. X／成本
- [ ] 今次有冇超過 ~15 X calls？
- [ ] 網站本身有冇意外 call X？（唔應該；只讀靜態 JSON）
- [ ] 行情：瀏覽器只用 Binance 公開 REST／stream，有合理 cache？（唔再用 DexScreener meme 熱榜）

## 5. Bugs
- [ ] Console 有冇紅色 error？
- [ ] 無成交／極低量有冇標成已死？
- [ ] localStorage 重置後起始資金係咪跟你設嘅數？

## 簽收
日期（Asia/Shanghai）：________  
檢查人：________  
備註：________
