# Agent 契約 · pvl-dual-rail

> **最高層契約在 [`_ops/AGENTS.md`](../_ops/AGENTS.md) —— 本檔不得放寬其中任何一條。**
> 跨 repo 現況板：[`_ops/BOARD.md`](../_ops/BOARD.md)
> 事業線：② PVL.AI 集團（Visable.ai）

## 部署級別：🟢 B 級

**`git push` = 純檔案備份，不觸發任何部署。**

Agent 可在工作完成後自行推送。但**發布文章 / 寫入 CMS / 社群派發仍需當下授權** ——
部署級別只管 git，不管內容發布。

## 品牌色（全站統一，不是本 repo 自己的事）

改主色／底色／色階前先對這張表。不一致就是要先討論，不是先改。

| Ocean Blue 主色 | Deep Ocean 深背景 | Ink Blue 標題 | Soft Blue 淡底 | 品牌金 | 青綠 | 珊瑚 |
|---|---|---|---|---|---|---|
| `#256FA8` | `#1D5D8F` | `#17496F` | `#E7F1F9` | `#EF9F27` | `#1D9E75` | `#D85A30` |

⚠️ **深藍當底色是踩過的坑**：舊深藍 `#2D3F5E` 在部分筆電與手機上會顯示成**近黑色**，
主色因此改用 Ocean Blue 系列。這是依**實機表現**做的決定 ——
色彩空間裡算得再漂亮（對比比值、CVD ΔE 全 PASS）都不能推翻「看起來是黑的」。
比 `#2D3F5E` 更暗的底（`#102A40`、`#001324`…）只會更嚴重。
要用深色主題需 Ben 當下同意，並在下方手寫區記錄原因。

詳見 [`_ops/AGENTS.md`](../_ops/AGENTS.md) §三之二。

## 開場自檢

```bash
cat ~/Developer/_ops/BOARD.md                              # 整體卡在哪
gh issue list --repo sharemo168-hub/$(basename $(git remote get-url origin) .git) --state open
```

## 交接：用 issue，不要開 HANDOFF 檔

```bash
gh issue create --repo sharemo168-hub/$(basename $(git remote get-url origin) .git) \
  --title "..." --label "agent:codex"
```

<!-- ==== 以下為手寫區：sync-agents.js 不會覆蓋 ==== -->

## 本 repo 專屬補充

（這一區手寫，重跑不會被蓋掉）
