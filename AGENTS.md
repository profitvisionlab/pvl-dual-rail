# Agent 契約 · pvl-dual-rail

> **最高層契約在 [`_ops/AGENTS.md`](../_ops/AGENTS.md) —— 本檔不得放寬其中任何一條。**
> 跨 repo 現況板：[`_ops/BOARD.md`](../_ops/BOARD.md)
> 事業線：② PVL.AI 集團（Visable.ai）

## 部署級別：🟢 B 級

**`git push` = 純檔案備份，不觸發任何部署。**

Agent 可在工作完成後自行推送。但**發布文章 / 寫入 CMS / 社群派發仍需當下授權** ——
部署級別只管 git，不管內容發布。

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
