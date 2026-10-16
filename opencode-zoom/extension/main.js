// oc.zoom — OpenCode Desktop GUI extension: persistent + precise zoom control.
//
// This file is the extension's MAIN entry. It runs inside the Electron main
// process of the OpenCode desktop app. The loader evaluates it as a CommonJS
// script via `Function('require', 'module', 'exports', source)` with a
// restricted `require` that only resolves:
//   - 'electron' (the full Electron main-process API)
//   - Node builtins ('node:fs', 'node:path', ...)
//   - '@opencode/gui-extensions/sdk/main'
// All of those are declared in manifest.json → imports.main.
//
// Contract: the script must set `module.exports.default` to a setup function.
// setup(context) is called once when the extension activates.
//
// What it does:
//   1. Remembers the zoom factor across app restarts (persisted to
//      `<userData>/oc-zoom.json`, reapplied to every app window, including
//      brand-new ones).
//   2. Watches for zoom changes made with the built-in controls
//      (View menu / Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+wheel) and remembers the
//      last one automatically.
//   3. Adds "Set Zoom… / 缩放设置…" + fine step entries to the View menu.
//   4. Provides an `oc.zoom` IPC contract for programmatic control.
//
// NOTE: do not add `import`/`export` statements and do not `require` anything
// outside the whitelist above — the loader rejects both.

'use strict'

var EXT_ID = 'oc.zoom'
var CONFIG_FILE_NAME = 'oc-zoom.json'
var POLL_INTERVAL_MS = 1000
var STABLE_MS = 900 // a changed factor must stay stable this long to be saved
var EPSILON = 1e-4
var HARD_MIN = 0.2
var HARD_MAX = 10

var DEFAULT_CONFIG = {
  zoom: 1,
  step: 0.05,
  min: 0.25,
  max: 5,
  presets: [0.75, 0.9, 1, 1.1, 1.25, 1.5, 2]
}

function num(value) {
  var n = Number(value)
  return isFinite(n) ? n : null
}

function clamp(value, lo, hi) {
  var n = num(value)
  if (n === null) return null
  return Math.min(hi, Math.max(lo, n))
}

