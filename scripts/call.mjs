#!/usr/bin/env node
// Calls one Trawl tool over real MCP stdio, the same way an IDE does.
// Usage: node scripts/call.mjs <tool> '<json args>'   (or "-" to read the JSON from stdin)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, rawArgs = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("uso: node scripts/call.mjs <tool> '<json>'");
  process.exit(2);
}
const args = JSON.parse(rawArgs === "-" ? readFileSync(0, "utf8") : rawArgs);
const server = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const client = new Client({ name: "ss-call", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, TRAWL_LOG: "warn" } }));
const res = await client.callTool({ name: tool, arguments: args });
for (const c of res.content ?? []) if (c.type === "text") console.log(c.text);
await client.close();
// exitCode instead of process.exit(): exiting while the child pipes close asserts on Windows.
process.exitCode = res.isError ? 1 : 0;
