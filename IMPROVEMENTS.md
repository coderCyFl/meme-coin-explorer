# Product backlog（交易者視角）

優先級：P0 = 影響誠實追蹤／成本，P1 = 體驗，P2 = 錦上添花。  
原則：靜態站 + DexScreener 免費 + X 只做離線快照。唔加付費 API。

## P0（仍未做）
- [ ] 定時有人／GHA 跑通後，確認 outcomes 真係寫入（而家 workflow 已備好）
- [ ] 新 batch 揀幣時自動寫 `data/raw/batch-NNN/`（仍靠 agent／人手）
- [ ] 模擬倉「等權開倉 vs SOL」圖表

## Done recently
- [x] **簡單／完整**介面（預設簡單，減資訊過載）
- [x] 新聞 `fetched_at` 年齡 + 「可能過時」>48h
- [x] 落倉衝擊估算（vs 流動性）+ 1% fee
- [x] Scorecard 樣本太少提示；horizon「尚未到期／待快照」
- [x] Boosted 候選偏誤提示
- [x] `snapshot_outcomes.py` + `.github/workflows/daily.yml`（只 DexScreener）
- [x] 孤注一擲 + 動畫 + 現貨／槓桿／風險檔／手機底欄

## P1
- [ ] 槓桿：部分平倉、空單、資金費
- [ ] 手機：完整模式表再優化
- [ ] 匯出模擬倉 CSV

## 刻意不做（慳成本）
- 瀏覽器直接 call X／付費資料源
- 自動鏈上交易、錢包連接
- 後端伺服器／資料庫
