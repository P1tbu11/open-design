# Agent Desktop (Computer Use)

OpenDesign can give a Run desktop tools from [Vercel Labs agent-desktop](https://github.com/vercel-labs/agent-desktop). The CLI reads the operating system's accessibility tree and acts on element refs (`@<snapshot_id>:eN`). It is **accessibility-tree Computer Use**. It is not Anthropic's screenshot computer-use agent, and it is not the unrelated [agent-desktop.dev](https://agent-desktop.dev) / xa11y project.

The integration is a thin local stdio MCP server, `packages/agent-desktop-mcp`. It shells out to the `agent-desktop` binary on the same machine as the OpenDesign daemon. A cloud VM cannot see or click the GUI on your desk. Desktop control stays **off** until you add the server. Adding it is the opt-in.

## Enable it

1. On the desktop machine (the one whose apps you want the agent to see), install the CLI and confirm it prints a version:

   ```bash
   npm install -g agent-desktop
   agent-desktop version
   ```

2. In OpenDesign, open **Settings → External MCP → Add server**. Under **Utilities**, choose **Agent Desktop (Computer Use)** and save. The same picker is available from the composer **Add MCP server** menu. The form is filled with this checkout's Node binary and `packages/agent-desktop-mcp/src/cli.ts`. Leave the server out of the list, or toggle it off, and Runs do not get desktop tools.

3. Optional: set `AGENT_DESKTOP_BIN` on that server if the `agent-desktop` executable is not on `PATH`.

`agent-desktop` must be installed globally (`npm i -g agent-desktop`) or pointed at with `AGENT_DESKTOP_BIN`. The wrapper does not download it.

## macOS Accessibility

macOS will not return a tree until Accessibility is granted to the process that launches the CLI (Terminal, iTerm, the OpenDesign app, or whichever host starts the daemon).

1. Run `agent-desktop permissions`.
2. If accessibility is missing, run `agent-desktop permissions --guide`, or open **System Settings → Privacy & Security → Accessibility** and enable that host app.
3. Run `agent-desktop permissions` again and confirm the check passes.
4. `agent-desktop list-apps` should print a JSON envelope with `"ok": true`.

Windows needs no extra grant for apps at the terminal's integrity level. Linux needs the user's graphical session and `at-spi2-core`. Details are in the upstream [install guide](https://github.com/vercel-labs/agent-desktop/blob/main/docs/install.md).

## What a designer asks for

You have Figma open on a frame and Finder open on a folder of exports. After the server is added, ask the agent to list running apps, snapshot Figma with interactive elements only, and click the layer named "Hero" using the ref from that snapshot — then snapshot again to confirm the selection. The same loop works for Finder: snapshot the window, click a file row by its ref, and read the new tree. The agent never has to guess from a screenshot. Refs belong to one snapshot; if the UI moves, the CLI returns `STALE_REF` and the agent takes a fresh snapshot. Actions stay headless (no pointer motion) unless the request sets `headed`.

Snapshots can contain whatever is on screen. Treat them as private.

## Cancel and errors

Every CLI command prints one JSON object with `ok` and either `data` or `error`. The wrapper returns that object as the MCP tool result. When a call is cancelled after the process has started, the tool comes back as `CANCELLED` with `disposition.retry` of `unsafe`, because the click or keystroke may already have landed. Snapshot before trying again. Retry an action only when `error.disposition.retry` is `safe`.

If the binary is missing, the tool returns `CLI_NOT_FOUND` and does not pretend the action ran.
