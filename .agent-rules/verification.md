# 驗證規範

[主規範](../AGENTS.md)

## 用途

驗證：離線 smoke 測試、CI 與文件檢查

## 適用範圍

本 repo 所有變更。主規範：「Keep `npm test` green for every change.」

## CI

正本是 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)，push 到 main 與 PR 時在 Node 20、22 跑 `npm test`。零依賴，不安裝。

## 本機檢查

| 指令 | 內容 |
| --- | --- |
| `npm test`（＝`npm run smoke`） | `node scripts/smoke.mjs`：policy gate、adapter、chain、tool-call、responses 檢查 |

- smoke 完全離線：`ENTERPRISE_ADAPTER=mock`，不需要金鑰；adapter／chain／tool-call 檢查用 mock `fetch`（`scripts/checks/`）。
- 測試不得打真實 API，也不得需要真實金鑰（主規範手寫區）。
- 新的 policy 行為要在同一個 commit 附 smoke check；`src/policy.mjs` 不得放寬（主規範手寫區）。

## 文件變更

- 確認新增或修改的相對連結都指向存在的檔案。
- 檔案用途或位置改了，同步更新：`AGENTS.md`「細部規範」索引、[project-structure.md](project-structure.md) 樹狀圖、README。
- 公開 repo：文件不寫金鑰、內部連線資訊或內部營運契約。

## 回報

PR 說明寫明：`npm test` 結果；沒做的檢查與原因（例如「未用真金鑰實打供應商」）。

## 待 Ben 確認

- 真金鑰實打驗證（CHANGELOG 曾記錄 live 驗證）是否列為發版前的必要步驟。
