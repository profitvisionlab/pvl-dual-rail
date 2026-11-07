# 專案目錄結構

[主規範](../AGENTS.md)

## 用途

目錄結構與文件歸屬

## 適用範圍

本 repo 的頂層目錄與 `docs/` 分類。新增頂層目錄或分類時同步更新本檔。

## 頂層

```text
./
├── AGENTS.md            # 主規範（同步工具管理區＋手寫區 Ground rules）
├── README.md            # 雙軌說明、provider chain、result shape、使用方式
├── CHANGELOG.md         # 版本變更紀錄
├── LICENSE              # MIT
├── package.json         # exports、scripts、engines
├── .env.example         # 環境變數範本
├── src/                 # index、policy、router、env 與 adapters/
├── scripts/             # smoke.mjs 與 checks/（mock fetch 檢查）
├── .agent-rules/        # 細部規範（本檔所在）
├── .claude/ .agents/    # graft hooks／skill、project-scaffold skill
├── .github/workflows/   # ci.yml
└── docs/                # 專案文件骨架（分類見下，目前皆為空）
```

## docs/

| 目錄 | 放什麼 |
| --- | --- |
| `docs/requirements/` | 需求文件 |
| `docs/research/` | 研究資料 |
| `docs/architecture/` | 架構文件 |
| `docs/tracking/devlog/` | 開發過程與驗證紀錄 |
| `docs/tracking/handoff/` | 目前狀態與接續事項 |
| `docs/guides/` | 操作與使用指南 |

本次沒有移動任何檔案：根目錄只有 README、CHANGELOG、LICENSE 與主規範，皆不移動。

## 待 Ben 確認

- 本 repo 為公開 repo，`docs/` 底下哪些類別適合放在公開 repo（例如 handoff、devlog）。
