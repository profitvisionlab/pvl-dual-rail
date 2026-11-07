# 工作追蹤

[主規範](../AGENTS.md)

## 用途

工作追蹤：PR、CHANGELOG 與版本 tag

## 適用範圍

本 repo 的變更紀錄與版本發佈紀錄。

## 現況

- **變更**：分支 → PR → 合併（例如 #7 `feat/responses-api`）。
- **版本紀錄**：[CHANGELOG.md](../CHANGELOG.md)，以 `## X.Y.Z — 日期` 為標題，寫明變更內容與驗證方式。
- **發佈**：主規範：「releases are cut by tagging (`vX.Y.Z`)」；`git push` 不部署任何東西。
- **Issue**：package.json `bugs` 指向 GitHub issues。
- `docs/tracking/devlog/`、`docs/tracking/handoff/` 由骨架建立，目前為空。

## 原則

- 新的政策行為要在同一個 commit 附 smoke check（主規範手寫區）。
- 版本變更照現行慣例寫進 CHANGELOG.md。

## 待 Ben 確認

- `docs/tracking/` 是否保留，或交接與紀錄只用 PR、issue 與 CHANGELOG。
- 打 tag 的時機與由誰執行。
