#!/usr/bin/env node
// Uninstaller for the oc.zoom GUI extension.
//
// Removes the extension's rows from the app database. After a full restart of
// OpenCode the View menu returns to its stock state and the zoom is no longer
// remembered. The configuration file (`oc-zoom.json` in the OpenCode data
// directory) is kept unless --purge is passed.
//
// Usage:
//   node tools/uninstall.mjs                 remove the extension
//   node tools/uninstall.mjs --purge         also delete oc-zoom.json
//   node tools/uninstall.mjs --user-data <dir>
//   node tools/uninstall.mjs --force         proceed even if the app is running

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXT_ID = 'oc.zoom'
const CONFIG_FILE_NAME = 'oc-zoom.json'

function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

function info(message) {
  console.log(`• ${message}`)
}

function parseArgs(argv) {
  const args = { purge: false, force: false, userData: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--purge') args.purge = true
    else if (arg === '--force') args.force = true
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node tools/uninstall.mjs [--purge] [--force] [--user-data <dir>]')
      process.exit(0)
    } else if (arg === '--user-data') {
      if (!argv[i + 1]) fail('--user-data 需要一个目录参数')
      args.userData = path.resolve(argv[++i])
    } else fail(`未知参数: ${arg}`)
  }
  return args
}

function defaultUserDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) fail('未找到 %APPDATA%,请用 --user-data 指定 OpenCode 数据目录')
    return path.join(appData, 'ai.opencode.desktop')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ai.opencode.desktop')
  }
  return path.join(os.homedir(), '.config', 'ai.opencode.desktop')
}

function isAppRunning() {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq OpenCode.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000
    })
    return /opencode\.exe/i.test(out)
  } catch {
    return false
  }
}

const major = Number(process.versions.node.split('.')[0])
if (Number.isNaN(major) || major < 23) {
  fail(`需要 Node.js >= 23(当前 ${process.versions.node})`)
}

const args = parseArgs(process.argv.slice(2))
const userData = args.userData ? path.resolve(args.userData) : defaultUserDataDir()
const dbPath = path.join(userData, 'drafts.sqlite')

info(`OpenCode 数据目录: ${userData}`)
if (!fs.existsSync(dbPath)) fail(`找不到数据库文件 ${dbPath}`)

if (isAppRunning() && !args.force) {
  console.log('\n⚠ OpenCode 正在运行。卸载会立即写入数据库,但要等完全重启后才生效。\n')
}

const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(dbPath)
try {
  db.exec('PRAGMA busy_timeout = 10000')

  const existing = db.prepare('SELECT id FROM extension WHERE id = ?').get(EXT_ID)
  if (!existing) {
    info('未安装,无需卸载')
  } else {
    db.exec('BEGIN IMMEDIATE')
    try {
      const files = db.prepare('DELETE FROM extension_file WHERE extension_id = ?').run(EXT_ID)
      const ext = db.prepare('DELETE FROM extension WHERE id = ?').run(EXT_ID)
      db.exec('COMMIT')
      console.log('\n✔ 卸载完成')
      console.log(`  删除 extension 行:      ${ext.changes}`)
      console.log(`  删除 extension_file 行: ${files.changes}`)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      fail(`卸载失败(已回滚): ${error.message}`)
    }
  }
} finally {
  db.close()
}

const configPath = path.join(userData, CONFIG_FILE_NAME)
if (args.purge) {
  if (fs.existsSync(configPath)) {
    fs.rmSync(configPath)
    info(`已删除配置: ${configPath}`)
  }
} else if (fs.existsSync(configPath)) {
  info(`配置保留在: ${configPath}(如需删除,加 --purge 重跑)`)
}

console.log('\n完全退出并重新打开 OpenCode 后生效。')
