#!/usr/bin/env node
import { runStdioServer } from './server.ts';

runStdioServer().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[agent-desktop-mcp] ${message}\n`);
  process.exitCode = 1;
});
