# Archived — 2026-10-20

本 repo 已併入私有 repo **profitvisionlab/pvl-relay-skill** 的 `src/llm/`，不再單獨維護。

併入時的變更（Ben 2026-10-20 決定）：
- OpenRouter 與 NVIDIA NIM 全面禁用，設定出現即拒絕啟動（撤銷 2026-09-06「OpenRouter 留最後備胎」）
- 新增國安／兩岸議題閘門：只走 GCP 上的 Claude，排除中國來源模型家族，不跨家族降級
- 公開資料依價格在 Vertex 與 Together 之間挑選，同價走 GCP
- Vertex adapter 支援 Gemini／Claude／OpenAI 相容三種格式，服務帳號自動換 token
- TypeScript on Node ≥ 22.18，零相依

本 repo 最後一版（0.2.0）保留供外部參考「合規軌 × 成本軌」閘門的最小實作；policy 的硬規則不變。
