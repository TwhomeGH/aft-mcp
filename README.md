# aft-mcp

把 AFT（cortexkit）的唯讀工具包成 MCP server，供 Codex 等 MCP host 使用。

AFT 本身只支援 OpenCode／Pi／omp 這幾種 host，沒有 MCP server；但它接受
`harness: "mcp:<client>"` 的 configure，且 binary 以 NDJSON 溝通，因此這個
介面層直接驅動 `aft.exe`。

## 需求

- Node.js 18+
- AFT 已安裝（`%LOCALAPPDATA%\aft\bin\v*\aft.exe`，或設定 `AFT_BINARY`）

## 啟動

```powershell
node H:\aft-mcp\src\index.mjs
```

環境變數：

| 變數 | 說明 |
| --- | --- |
| `AFT_BINARY` | 指定 `aft.exe` 路徑（預設自動找最新版） |
| `AFT_PROJECT_ROOT` | 預設專案根目錄（否則用 process cwd） |
| `AFT_MCP_CLIENT` | harness 名稱，預設 `codex`（送 `mcp:codex`） |

## 註冊到 Codex

```powershell
codex mcp add aft -- node H:\aft-mcp\src\index.mjs
```

預設不啟用；要啟用時把 `~/.codex/config.toml` 的 `[mcp_servers.aft]` 改成
`enabled = true`，或直接移除 `enabled = false` 那一行。

Codex 的 MCP 程序 cwd 不一定是 session 的專案目錄，因此提供
`aft_use_project` 工具：

```text
aft_use_project { "root": "C:\\path\\to\\repo" }
```

之後同一個 MCP 程序都用這個根目錄（變更時會重新 configure）。

## 工具（全部唯讀）

| 工具 | AFT 指令 | 說明 |
| --- | --- | --- |
| `aft_grep` | `grep` | 索引式 regex 搜尋，支援 `include`／`path`／`offset` |
| `aft_glob` | `glob` | glob 檔名搜尋 |
| `aft_search` | `search` | 語意搜尋（需要 semantic index） |
| `aft_outline` | `outline` | 檔案／目錄結構大綱 |
| `aft_zoom` | `zoom` | 指定 symbol 的內容與位置 |
| `aft_inspect` | `inspect` | 診斷、TODO、metrics、dead code 等 |
| `aft_callgraph` | `callgraph` | `callers`／`call_tree`／`impact`／`trace_to`／`trace_to_symbol`／`trace_data` |
| `aft_conflicts` | `conflicts` | 合併衝突掃描 |
| `aft_status` | `status` | 索引／bridge 狀態 |
| `aft_use_project` | — | 設定專案根目錄 |

## 已知限制

- AFT 的 bridge 協定不是公開 API；升級 AFT 後請重跑測試（`node` 啟動後看 tool 結果）。
- 首次呼叫會觸發索引建置（grep 數秒；callgraph／semantic 可能更久），
  回應會帶 `index_building`／`callgraph_building`，重試即可。
- PowerShell 檔案不支援 outline（AFT 回 `unsupported file extension: ps1`）。
- semantic search 需要 ONNX Runtime；inspect 的 LSP 診斷需要對應語言伺服器。
