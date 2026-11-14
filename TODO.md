# aft-mcp TODO

## 待辦

- [ ] AFT 升級後重跑 MCP 握手與工具驗證（bridge 協定不是公開 API）

## 已知限制

- 首次呼叫會觸發索引建置（grep 數秒；callgraph／semantic 可能更久）
- PowerShell 檔案不支援 outline（AFT 回 `unsupported file extension: ps1`）
- semantic search 需要 ONNX Runtime；inspect 的 LSP 診斷需要對應語言伺服器
