export { handleToolCall, interpretRun, resolveAgentDesktopBin } from './dispatch.ts';
export { parseEnvelope, toToolResult, wrapperError } from './envelope.ts';
export { runAgentDesktop } from './run.ts';
export { runStdioServer } from './server.ts';
export { buildCliArgs, CliArgError, DESKTOP_TOOLS, SERVER_INSTRUCTIONS } from './tools.ts';
