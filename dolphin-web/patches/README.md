# Terminal theme bridge

`@dolphin-terminal/react@0.3.0` hard-codes xterm's palette. The checked-in
patch adds an optional xterm `theme` prop and enables transparent rendering.
`GlassSessionWindow` supplies the dashboard palette; other consumers retain
the original defaults. Theme changes update the renderer without reconnecting.
`npm install` / `npm ci` reapplies this through `patch-package`.

Remove the patch when the upstream package exposes equivalent theme support.
Programs emitting explicit RGB backgrounds still control those terminal cells;
this patch does not rewrite terminal output or mutate shared tmux settings.

Glass windows use the DOM renderer while they are part of the workspace:
xterm's addon-webgl 0.19 RectangleRenderer forces alpha=1 for default-background
rectangles on dim cells, producing black strips with a transparent theme. In
fullscreen there is nothing behind the terminal, so `src/terminal/webgl.ts`
switches to an opaque background (`--glass-term-solid`) and loads WebGL there.
Revisit when upstream preserves alpha.

# Terminal reconnect and host hooks

The same patch adds three props (spec: "Terminal pane extension points"):

- `reconnectKey`: a change drops the socket and reconnects, as Retry does.
  `GlassSessionWindow` passes `machine:epoch`, which the desktop main process
  moves when a machine link comes back.
- `retryAfterDrop`: a live socket that closes with anything but 1000 (session
  ended) or 1008 (refused) is retried with the existing backoff, starting at
  1 s (`dist/terminalDropRetry.js`). Without it, such a socket stays closed.
- `onTerminal(terminal)`: called once after the xterm instance is opened; the
  cleanup it returns runs before dispose. Terminal features attach here.

# Wrapped paths in select mode

`@dolphin-terminal/core@0.3.0` finds file paths one line at a time. Claude
Code and Codex wrap their own output with real newlines (often indenting the
rest), which tmux's `capture-pane -J` cannot rejoin, so a long path split
across lines was never a link. The core patch adds one more candidate where a
token runs to the end of its line and the next line starts with a token: the
two (and further lines, while each is wholly a piece of it) joined. The
server still decides which candidates are files. A joined one carries
`parts`, and `buildSnapshotSegments` links each piece to the same file while
the newline and indent stay text, so select mode still shows exactly what the
terminal printed. Tests: `src/terminal/wrappedPaths.test.ts` and
`e2e/glass-file-links.spec.ts`.