function setup(context) {
  var log = function (message, data) {
    try {
      context.log.write('[oc.zoom] ' + message, data || {})
    } catch (error) {
      /* logging must never break the extension */
    }
  }

  // ---------------------------------------------------------------- electron
  var electron = null
  var app = null
  var BrowserWindow = null
  var nativeTheme = null
  try {
    electron = require('electron')
    app = electron.app
    BrowserWindow = electron.BrowserWindow
    nativeTheme = electron.nativeTheme
    if (!app || !BrowserWindow) throw new Error('unexpected electron module shape')
  } catch (error) {
    log('electron is unavailable, extension disabled', { error: String(error) })
    return
  }

  var fs = require('node:fs')
  var path = require('node:path')

  // ------------------------------------------------------------------ config
  var configPath = null
  var config = Object.assign({}, DEFAULT_CONFIG)
  var savedFactor = DEFAULT_CONFIG.zoom

  function normalizeConfig(raw) {
    var out = Object.assign({}, DEFAULT_CONFIG)
    var source = raw && typeof raw === 'object' ? raw : {}

    var min = clamp(source.min, HARD_MIN, HARD_MAX)
    var max = clamp(source.max, HARD_MIN, HARD_MAX)
    if (min !== null) out.min = min
    if (max !== null) out.max = max
    if (out.min > out.max) {
      var swap = out.min
      out.min = out.max
      out.max = swap
    }
    if (out.max - out.min < 0.05) out.max = Math.min(HARD_MAX, out.min + 0.05)

    var zoom = clamp(source.zoom, out.min, out.max)
    if (zoom !== null) out.zoom = zoom

    var step = num(source.step)
    if (step !== null && step > 0) out.step = Math.min(step, 1)

    if (Array.isArray(source.presets)) {
      var presets = []
      for (var i = 0; i < source.presets.length && presets.length < 12; i++) {
        var preset = clamp(source.presets[i], out.min, out.max)
        if (preset !== null) presets.push(preset)
      }
      if (presets.length > 0) out.presets = presets
    }

    // preserve unknown keys so hand-edited extra fields survive
    return Object.assign({}, source, out)
  }

  function readConfig() {
    try {
      configPath = path.join(app.getPath('userData'), CONFIG_FILE_NAME)
      if (fs.existsSync(configPath)) {
        var raw = fs.readFileSync(configPath, 'utf8')
        config = normalizeConfig(JSON.parse(raw))
      } else {
        config = normalizeConfig(config)
      }
      savedFactor = clamp(config.zoom, config.min, config.max)
      if (savedFactor === null) savedFactor = DEFAULT_CONFIG.zoom
      config.zoom = savedFactor
    } catch (error) {
      config = normalizeConfig(null)
      savedFactor = config.zoom
      log('reading the config failed, using defaults', { error: String(error) })
    }
  }

  var writeQueued = false
  function writeConfigNow() {
    try {
      var tmp = configPath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, configPath)
    } catch (error) {
      log('writing the config failed', { error: String(error) })
    }
  }
  function writeConfig() {
    // tiny debounce so several changes in the same tick produce one write
    if (writeQueued) return
    writeQueued = true
    setTimeout(function () {
      writeQueued = false
      writeConfigNow()
    }, 50)
  }

  function remember(factor, reason) {
    var f = clamp(factor, config.min, config.max)
    if (f === null) return savedFactor
    if (Math.abs(f - savedFactor) < EPSILON) return savedFactor
    savedFactor = f
    config.zoom = f
    writeConfig()
    log('zoom remembered', { zoom: f, reason: reason })
    return savedFactor
  }

  // ----------------------------------------------------------------- locale
  // The extension follows the app's own UI language (Settings → Appearance →
  // Language). The app stores that choice in localStorage under
  // "opencode.global.dat:language" (JSON `{ "locale": "..." }`) and mirrors the
  // resolved value into `<html lang>`, so the extension probes a loaded window
  // and falls back to the OS locale until then.
  var STRINGS = {
    zh: {
      menuDialog: '缩放设置',
      dialogTitle: '缩放设置',
      current: '当前缩放',
      inputLabel: '缩放百分比',
      stepLabel: '步进',
      presets: '快捷预设',
      apply: '应用',
      cancel: '取消',
      hint: '对所有窗口生效,并在下次启动时自动恢复。'
    },
    en: {
      menuDialog: 'Set Zoom',
      dialogTitle: 'Set Zoom',
      current: 'Current zoom',
      inputLabel: 'Zoom percent',
      stepLabel: 'Step',
      presets: 'Presets',
      apply: 'Apply',
      cancel: 'Cancel',
      hint: 'Applies to all windows and is restored on the next launch.'
    }
  }

  function normalizeLang(value) {
    return String(value || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
  }

  var language = 'en'
  try {
    language = normalizeLang(app.getLocale())
  } catch (error) {
    language = 'en'
  }
  function L() {
    return STRINGS[language] || STRINGS.en
  }

  // ---------------------------------------------------------------- windows
  var dialogWindow = null
  var baseline = new Map() // webContents.id -> factor the extension last knew
  var candidate = new Map() // webContents.id -> { factor, at } pending user change
  var attached = new Set() // webContents.id

  function isDialog(win) {
    try {
      return !!dialogWindow && !dialogWindow.isDestroyed() && win.id === dialogWindow.id
    } catch (error) {
      return false
    }
  }

  function isAppWindow(win) {
    if (!win || isDialog(win)) return false
    try {
      if (win.isDestroyed()) return false
      var wc = win.webContents
      if (!wc || wc.isDestroyed()) return false
      var url = String(wc.getURL() || '')
      if (url.indexOf('oc://') === 0) return true
      return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/.test(url)
    } catch (error) {
      return false
    }
  }

  function appWindows() {
    try {
      return BrowserWindow.getAllWindows().filter(isAppWindow)
    } catch (error) {
      return []
    }
  }

  function readFactor(win) {
    try {
      var wc = win && win.webContents
      if (!wc || wc.isDestroyed()) return null
      var f = num(wc.getZoomFactor())
      return f
    } catch (error) {
      return null
    }
  }

  function applyTo(win, factor) {
    var f = clamp(factor, config.min, config.max)
    if (f === null) return
    try {
      var wc = win.webContents
      if (!wc || wc.isDestroyed()) return
      wc.setZoomFactor(f)
      baseline.set(wc.id, f)
      candidate.delete(wc.id)
    } catch (error) {
      log('applying the zoom failed', { error: String(error), window: win && win.id })
    }
  }

  function applyAll(factor) {
    var list = appWindows()
    for (var i = 0; i < list.length; i++) applyTo(list[i], factor)
  }

  function attachWindow(win) {
    if (!isAppWindow(win)) return
    var wc = win.webContents
    if (attached.has(wc.id)) {
      applyTo(win, savedFactor)
      return
    }
    attached.add(wc.id)

    var current = readFactor(win)
    baseline.set(wc.id, current === null ? savedFactor : current)
    applyTo(win, savedFactor)
    probeLanguage(win)

    // re-apply after every (re)load — zoom levels are per document origin and
    // the very first document may not have existed when the window was created.
    // Applying at `did-navigate` (commit) happens before the page scripts run,
    // so the app's own cached zoom state reads the correct value afterwards.
    var onLoaded = function () {
      if (!wc.isDestroyed() && isAppWindow(win)) {
        applyTo(win, savedFactor)
        probeLanguage(win)
      }
    }
    try {
      wc.on('did-finish-load', onLoaded)
    } catch (error) {
      /* ignore */
    }
    try {
      wc.on('did-navigate', onLoaded)
    } catch (error) {
      /* ignore */
    }
    try {
      wc.once('destroyed', function () {
        attached.delete(wc.id)
        baseline.delete(wc.id)
        candidate.delete(wc.id)
      })
    } catch (error) {
      /* ignore */
    }
  }

  // ------------------------------------------------------- UI language probe
  var lastLanguageProbe = 0

  function focusedAppWindow() {
    var list = appWindows()
    for (var i = 0; i < list.length; i++) {
      try {
        if (list[i].isFocused()) return list[i]
      } catch (error) {
        /* ignore */
      }
    }
    return list.length > 0 ? list[0] : null
  }

  function setLanguage(next) {
    if (!next || next === language) return
    language = next
    applyMenuLabels()
    log('ui language changed', { language: language })
  }

  function probeLanguage(win) {
    try {
      var wc = win && win.webContents
      if (!wc || wc.isDestroyed()) return
      var url = String(wc.getURL() || '')
      if (url.indexOf('oc://') !== 0 && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/.test(url)) return
      lastLanguageProbe = Date.now()
      wc.executeJavaScript(
        '(function(){try{var lang=document.documentElement&&document.documentElement.lang;if(lang)return String(lang);' +
          'var raw=localStorage.getItem("opencode.global.dat:language");' +
          'if(raw){try{var parsed=JSON.parse(raw);' +
          'if(parsed&&typeof parsed==="object"&&typeof parsed.locale==="string")return parsed.locale;' +
          'if(typeof parsed==="string")return parsed}catch(e){}}return ""}catch(e){return ""}})()',
        true
      )
        .then(function (value) {
          if (typeof value === 'string' && value) setLanguage(normalizeLang(value))
        })
        .catch(function () {})
    } catch (error) {
      /* probing must never break anything */
    }
  }

  // ------------------------------------------------- watcher (built-in zoom)
  var pollTimer = setInterval(function () {
    var now = Date.now()

    if (now - lastLanguageProbe > 10000) {
      var probeWin = focusedAppWindow()
      if (probeWin) probeLanguage(probeWin)
    }

    var list = appWindows()
    for (var i = 0; i < list.length; i++) {
      var wc = list[i].webContents
      var f = readFactor(list[i])
      if (f === null) continue
      var base = baseline.get(wc.id)
      if (base === undefined) {
        baseline.set(wc.id, f)
        continue
      }
      if (Math.abs(f - base) > EPSILON) {
        // something outside this extension changed the zoom
        baseline.set(wc.id, f)
        candidate.set(wc.id, { factor: f, at: now })
        continue
      }
      var pending = candidate.get(wc.id)
      if (!pending) continue
      if (Math.abs(f - pending.factor) > EPSILON) {
        candidate.delete(wc.id)
        continue
      }
      if (now - pending.at >= STABLE_MS) {
        candidate.delete(wc.id)
        if (Math.abs(pending.factor - savedFactor) > EPSILON) {
          remember(pending.factor, 'built-in controls')
        }
      }
    }
  }, POLL_INTERVAL_MS)

  // ------------------------------------------------------------- actions
  function currentFocusFactor() {
    var list = appWindows()
    var win = null
    for (var i = 0; i < list.length; i++) {
      try {
        if (list[i].isFocused()) {
          win = list[i]
          break
        }
      } catch (error) {
        /* ignore */
      }
    }
    if (!win && list.length > 0) win = list[0]
    var f = win ? readFactor(win) : null
    return f === null ? savedFactor : f
  }

  function stepAll(delta) {
    var target = currentFocusFactor() + delta
    var f = clamp(target, config.min, config.max)
    if (f === null) return
    applyAll(f)
    remember(f, 'step')
  }

  function applyEverywhere(factor, reason) {
    var f = clamp(factor, config.min, config.max)
    if (f === null) return savedFactor
    applyAll(f)
    return remember(f, reason)
  }

  // ------------------------------------------------------------ view menu
  var sdk = null
  try {
    sdk = require('@opencode/gui-extensions/sdk/main')
  } catch (error) {
    log('gui extension sdk is unavailable', { error: String(error) })
  }

  // Menubar items cannot update their labels themselves, but the host stores
  // the very same item object we register, so mutating `label` and asking the
  // host to re-broadcast the item list is enough to follow a language change.
  var menuEntries = [] // { item, key }
  var menuReady = false

  function refreshMenubar() {
    try {
      // Adding and immediately disposing of a hidden item queues one menubar
      // re-broadcast (the host coalesces it into a single microtask, so the
      // temporary item is never visible anywhere).
      var dispose = context.add(sdk.MenubarItem, {
        id: EXT_ID + '.__refresh',
        menu: 'view',
        label: '\u200b',
        run: function () {}
      })
      if (typeof dispose === 'function') dispose()
      else if (dispose && typeof dispose.dispose === 'function') dispose.dispose()
    } catch (error) {
      log('refreshing the menubar failed', { error: String(error) })
    }
  }

  function applyMenuLabels() {
    if (!menuReady) return
    var strings = L()
    var changed = false
    for (var i = 0; i < menuEntries.length; i++) {
      var entry = menuEntries[i]
      if (entry.item.label !== strings[entry.key]) {
        entry.item.label = strings[entry.key]
        changed = true
      }
    }
    if (changed) refreshMenubar()
  }

  if (sdk && sdk.MenubarItem) {
    // Only the settings entry is added. The built-in "放大 / 缩小" items right
    // above it already cover stepping, so duplicating them only caused
    // confusion. Fine stepping (the configurable "步进") is available through
    // the dialog's −/+ buttons and the oc.zoom IPC contract.
    var menuDefinitions = [
      { key: 'menuDialog', id: EXT_ID + '.dialog', run: function (win) { openDialog(win || null) } }
    ]
    for (var m = 0; m < menuDefinitions.length; m++) {
      var definition = menuDefinitions[m]
      var item = {
        id: definition.id,
        menu: 'view',
        label: L()[definition.key],
        after: 'view.zoomOut',
        run: definition.run
      }
      try {
        context.add(sdk.MenubarItem, item)
        menuEntries.push({ item: item, key: definition.key })
      } catch (error) {
        log('registering a menu item failed', { id: definition.id, error: String(error) })
      }
    }
    menuReady = true
    log('view menu items registered', { language: language })
  }

  // ---------------------------------------------------------------- dialog
  function resolveParent(sourceWin) {
    try {
      if (sourceWin && !sourceWin.isDestroyed() && isAppWindow(sourceWin)) return sourceWin
    } catch (error) {
      /* ignore */
    }
    try {
      var focused = BrowserWindow.getFocusedWindow()
      if (focused && isAppWindow(focused)) return focused
    } catch (error) {
      /* ignore */
    }
    var list = appWindows()
    return list.length > 0 ? list[0] : null
  }

  function closeDialog() {
    try {
      if (dialogWindow && !dialogWindow.isDestroyed()) dialogWindow.close()
    } catch (error) {
      /* ignore */
    }
  }

  function openDialog(sourceWin) {
    try {
      if (dialogWindow && !dialogWindow.isDestroyed()) {
        dialogWindow.focus()
        return
      }
      var dark = false
      try {
        dark = !!(nativeTheme && nativeTheme.shouldUseDarkColors)
      } catch (error) {
        dark = false
      }
      var parent = resolveParent(sourceWin)

      dialogWindow = new BrowserWindow({
        width: 420,
        height: 344,
        useContentSize: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        show: false,
        title: L().dialogTitle,
        parent: parent || undefined,
        modal: !!parent,
        backgroundColor: dark ? '#1b1b1d' : '#fafafa',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          devTools: false
        }
      })
      dialogWindow.setMenuBarVisibility(false)

      dialogWindow.on('page-title-updated', function (event, title) {
        // The dialog communicates through document.title:
        //   "oczoom:{...json...}" with { percent, step } — apply what changed
        //   "oczoom:cancel" — just close
        // The native title is never updated because the default is prevented.
        event.preventDefault()
        if (typeof title !== 'string' || title.indexOf('oczoom:') !== 0) return
        var payload = title.slice('oczoom:'.length)
        closeDialog()
        if (payload === 'cancel') return

        var data = null
        try {
          data = JSON.parse(payload)
        } catch (error) {
          // plain-number payloads from older dialogs still mean a percentage
          var legacy = num(parseFloat(payload))
          if (legacy !== null) data = { percent: legacy }
        }
        if (!data || typeof data !== 'object') return

        if (data.step !== undefined) {
          var stepPercent = num(data.step)
          if (stepPercent !== null && stepPercent > 0) {
            var step = Math.min(Math.max(stepPercent, 0.1), 100) / 100
            if (Math.abs(step - config.step) > 1e-6) {
              config.step = step
              writeConfig()
              log('step updated', { step: step })
            }
          }
        }
        if (data.percent !== undefined) {
          var percent = num(data.percent)
          if (percent !== null) {
            applyEverywhere(percent / 100, 'dialog')
            log('zoom set from dialog', { percent: percent })
          }
        }
      })

      dialogWindow.on('closed', function () {
        dialogWindow = null
      })

      dialogWindow.loadURL(dialogUrl(dark))
      dialogWindow.once('ready-to-show', function () {
        if (dialogWindow && !dialogWindow.isDestroyed()) dialogWindow.show()
      })
      log('dialog opened')
    } catch (error) {
      log('opening the dialog failed', { error: String(error) })
      closeDialog()
    }
  }

  function dialogUrl(dark) {
    return 'data:text/html;charset=UTF-8,' + encodeURIComponent(dialogHtml(dark))
  }

  function dialogHtml(dark) {
    var strings = L()
    var f = currentFocusFactor()
    var pct = Math.round(f * 1000) / 10
    var minPct = Math.round(config.min * 1000) / 10
    var maxPct = Math.round(config.max * 1000) / 10
    var stepPct = Math.round(config.step * 10000) / 100

    var stepChoices = [1, 2, 5, 10]
    var stepButtons = ''
    for (var s = 0; s < stepChoices.length; s++) {
      var stepValue = stepChoices[s]
      stepButtons +=
        '<button type="button" class="chip' +
        (Math.abs(stepValue - stepPct) < 1e-6 ? ' on' : '') +
        '" data-step="' +
        stepValue +
        '">' +
        stepValue +
        '%</button>'
    }

    var presetButtons = ''
    for (var i = 0; i < config.presets.length; i++) {
      var p = Math.round(config.presets[i] * 1000) / 10
      presetButtons +=
        '<button type="button" class="chip" data-preset="' +
        p +
        '">' +
        (Math.round(p) === p ? p : p.toFixed(1)) +
        '%</button>'
    }

    var bg = dark ? '#1b1b1d' : '#fafafa'
    var fg = dark ? '#f2f2f4' : '#16161a'
    var muted = dark ? '#9a9aa2' : '#63636d'
    var field = dark ? '#26262a' : '#ffffff'
    var border = dark ? '#3c3c44' : '#d8d8e0'
    var pill = dark ? '#2c2c31' : '#efeff3'
    var accent = dark ? '#f2f2f4' : '#16161a'
    var accentFg = dark ? '#16161a' : '#ffffff'

    return (
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<style>' +
      '*{box-sizing:border-box}' +
      'html,body{margin:0;height:100%;overflow:hidden}' +
      'body{background:' + bg + ';color:' + fg + ';' +
      'font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'padding:16px 18px;display:flex;flex-direction:column;user-select:none;-webkit-user-select:none}' +
      '.headline{display:flex;align-items:baseline;gap:10px;' +
      'padding-bottom:12px;border-bottom:1px solid ' + border + ';margin-bottom:14px}' +
      '.headline .value{font-size:32px;font-weight:650;letter-spacing:-.5px;line-height:1}' +
      '.headline .label{color:' + muted + ';font-size:12px}' +
      '.field{display:grid;grid-template-columns:76px 1fr;gap:10px;align-items:center;margin-bottom:10px}' +
      '.field>.label{color:' + muted + ';font-size:12px;white-space:nowrap}' +
      '.stepper{display:flex;align-items:center;gap:8px;min-width:0}' +
      '.chips{display:flex;flex-wrap:wrap;gap:6px}' +
      'button{font:inherit;color:' + fg + ';background:' + pill + ';border:1px solid ' + border + ';' +
      'border-radius:8px;height:30px;min-width:34px;cursor:pointer;padding:0 10px}' +
      'button:hover{filter:brightness(1.08)}' +
      'button:active{transform:translateY(1px)}' +
      '.chip{height:28px;min-width:46px;font-size:12px;padding:0 8px}' +
      '.chip.on{background:' + accent + ';color:' + accentFg + ';border-color:transparent;font-weight:600}' +
      'input{font:inherit;font-size:15px;font-weight:600;text-align:center;color:' + fg + ';' +
      'background:' + field + ';border:1px solid ' + border + ';border-radius:8px;height:34px;width:84px;outline:none}' +
      'input:focus{border-color:' + accent + '}' +
      'input.bad{border-color:#e5484d;color:#e5484d}' +
      '.unit{color:' + muted + ';font-size:12px}' +
      '.hint{color:' + muted + ';font-size:11.5px;margin-top:auto;padding-top:8px}' +
      '.footer{display:flex;justify-content:flex-end;gap:8px;padding-top:12px;' +
      'border-top:1px solid ' + border + ';margin-top:12px}' +
      '.footer .primary{background:' + accent + ';color:' + accentFg + ';border-color:transparent;font-weight:600;padding:0 16px}' +
      '</style></head><body>' +
      '<div class="headline"><span class="value" id="value">' + pct + '%</span>' +
      '<span class="label">' + escapeHtml(strings.current) + '</span></div>' +
      '<div class="field"><span class="label">' + escapeHtml(strings.inputLabel) + '</span>' +
      '<div class="stepper">' +
      '<button type="button" id="dec" title="-">&minus;</button>' +
      '<input id="pct" inputmode="decimal" autocomplete="off" spellcheck="false" value="' + pct + '">' +
      '<span class="unit">%</span>' +
      '<button type="button" id="inc" title="+">+</button>' +
      '</div></div>' +
      '<div class="field"><span class="label">' + escapeHtml(strings.stepLabel) + '</span>' +
      '<div class="chips">' + stepButtons + '</div></div>' +
      '<div class="field"><span class="label">' + escapeHtml(strings.presets) + '</span>' +
      '<div class="chips">' + presetButtons + '</div></div>' +
      '<div class="hint">' + escapeHtml(strings.hint) + '</div>' +
      '<div class="footer">' +
      '<button type="button" id="cancel">' + escapeHtml(strings.cancel) + '</button>' +
      '<button type="button" id="ok" class="primary">' + escapeHtml(strings.apply) + '</button>' +
      '</div>' +
      '<script>' +
      '(function(){' +
      'var MIN=' + minPct + ',MAX=' + maxPct + ',INITIAL=' + pct + ',INITIAL_STEP=' + stepPct + ';' +
      'var input=document.getElementById("pct");' +
      'var value=document.getElementById("value");' +
      'var activeStep=INITIAL_STEP;' +
      'function parse(){var v=parseFloat(String(input.value).replace(/[^0-9.]/g,""));return isFinite(v)?v:null}' +
      'function draw(){var v=parse();value.textContent=(v===null?INITIAL:v)+"%"}' +
      'function apply(){var v=parse();' +
      'if(v===null||v<MIN||v>MAX){input.classList.add("bad");input.focus();input.select();return}' +
      'document.title="oczoom:"+JSON.stringify({percent:v,step:activeStep})}' +
      'function cancel(){document.title="oczoom:cancel"}' +
      'function bump(d){var v=parse();if(v===null)v=INITIAL;' +
      'v=Math.min(MAX,Math.max(MIN,Math.round((v+d)*100)/100));' +
      'input.value=String(v);input.classList.remove("bad");draw()}' +
      'var stepButtons=document.querySelectorAll("[data-step]");' +
      'function paintSteps(){for(var i=0;i<stepButtons.length;i++){' +
      'var s=parseFloat(stepButtons[i].getAttribute("data-step"));' +
      'stepButtons[i].className="chip"+(Math.abs(s-activeStep)<1e-9?" on":"")}}' +
      'for(var i=0;i<stepButtons.length;i++){(function(btn){btn.addEventListener("click",function(){' +
      'activeStep=parseFloat(btn.getAttribute("data-step"));paintSteps()})})(stepButtons[i])}' +
      'document.getElementById("ok").addEventListener("click",apply);' +
      'document.getElementById("cancel").addEventListener("click",cancel);' +
      'document.getElementById("dec").addEventListener("click",function(){bump(-activeStep)});' +
      'document.getElementById("inc").addEventListener("click",function(){bump(activeStep)});' +
      'var presets=document.querySelectorAll("[data-preset]");' +
      'for(var j=0;j<presets.length;j++){(function(btn){btn.addEventListener("click",function(){' +
      'input.value=btn.getAttribute("data-preset");input.classList.remove("bad");apply()})})(presets[j])}' +
      'input.addEventListener("input",function(){input.classList.remove("bad");draw()});' +
      'document.addEventListener("keydown",function(e){' +
      'if(e.key==="Enter"){e.preventDefault();apply()}' +
      'else if(e.key==="Escape"){e.preventDefault();cancel()}});' +
      'input.focus();input.select();draw();paintSteps()' +
      '})()' +
      '<\/script></body></html>'
    )
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // ------------------------------------------------------------- ipc contract
  if (sdk && sdk.Ipc) {
    try {
      var contract = sdk.Ipc.define({
        id: EXT_ID,
        methods: {
          get: {},
          set: {},
          zoomIn: {},
          zoomOut: {},
          reset: {},
          open: {}
        }
      })
      var normalizeInput = function (input) {
        if (input && typeof input === 'object') {
          if (input.factor !== undefined) return clamp(input.factor, config.min, config.max)
          if (input.percent !== undefined) return clamp(num(input.percent) / 100, config.min, config.max)
          return null
        }
        // bare numbers are treated as percentages (125 → 1.25)
        var percent = num(input)
        if (percent === null) return null
        return clamp(percent / 100, config.min, config.max)
      }
      context.provide(contract, {
        get: function () {
          return {
            factor: savedFactor,
            percent: Math.round(savedFactor * 1000) / 10,
            step: config.step,
            min: config.min,
            max: config.max,
            windows: appWindows().map(function (win) {
              return { id: win.id, factor: readFactor(win) }
            })
          }
        },
        set: function (input) {
          var f = normalizeInput(input)
          if (f !== null) applyEverywhere(f, 'ipc')
          return savedFactor
        },
        zoomIn: function () {
          stepAll(config.step)
          return savedFactor
        },
        zoomOut: function () {
          stepAll(-config.step)
          return savedFactor
        },
        reset: function () {
          applyEverywhere(1, 'ipc')
          return savedFactor
        },
        open: function (input, callContext) {
          var win = null
          try {
            if (callContext && callContext.window) win = BrowserWindow.fromId(callContext.window)
          } catch (error) {
            win = null
          }
          openDialog(win)
          return true
        }
      })
      log('ipc contract provided')
    } catch (error) {
      log('registering the ipc contract failed', { error: String(error) })
    }
  }

  // ------------------------------------------------------------------ start
  readConfig()
  writeConfig()

  var version = ''
  try {
    version = (context.build && context.build.version) || ''
  } catch (error) {
    version = ''
  }
  log('activated', {
    extension: EXT_ID,
    version: version,
    language: language,
    zoom: savedFactor,
    min: config.min,
    max: config.max,
    step: config.step,
    windows: appWindows().length
  })

  var initial = appWindows()
  for (var w = 0; w < initial.length; w++) attachWindow(initial[w])

  var onCreated = function (event, win) {
    attachWindow(win)
  }
  app.on('browser-window-created', onCreated)

  // ---------------------------------------------------------------- cleanup
  var signal = null
  try {
    signal = context.scope && context.scope.signal
  } catch (error) {
    signal = null
  }
  if (signal) {
    var cleanup = function () {
      clearInterval(pollTimer)
      try {
        app.removeListener('browser-window-created', onCreated)
      } catch (error) {
        /* ignore */
      }
      closeDialog()
      log('deactivated')
    }
    if (signal.aborted) cleanup()
    else signal.addEventListener('abort', cleanup, { once: true })
  }
}

module.exports = { default: setup }
