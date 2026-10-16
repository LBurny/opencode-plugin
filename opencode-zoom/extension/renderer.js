// oc.zoom — renderer entry (placeholder).
//
// OpenCode Desktop 2.0.30 does not execute third-party renderer entries yet;
// all zoom UI is provided by this extension's main process (View menu items).
// This file exists because the gui-extension schema requires a renderer entry.
//
// It is intentionally written as a plain script that contains no `import` or
// `export` statements, so it parses under both script and module evaluation.
;(function () {
  try {
    console.debug('[oc.zoom] renderer placeholder loaded')
  } catch (error) {
    /* ignore */
  }
})()
