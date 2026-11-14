#!/usr/bin/env node
/**
 * aft-mcp — read-only MCP adapter for AFT (cortexkit).
 *
 * AFT exposes a NDJSON bridge on the `aft` binary's stdin/stdout, but ships no
 * MCP server. This adapter spawns the binary, configures it with
 * `harness: "mcp:<client>"`, and forwards read-only tools to `tool_call`.
 *
 * stdout is reserved for the MCP protocol; diagnostics go to stderr.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = "aft-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 120_000;
const CONFIGURE_TIMEOUT_MS = 60_000;
const HARNESS = `mcp:${process.env.AFT_MCP_CLIENT || "codex"}`;
const SOFT_CODES = new Set([
  "callgraph_building",
  "index_building",
  "store_building",
  "semantic_building",
  "semantic_unavailable",
]);

function log(message) {
  process.stderr.write(`[aft-mcp] ${message}\n`);
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function versionOf(binaryPath) {
  const match = /v(\d+)\.(\d+)\.(\d+)/.exec(binaryPath);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function resolveBinary() {
  const candidates = [];
  if (process.env.AFT_BINARY) candidates.push(process.env.AFT_BINARY);

  if (process.platform === "win32") {
    const base = join(process.env.LOCALAPPDATA || "", "aft", "bin");
    for (const entry of safeReaddir(base)) candidates.push(join(base, entry, "aft.exe"));
  }
  const cacheBase = join(homedir(), ".cache", "aft", "bin");
  for (const entry of safeReaddir(cacheBase)) candidates.push(join(cacheBase, entry, "aft"));
  for (const entry of safeReaddir(cacheBase)) candidates.push(join(cacheBase, entry, "aft.exe"));

  const found = candidates.filter((candidate) => candidate && existsSync(candidate));
  found.sort((a, b) => {
    const [amaj, amin, apatch] = versionOf(a);
    const [bmaj, bmin, bpatch] = versionOf(b);
    return amaj - bmaj || amin - bmin || apatch - bpatch;
  });
  return found.at(-1) || null;
}

class AftBridge {
  constructor() {
    this.binary = resolveBinary();
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.buffer = "";
    this.configuredRoot = null;
  }

  ensureChild() {
    if (this.child) return;
    if (!this.binary) {
      throw new Error(
        "aft binary not found; set AFT_BINARY or install the AFT plugin so %LOCALAPPDATA%\\aft\\bin exists",
      );
    }
    this.child = spawn(this.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code) => {
      this.failAll(new Error(`aft exited (code ${code})`));
      this.child = null;
      this.configuredRoot = null;
    });
    log(`spawned ${this.binary}`);
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message.id) continue; // push frame (bash progress etc.)
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(command, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.ensureChild();
    const id = `aft-mcp-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`aft command "${command}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, command, ...params })}\n`);
    });
  }

  async configure(root) {
    const response = await this.request(
      "configure",
      { project_root: root, harness: HARNESS },
      CONFIGURE_TIMEOUT_MS,
    );
    if (response.success === false) {
      throw new Error(`aft configure failed: ${response.message || response.code || "unknown"}`);
    }
    this.configuredRoot = root;
  }

  async callTool(name, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.configuredRoot !== projectRoot) {
      await this.configure(projectRoot);
    }
    return this.request("tool_call", { name, arguments: args }, timeoutMs);
  }

  async status() {
    if (this.configuredRoot !== projectRoot) {
      await this.configure(projectRoot);
    }
    return this.request("status", {}, CONFIGURE_TIMEOUT_MS);
  }

  close() {
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }
}

let projectRoot = process.env.AFT_PROJECT_ROOT || process.cwd();
const bridge = new AftBridge();

function toResult(response) {
  const text =
    typeof response.text === "string" && response.text.length > 0
      ? response.text
      : JSON.stringify(response, null, 2);
  const soft = typeof response.code === "string" && SOFT_CODES.has(response.code);
  return {
    content: [{ type: "text", text }],
    isError: response.success === false && !soft,
  };
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

function addTool(name, description, inputSchema, handler, timeoutMs = DEFAULT_TIMEOUT_MS) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    const response = await bridge.callTool(handler.aftName ?? name.replace(/^aft_/, ""), args, timeoutMs);
    return toResult(response);
  });
}

addTool(
  "aft_grep",
  "AFT indexed grep (read-only). Regex search with file paths and line numbers; paginate with offset.",
  {
    pattern: z.string(),
    include: z.string().optional(),
    path: z.string().optional(),
    offset: z.number().int().min(0).optional(),
  },
  { aftName: "grep" },
);

addTool(
  "aft_glob",
  "AFT indexed glob (read-only). List files matching a glob pattern.",
  {
    pattern: z.string(),
    path: z.string().optional(),
  },
  { aftName: "glob" },
);

addTool(
  "aft_search",
  "AFT semantic search (read-only). Requires the semantic index; returns ranked code fragments.",
  {
    query: z.string().optional(),
    pattern: z.string().optional(),
    topK: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).optional(),
    includeTests: z.boolean().optional(),
  },
  { aftName: "search" },
  180_000,
);

addTool(
  "aft_outline",
  "AFT structural outline (read-only). Symbols/headings with line ranges; pass files=true for a directory tree.",
  {
    target: z.union([z.string(), z.array(z.string())]),
    files: z.boolean().optional(),
    includeTests: z.boolean().optional(),
  },
  { aftName: "outline" },
);

addTool(
  "aft_zoom",
  "AFT symbol zoom (read-only). Pass batch: [{ target, symbols }] to read specific symbols/sections.",
  {
    batch: z.array(
      z.object({
        target: z.string(),
        symbols: z.union([z.string(), z.array(z.string())]),
      }),
    ),
    contextLines: z.number().int().min(1).optional(),
    callgraph: z.boolean().optional(),
  },
  { aftName: "zoom" },
);

addTool(
  "aft_inspect",
  "AFT codebase inspection (read-only). Diagnostics, TODOs, metrics, dead code, unused exports, duplicates.",
  {
    sections: z.union([z.string(), z.array(z.string())]).optional(),
    scope: z.union([z.string(), z.array(z.string())]).optional(),
    topK: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  },
  { aftName: "inspect" },
  240_000,
);

addTool(
  "aft_callgraph",
  "AFT call graph (read-only). Ops: callers, call_tree, impact, trace_to, trace_to_symbol, trace_data.",
  {
    op: z.enum(["callers", "call_tree", "impact", "trace_to", "trace_to_symbol", "trace_data"]),
    filePath: z.string(),
    symbol: z.string(),
    depth: z.number().int().min(1).optional(),
    expression: z.string().optional(),
    toSymbol: z.string().optional(),
    toFile: z.string().optional(),
    includeTests: z.boolean().optional(),
    includeUnresolved: z.boolean().optional(),
  },
  { aftName: "callgraph" },
  180_000,
);

addTool(
  "aft_conflicts",
  "AFT merge-conflict scan (read-only). Lists conflicted files/regions for a repo or worktree.",
  {
    path: z.string().optional(),
  },
  { aftName: "conflicts" },
);

server.registerTool(
  "aft_use_project",
  {
    description: "Set the AFT project root for this session (configures the aft bridge).",
    inputSchema: { root: z.string() },
  },
  async ({ root }) => {
    projectRoot = root;
    await bridge.configure(root);
    return { content: [{ type: "text", text: `AFT project root: ${root}` }] };
  },
);

server.registerTool(
  "aft_status",
  {
    description: "AFT bridge/index status (read-only). Useful when a tool reports an index is building.",
    inputSchema: {},
  },
  async () => toResult(await bridge.status()),
);

process.on("SIGINT", () => {
  bridge.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  bridge.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
log(`ready (root=${projectRoot}, harness=${HARNESS}, binary=${bridge.binary || "unresolved"})`);
