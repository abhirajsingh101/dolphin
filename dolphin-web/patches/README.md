# Terminal theme bridge

`@dolphin-terminal/react@0.3.0` hard-codes xterm's palette. The checked-in
patch adds an optional xterm `theme` prop and enables transparent rendering.
`GlassSessionWindow` supplies the dashboard palette; other consumers retain
the original defaults. Theme changes update the renderer without reconnecting.
`npm install` / `npm ci` reapplies this through `patch-package`.

Remove the patch when the upstream package exposes equivalent theme support.
Programs emitting explicit RGB backgrounds still control those terminal cells;
this patch does not rewrite terminal output or mutate shared tmux settings.

Glass windows opt out of WebGL: xterm 0.19's RectangleRenderer forces alpha=1
for default-background rectangles on dim cells, producing black strips with a
transparent theme. The DOM renderer preserves those backgrounds. Other terminal
surfaces keep WebGL acceleration. Revisit this opt-out when upstream fixes alpha.
