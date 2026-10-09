// Central CSS entry point.
//
// main.tsx must import this module on its FIRST line, before `import App`.
// ES modules evaluate each import statement's module — and everything IT
// transitively imports — to completion, in declaration order. `import App`
// used to sit above these three stylesheet imports in main.tsx, so
// resolving App's component tree (CommandPalette -> commandPalette.css,
// KanbanControlCenter -> kanban.css, …) ran to completion FIRST, and only
// then did tokens.css / components.css / styles.css load. That silently
// inverted the intended cascade: components.css — meant to be a shared
// primitive layer that surface sheets build on top of — ended up loaded
// LAST, so it won every same-specificity tie against kanban.css and
// commandPalette.css (confirmed in the built bundle: cp-panel and
// ak-column-body land before components.css's dt-btn rules).
//
// Importing this module first guarantees tokens -> components -> styles
// always evaluate before any surface sheet pulled in through the component
// tree, regardless of how deep App's import graph gets. See
// cssHygiene.test.ts for the assertion that keeps this order from silently
// inverting again.
import '../tokens.css';
import '../components.css';
import '@dolphin-terminal/react/styles.css';
import '../styles.css';
