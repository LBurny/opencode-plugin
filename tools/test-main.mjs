#!/usr/bin/env node
// Offline test for extension/main.js.
//
// Simulates the OpenCode Desktop extension loader (Function-based CommonJS
// evaluation with a restricted require) and a minimal fake Electron main
// process, then exercises the zoom logic end to end:
//
//   1. loader contract: module.exports.default is a function
//   2. startup apply: existing windows receive the remembered factor
//   3. new windows receive the remembered factor
//   4. built-in zoom changes (outside the extension) get remembered
//   5. View-menu items exist and step the zoom by the configured step
//   6. the oc.zoom IPC contract sets/gets/resets
//   7. the "Set Zoom…" dialog applies its title-channel result to all windows
//
// Run: node tools/test-main.mjs

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const extensionDir = path.join(repoRoot, 'extension')
const source = fs.readFileSync(path.join(extensionDir, 'main.js'), 'utf8')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------ fake electron
let nextId = 1
const windows = new Map()

class MockWebContents extends EventEmitter {
  constructor(id) {
    super()
    this.id = id
    this._factor = 1
    this._url = ''
    this._destroyed = false
  }
  getZoomFactor() {
    if (this._destroyed) throw new Error('webContents destroyed')
    return this._factor
  }
  setZoomFactor(factor) {
    if (this._destroyed) throw new Error('webContents destroyed')
    this._factor = factor
  }
  isDestroyed() {
    return this._destroyed
  }
  getURL() {
    return this._url
  }
  executeJavaScript() {
    return Promise.resolve(this._language ?? '')
  }
}

class MockWindow extends EventEmitter {
  constructor(options = {}) {
    super()
    this.id = nextId++
    this._options = options
    this._destroyed = false
    this._focused = false
    this._visible = false
    this.webContents = new MockWebContents(this.id * 10)
    windows.set(this.id, this)
  }
  isDestroyed() {
    return this._destroyed
  }
  isFocused() {
    return this._focused
  }
  focus() {
    this._focused = true
  }
  show() {
    this._visible = true
  }
  close() {
    if (this._destroyed) return
    this._destroyed = true
    windows.delete(this.id)
    this.emit('closed')
  }
  setMenuBarVisibility() {}
  loadURL(url) {
    this.webContents._url = url
    queueMicrotask(() => {
      if (!this.webContents._destroyed) this.webContents.emit('did-finish-load')
    })
    return Promise.resolve()
  }
}

class MockBrowserWindow extends MockWindow {
  static getAllWindows() {
    return [...windows.values()].filter((win) => !win.isDestroyed())
  }
  static fromId(id) {
    return windows.get(id) ?? null
  }
  static getFocusedWindow() {
    return MockBrowserWindow.getAllWindows().find((win) => win.isFocused()) ?? null
  }
}

const tmpRoot = fs.existsSync('C:\\Users\\intel\\AppData\\Local\\Temp\\opencode')
  ? 'C:\\Users\\intel\\AppData\\Local\\Temp\\opencode'
  : os.tmpdir()
const userDataDir = fs.mkdtempSync(path.join(tmpRoot, 'oczoom-test-'))
const configPath = path.join(userDataDir, 'oc-zoom.json')

const app = Object.assign(new EventEmitter(), {
  getLocale: () => 'zh-CN',
  getPath: (name) => {
    if (name === 'userData') return userDataDir
    return os.tmpdir()
  }
})

const electron = {
  app,
  BrowserWindow: MockBrowserWindow,
  nativeTheme: { shouldUseDarkColors: false }
}

// --------------------------------------------------------------- fake SDK
const sdkStub = {
  MenubarItem: { kind: 'registry', id: 'menubar-item' },
  Ipc: {
    define: (spec) => ({ kind: 'ipc', id: spec.id, spec })
  }
}

