# 每日自檢清單（慳成本版）

目標：確認「AI 揀幣 → 模擬落倉 → 真實賺蝕」實驗仍然誠實、可用、唔燒錢。  
預計 10–15 分鐘。X 更新最多 ~15 calls／次。

## 1. Scorecard 誠實度
- [ ] `data/picks.json` 有冇被人手改過舊 entry？（應該只係 append）
- [ ] 跑 `python3 scripts/snapshot_outcomes.py` — 到期嘅 24h/72h/7d 有冇寫入 `data/outcomes.json`？
- [ ] 模擬倉同 AI 推薦價對照：有冇「已死／Rug」卻仲當活盤？
- [ ] 勝率／平均回報樣本數：少過 20 筆就唔好寫結論

## 2. 新聞新鮮度
- [ ] `data/news.json` 嘅 `fetched_at` 係咪 48 小時內？
- [ ] 過期就用 agent `search_news`（≤5 calls）刷新，保留 `data/raw/news-NNN/`
- [ ] 每則有冇「點解重要」？空白就補

## 3. UX 摩擦
- [ ] 預設開唔開到「AI 揀幣」？
- [ ] 「落倉」流程：輸入金額 → 確認 → 跳去模擬倉，有冇 JS error？
- [ ] 「跟晒今批」平均分配係咪正確？
- [ ] 「點樣用」三個角色掣係咪仲 work？

## 4. X／成本
- [ ] 今次有冇超過 ~15 X calls？
- [ ] 網站本身有冇意外 call X？（唔應該；只讀靜態 JSON）
- [ ] DexScreener 只喺瀏覽器、有 3 分鐘 cache？

## 5. Bugs
- [ ] Console 有冇紅色 error？
- [ ] 流動性 < $1k 有冇標成已死？
- [ ] localStorage 重置後起始資金係咪跟你設嘅數？

## 簽收
日期（Asia/Shanghai）：________  
檢查人：________  
備註：________
