# 技術堆疊

[主規範](../AGENTS.md)

## 用途

技術堆疊：零執行期依賴的 Node.js（ESM）函式庫

## 適用範圍

本 repo 的執行環境、依賴與供應商 adapter。

## 正本

| 項目 | 正本 |
| --- | --- |
| 版本、exports、scripts、Node 版本 | [`package.json`](../package.json)（`engines.node: >=20`，`type: module`） |
| CI 的 Node 版本 | [`ci.yml`](../.github/workflows/ci.yml)（matrix：20、22） |
| 環境變數 | [`.env.example`](../.env.example)（不提交真實金鑰） |
| 版本變更 | [`CHANGELOG.md`](../CHANGELOG.md) |
| 授權 | [`LICENSE`](../LICENSE)（MIT） |

## 現行堆疊

- **語言**：Node.js `.mjs`，ESM only，沒有 build step（主規範手寫區）。
- **依賴**：零執行期依賴（主規範手寫區），package.json 沒有 dependencies，也沒有 lockfile。
- **入口**：`src/index.mjs`；另外匯出 `./policy`（`src/policy.mjs`）、`./router`（`src/router.mjs`）。
- **FinOps 軌 adapter**：`src/adapters/` 下的 together、deepinfra、lightning、openai、openrouter，以 `openai-compat.mjs` 為基礎；`responses.mjs` 處理 OpenAI `/responses` 格式轉換。
- **Enterprise 軌**：Vertex AI Gemini（`src/adapters/enterprise.mjs`）；`ENTERPRISE_ADAPTER=mock` 供離線驗證。
- **輔助**：`.claude/` 有 graft hooks 與 skill，`.mcp.json` 設定 graft MCP。

## 限制

- 新增執行期依賴需要充分理由（主規範手寫區）。
- 不內建模型清單，`*_TIER{1,2,3}_MODELS` 一律由環境變數提供（主規範手寫區）。
- 預設 chain（`together,openrouter`）是營運決策，改預設要寫明理由（主規範手寫區）。

## 待 Ben 確認

- 套件是否發佈到 npm registry（package.json `private: false`，README 與 CHANGELOG 未寫發佈流程）。