function makeRequire() {
  return (name) => {
    if (name === 'electron') return electron
    if (name === 'node:fs') return fs
    if (name === 'node:path') return path
    if (name === '@opencode/gui-extensions/sdk/main') return sdkStub
    throw new Error(`test require shim: unexpected module "${name}"`)
  }
}

// ------------------------------------------------------------ fake context
const logs = []
const menuItems = []
const provided = []
const abort = new AbortController()
const context = {
  id: 'oc.zoom',
  log: {
    write(message, data) {
      logs.push({ message, data })
    }
  },
  scope: { signal: abort.signal },
  add(registry, item) {
    assert.equal(registry, sdkStub.MenubarItem)
    menuItems.push(item)
    return () => {
      const index = menuItems.indexOf(item)
      if (index >= 0) menuItems.splice(index, 1)
    }
  },
  provide(contract, implementation) {
    provided.push({ contract, implementation })
  }
}

function factor(win) {
  return win.webContents.getZoomFactor()
}

function readConfigFile() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

async function main() {
  // seed a remembered zoom so "restart" behavior is observable
  fs.writeFileSync(configPath, JSON.stringify({ zoom: 1.25 }) + '\n', 'utf8')

  // main window exists *before* the extension activates
  const mainWin = new MockBrowserWindow({ title: 'oc-main' })
  mainWin.webContents._url = 'oc://renderer/index.html'
  mainWin._focused = true

  // ---- 1. loader contract -------------------------------------------------
  const moduleObj = { exports: {} }
  const evaluate = new Function('require', 'module', 'exports', source)
  evaluate(makeRequire(), moduleObj, moduleObj.exports)
  assert.equal(typeof moduleObj.exports.default, 'function', 'module.exports.default must be the setup function')

  moduleObj.exports.default(context)
  assert.ok(
    logs.some((entry) => entry.message.includes('activated')),
    'expected an "activated" log line'
  )
  assert.equal(provided.length, 1, 'expected exactly one IPC contract')

  // ---- 2. startup apply ---------------------------------------------------
  assert.equal(factor(mainWin), 1.25, 'existing window should get the remembered zoom')

  // ---- 3. new window ------------------------------------------------------
  const win2 = new MockBrowserWindow({ title: 'oc-second' })
  win2.webContents._url = 'oc://renderer/index.html'
  app.emit('browser-window-created', {}, win2)
  assert.equal(factor(win2), 1.25, 'new window should get the remembered zoom')

  // a non-app window (e.g. an external page) must be left alone
  const other = new MockBrowserWindow({ title: 'other' })
  other.webContents._url = 'https://example.com/'
  app.emit('browser-window-created', {}, other)
  assert.equal(factor(other), 1, 'non-app windows must not be touched')

  // ---- 5. menu items ------------------------------------------------------
  assert.equal(menuItems.length, 1, 'expected a single View-menu item (Set Zoom)')
  const byId = (suffix) => menuItems.find((item) => item.id === 'oc.zoom' + suffix)
  for (const item of menuItems) {
    assert.equal(item.menu, 'view')
    assert.equal(typeof item.label, 'string')
    assert.equal(typeof item.run, 'function')
  }

  // ---- 8. language follows the app UI setting ------------------------------
  const dialogItem = byId('.dialog')
  assert.ok(dialogItem)
  assert.equal(dialogItem.label, '缩放设置', 'Chinese labels follow the system locale until the app language is read')
  assert.ok(!dialogItem.label.includes('…'), 'labels must not contain an ellipsis')

  // ---- 6. IPC contract ----------------------------------------------------
  const { implementation } = provided[0]
  assert.deepEqual(Object.keys(implementation).sort(), ['get', 'open', 'reset', 'set', 'zoomIn', 'zoomOut'])
  implementation.set(125)
  assert.equal(factor(mainWin), 1.25, 'ipc set(125) means 125%')
  assert.equal(implementation.get().percent, 125)
  implementation.zoomIn()
  assert.equal(implementation.get().percent, 130)
  implementation.reset()
  assert.equal(implementation.get().percent, 100)
  implementation.set({ factor: 1.4 })
  assert.equal(factor(win2), 1.4, 'ipc set({factor}) is relative')

  // ---- 7. dialog ----------------------------------------------------------
  dialogItem.run(mainWin)
  const dialogWin = MockBrowserWindow.getAllWindows().find((win) =>
    String(win.webContents._url).startsWith('data:text/html')
  )
  assert.ok(dialogWin, 'the dialog window should exist')
  assert.equal(factor(dialogWin), 1, 'the dialog window itself must not be zoomed by the extension')

  let prevented = false
  dialogWin.emit(
    'page-title-updated',
    {
      preventDefault() {
        prevented = true
      }
    },
    'oczoom:' + JSON.stringify({ percent: 137.5, step: 2 })
  )
  assert.equal(prevented, true, 'the title update must be prevented')
  assert.equal(factor(mainWin), 1.375, 'dialog result applies to all windows')
  assert.equal(factor(win2), 1.375)
  await sleep(200)
  assert.equal(readConfigFile().zoom, 1.375, 'dialog result is persisted')
  assert.equal(readConfigFile().step, 0.02, 'dialog step is persisted')
  assert.ok(dialogWin.isDestroyed(), 'the dialog closes after applying')

  // the newly selected step drives programmatic stepping immediately
  implementation.zoomIn()
  assert.equal(factor(mainWin), 1.395, 'stepping uses the step chosen in the dialog (2%)')
  assert.equal(factor(win2), 1.395)

  // cancel path: open again, send cancel, nothing changes
  dialogItem.run(mainWin)
  const dialogWin2 = MockBrowserWindow.getAllWindows().find((win) =>
    String(win.webContents._url).startsWith('data:text/html')
  )
  assert.ok(dialogWin2)
  dialogWin2.emit('page-title-updated', { preventDefault() {} }, 'oczoom:cancel')
  assert.equal(factor(mainWin), 1.395, 'canceling the dialog changes nothing')
  assert.ok(dialogWin2.isDestroyed())

  // ---- 4. built-in zoom changes are remembered ----------------------------
  // simulate the user pressing the built-in View-menu zoom keys: the factor of
  // the webContents changes without the extension knowing
  mainWin.webContents._factor = 1.5
  await sleep(2600)
  assert.equal(readConfigFile().zoom, 1.5, 'a built-in zoom change becomes the remembered zoom')
  assert.equal(factor(win2), 1.395, 'other windows keep their factor until reopened')
  assert.equal(implementation.get().percent, 150)

  // extension-driven changes must not be re-remembered as external
  const before = logs.filter((entry) => entry.message.includes('remembered')).length
  implementation.set(90)
  await sleep(1600)
  const after = logs.filter((entry) => entry.message.includes('remembered')).length
  assert.equal(after - before, 1, 'exactly one remember event for an extension-driven change')

  // ---- 8. language switch --------------------------------------------------
  // the app UI language lives in the page (html[lang] / localStorage); once it
  // is read, the menu labels must switch language and the nudge must clean up
  mainWin.webContents._language = 'en-US'
  mainWin.webContents.emit('did-finish-load')
  await sleep(400)
  assert.equal(menuItems.length, 1, 'the menubar refresh nudge must clean itself up')
  assert.equal(byId('.dialog').label, 'Set Zoom', 'labels follow the app UI language')

  // ---- cleanup ------------------------------------------------------------
  abort.abort()
  for (const win of MockBrowserWindow.getAllWindows()) win.close()
  console.log('\n✔ all main.js tests passed')
  console.log(`  (logs written by the extension: ${logs.length}, temp dir: ${userDataDir})`)
}

main().catch((error) => {
  console.error('\n✖ test failed')
  console.error(error)
  process.exit(1)
})
