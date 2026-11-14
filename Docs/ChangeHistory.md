# aft-mcp 變更歷史

最新在最上。格式：`## YYYY.MM.DD HH:MM 一句話標題`，內文分「問題／根因／修改」。

<!-- 注意：任何以「## 」開頭的行都會被解析成條目，即使沒有日期。 -->
<!-- 這份骨架沒有紀錄，新增時用 changelogkit add 或直接依下列格式追加。 -->

---

<!-- 新條目範本（複製後刪掉這段說明與註解）：
## YYYY.MM.DD HH:MM 一句話標題

**類型**: 新增 · **檔案**: `path/to/file`

### 問題 - 摘要

### 根因 - 摘要

### 修改 - 核心改動

- 其他改動

---
-->
## 2026.11.15 00:06 建立 AFT 唯讀工具 MCP 適配器

**類型**: 新增 · **檔案**: `src/index.mjs`

### 問題 - AFT 只有 host plugin 入口，Codex 等 MCP host 無法使用它的唯讀程式碼工具

### 根因 - AFT 的工具面透過 aft-bridge 的 NDJSON 協議呼叫原生 binary，並沒有 MCP server 入口

### 修改 - 建立 Node MCP server：spawn aft.exe、configure 帶 harness=mcp:<client>、轉送 tool_call

- 提供 grep／glob／search／outline／zoom／inspect／callgraph／conflicts 等唯讀工具。
- 接入 changelogkit（.changelog.toml、Docs/ChangeHistory.md、TODO.md）。

**相關文件**: README.md

---
