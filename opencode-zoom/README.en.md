# oc.zoom — Zoom plugin for OpenCode Desktop

[中文](./README.md)

Fixes two things: the zoom level is not remembered (back to 100% on every launch) and the
ratio cannot be controlled (the built-in step is a fixed ±20%).

Built as a desktop GUI extension — the app itself is not modified.

## Features

- **Remembers zoom**: restored on every launch and applied to new windows; changes made with
  the built-in shortcuts / wheel are remembered too
- **Set Zoom**: View menu → "Set Zoom" → any percentage, presets, `−`/`+` buttons using the
  chosen **step** (1% / 2% / 5% / 10%)
- **Follows the UI language**: menu and dialog text follow the app's language setting
  (Settings → Appearance → Language)

## Install

Requires Node.js ≥ 23.

1. Fully quit OpenCode (including the tray icon);
2. In the `opencode-zoom` folder run:

   ```powershell
   node tools\install.mjs
   ```

3. Reopen OpenCode — a "Set Zoom" entry in the View menu means it worked.

Dry run (checks only): `node tools\install.mjs --dry-run`.

## Uninstall

```powershell
node tools\uninstall.mjs          # remove the extension (keeps the config)
node tools\uninstall.mjs --purge  # also delete the config file
```

## Config

`%APPDATA%\ai.opencode.desktop\oc-zoom.json` (created on first run, editable):

```json
{
  "zoom": 1.1,     // remembered level (1 = 100%)
  "step": 0.05,    // step size (0.02 = 2%)
  "min": 0.25,     // minimum
  "max": 5,        // maximum
  "presets": [0.75, 0.9, 1, 1.1, 1.25, 1.5, 2]
}
```

## Notes

- How it works: the extension's `main` script runs in the Electron main process and
  sets/remembers the zoom. Packaged builds have no install UI, so a script writes into the
  app database directly (automatically backed up, fully uninstallable).
- Logs: search `oc.zoom` under `%APPDATA%\ai.opencode.desktop\logs\`.
- Uses an undocumented app mechanism; an app update may break it — update the plugin, or run
  the uninstaller first.
- Known quirk: right after changing zoom with this plugin, the built-in shortcuts may be off
  by one step; use a built-in zoom item once and it is back in sync.

## tools/

| Script | Purpose |
| --- | --- |
| `install.mjs` | Install (`--dry-run` to preview) |
| `uninstall.mjs` | Uninstall (`--purge` to also delete the config) |
| `verify.mjs` | Verify the database matches the source code |
| `test-main.mjs` | Offline tests (mocked Electron) |
| `preview-dialog.mjs` | Dump the dialog HTML for preview |
