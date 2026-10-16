#!/usr/bin/env node
// Writes the current "Set Zoom…" dialog HTML to a file for visual inspection.
// Usage: node tools/preview-dialog.mjs [--light] [--out <file>]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.resolve(here, '..', 'extension', 'main.js'), 'utf8')

let dark = true
let out = path.join(
  fs.existsSync('C:\\Users\\intel\\AppData\\Local\\Temp\\opencode')
    ? 'C:\\Users\\intel\\AppData\\Local\\Temp\\opencode'
    : os.tmpdir(),
  'oczoom-dialog-preview.html'
)
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--light') dark = false
  else if (process.argv[i] === '--out') out = path.resolve(process.argv[++i])
}

// ----------------------------------------------------------- minimal mocks
let nextId = 1
const windows = new Map()

class MockWebContents extends EventEmitter {
  constructor(id) {
    super()
    this.id = id
    this._factor = 1
    this._url = ''
  }
  getZoomFactor() {
    return this._factor
  }
  setZoomFactor(factor) {
    this._factor = factor
  }
  isDestroyed() {
    return false
  }
  getURL() {
    return this._url
  }
  executeJavaScript() {
    return Promise.resolve('')
  }
}

class MockWindow extends EventEmitter {
  constructor() {
    super()
    this.id = nextId++
    this._destroyed = false
    this.webContents = new MockWebContents(this.id * 10)
    windows.set(this.id, this)
  }
  isDestroyed() {
    return this._destroyed
  }
  isFocused() {
    return false
  }
  focus() {}
  show() {}
  close() {
    this._destroyed = true
  }
  setMenuBarVisibility() {}
  loadURL(url) {
    this.webContents._url = url
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
    return null
  }
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oczoom-preview-'))
fs.writeFileSync(
  path.join(userDataDir, 'oc-zoom.json'),
  JSON.stringify({ zoom: 1.2, step: 0.02 }) + '\n'
)

const app = Object.assign(new EventEmitter(), {
  getLocale: () => 'zh-CN',
  getPath: () => userDataDir
})
const electron = { app, BrowserWindow: MockBrowserWindow, nativeTheme: { shouldUseDarkColors: dark } }

const sdkStub = {
  MenubarItem: { kind: 'registry' },
  Ipc: { define: (spec) => ({ kind: 'ipc', id: spec.id, spec }) }
}

const menuItems = []
const abort = new AbortController()
const context = {
  id: 'oc.zoom',
  log: { write() {} },
  scope: { signal: abort.signal },
  add: (registry, item) => menuItems.push(item),
  provide() {}
}

const moduleObj = { exports: {} }
new Function('require', 'module', 'exports', source)(
  (name) => {
    if (name === 'electron') return electron
    if (name === 'node:fs') return fs
    if (name === 'node:path') return path
    if (name === '@opencode/gui-extensions/sdk/main') return sdkStub
    throw new Error(`unexpected require: ${name}`)
  },
  moduleObj,
  moduleObj.exports
)
moduleObj.exports.default(context)

// a main app window so the dialog has a parent and reads its zoom
const mainWin = new MockBrowserWindow()
mainWin.webContents._url = 'oc://renderer/index.html'
mainWin.webContents._factor = 1.2
app.emit('browser-window-created', {}, mainWin)

const dialogItem = menuItems.find((item) => item.id.endsWith('.dialog'))
dialogItem.run(mainWin)
const dialogWin = [...windows.values()].find((win) =>
  String(win.webContents._url).startsWith('data:text/html')
)
if (!dialogWin) {
  console.error('dialog window was not created')
  process.exit(1)
}

const url = dialogWin.webContents._url
const html = decodeURIComponent(url.slice(url.indexOf(',') + 1))
fs.writeFileSync(out, html, 'utf8')
console.log(`dialog preview written to: ${out}`)
abort.abort()
