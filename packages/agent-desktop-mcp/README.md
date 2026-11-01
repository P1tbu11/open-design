# @open-design/agent-desktop-mcp

Stdio MCP server that wraps the [Vercel Labs `agent-desktop`](https://github.com/vercel-labs/agent-desktop) CLI. The CLI reads OS accessibility trees and acts on element refs. This package does not ship a GUI driver and does not enable itself.

The host must have `agent-desktop` on `PATH` (`npm i -g agent-desktop`) or set `AGENT_DESKTOP_BIN`. On macOS, grant Accessibility to the app that launches the daemon. The daemon and the CLI must run on the same desktop; a cloud VM cannot drive that GUI.

OpenDesign lists it under **Settings → External MCP → Add server → Utilities → Agent Desktop (Computer Use)**. It stays off until that server is added. See [docs/agent-desktop-computer-use.md](../../docs/agent-desktop-computer-use.md).

```bash
node packages/agent-desktop-mcp/src/cli.ts
```

Node 22.18+ / 24 runs the TypeScript entry directly. The process speaks MCP on stdin/stdout and must not print logs on stdout.
