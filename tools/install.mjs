#!/usr/bin/env node
// Installer for the oc.zoom GUI extension (OpenCode Desktop V2).
//
// The packaged desktop app intentionally hides its extension-management API
// (`ExtensionInstall` etc. throw "unavailable" when the app is packaged), so
// there is no in-app button to install a GUI extension. This script performs
// the exact same persistent write that the app's own installer would do: it
// stores the extension manifest and files in the app's SQLite database
// (`drafts.sqlite`, tables `extension` + `extension_file`).
//
// Safety measures:
//   - refuses to run if the tables are missing (schema changed → upgrade this
//     script instead of guessing)
//   - checkpoints the WAL and writes a timestamped backup next to the database
//   - performs a single transaction, so a failure leaves the DB untouched
//
// Usage:
//   node tools/install.mjs                 install for the current user
//   node tools/install.mjs --dry-run       validate everything, write nothing
//   node tools/install.mjs --user-data <dir>   use a custom data directory
//   node tools/install.mjs --force         proceed even if the app is running
//
// Requires Node.js >= 23 (uses the built-in `node:sqlite` module).

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXT_ID = 'oc.zoom'
const here = path.dirname(fileURLToPath(import.meta.url))
const extensionDir = path.resolve(here, '..', 'extension')

// ----------------------------------------------------------------- helpers
function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

function info(message) {
  console.log(`• ${message}`)
}

function parseArgs(argv) {
  const args = { dryRun: false, force: false, userData: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--force') args.force = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--user-data') {
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

function assertNodeVersion() {
  const major = Number(process.versions.node.split('.')[0])
  if (Number.isNaN(major) || major < 23) {
    fail(`需要 Node.js >= 23(当前 ${process.versions.node});内置的 node:sqlite 模块在 23 之前不可用`)
  }
}

// --------------------------------------------------------------- extension
function readExtension() {
  const manifestPath = path.join(extensionDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) fail(`找不到扩展清单: ${manifestPath}`)

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`manifest.json 不是合法 JSON: ${error.message}`)
  }

  // mirror the checks the app performs when it loads a manifest
  if (manifest.schema !== 'opencode.gui-extension/1') fail('manifest.schema 必须是 "opencode.gui-extension/1"')
  if (manifest.id !== EXT_ID) fail(`manifest.id 必须是 "${EXT_ID}"(当前 "${manifest.id}")`)
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) fail('manifest.id 不满足格式要求')
  if (typeof manifest.name !== 'string') fail('manifest.name 缺失')
  if (typeof manifest.version !== 'string') fail('manifest.version 缺失')
  if (typeof manifest.renderer !== 'string') fail('manifest.renderer 缺失(必需字段)')

  const files = []
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) files.push({ path: rel, data: fs.readFileSync(full) })
    }
  }
  walk(extensionDir, '')

  const paths = new Set(files.map((file) => file.path))
  for (const key of ['renderer', 'main', 'style']) {
    const value = manifest[key]
    if (value !== undefined && !paths.has(value)) fail(`manifest.${key} 指向的文件不存在: ${value}`)
  }
  if (!paths.has('manifest.json')) fail('扩展目录里缺少 manifest.json')
  if (files.some((file) => file.path.includes('\\'))) fail('文件路径中不允许反斜杠')

  return { manifest, files }
}

// --------------------------------------------------------------------- run
assertNodeVersion()
const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`用法: node tools/install.mjs [--dry-run] [--force] [--user-data <dir>]

把 oc.zoom 扩展安装到 OpenCode 桌面版(写入其 SQLite 数据库)。
安装完成后需要完全退出并重新打开 OpenCode 才能生效。`)
  process.exit(0)
}

info(`Node ${process.versions.node} / ${process.platform}`)

const userData = args.userData ? path.resolve(args.userData) : defaultUserDataDir()
const dbPath = path.join(userData, 'drafts.sqlite')
info(`OpenCode 数据目录: ${userData}`)
if (!fs.existsSync(dbPath)) {
  fail(`找不到数据库文件 ${dbPath}\n  请确认路径是否正确,或用 --user-data 指定目录。`)
}

const { manifest, files } = readExtension()
info(`扩展: ${manifest.id} v${manifest.version}(${files.length} 个文件)`)

const running = isAppRunning()
if (running && !args.force) {
  console.log(
    '\n⚠ OpenCode 正在运行。数据库支持并发写入,安装本身是安全的,\n' +
      '  但扩展要等完全退出并重新打开 OpenCode 后才会加载。\n'
  )
}

const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(dbPath)
try {
  db.exec('PRAGMA busy_timeout = 10000')

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
  for (const required of ['extension', 'extension_file']) {
    if (!tables.includes(required)) {
      fail(`数据库里没有表 "${required}" —— 应用版本可能更新了存储结构,请升级此脚本后再试。`)
    }
  }

  const existing = db.prepare('SELECT id, enabled, revision FROM extension WHERE id = ?').get(EXT_ID)
  if (existing) info(`检测到已安装的版本(revision ${existing.revision ?? 'n/a'})，将覆盖更新`)
  else info('未检测到旧版本，全新安装')

  if (args.dryRun) {
    console.log('\n[dry-run] 校验通过，未写入任何内容。将要写入:')
    console.log(`  extension:      id=${EXT_ID} enabled=1 manifest=${JSON.stringify(manifest).length} 字节`)
    console.log(`  extension_file: ${files.map((file) => file.path).join(', ')}`)
    process.exitCode = 0
  } else {
    // checkpoint + backup so a pre-change snapshot always exists
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* checkpoint is best effort */
    }
    const backupPath = `${dbPath}.bak-oczoom-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(dbPath, backupPath)
    info(`已备份数据库: ${backupPath}`)

    const revision = crypto.randomUUID()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `INSERT INTO extension (id, enabled, manifest, revision) VALUES (?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest, revision = excluded.revision`
      ).run(EXT_ID, JSON.stringify(manifest), revision)

      db.prepare('DELETE FROM extension_file WHERE extension_id = ?').run(EXT_ID)
      const insertFile = db.prepare('INSERT INTO extension_file (extension_id, path, data) VALUES (?, ?, ?)')
      for (const file of files) insertFile.run(EXT_ID, file.path, file.data)

      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      fail(`写入数据库失败(已回滚): ${error.message}`)
    }

    const row = db.prepare('SELECT id, enabled, length(manifest) AS manifest_bytes FROM extension WHERE id = ?').get(EXT_ID)
    const fileRows = db
      .prepare('SELECT path, length(data) AS bytes FROM extension_file WHERE extension_id = ? ORDER BY path')
      .all(EXT_ID)

    console.log('\n✔ 安装完成')
    console.log(`  扩展:   ${row.id}(enabled=${row.enabled}，revision ${revision})`)
    for (const fileRow of fileRows) {
      console.log(`  文件:   ${fileRow.path}(${fileRow.bytes} 字节)`)
    }
    console.log(`  备份:   ${backupPath}`)
    console.log('\n下一步:完全退出 OpenCode(包括托盘图标)→ 重新打开。')
    console.log('打开后,View 菜单里会多出「缩放设置」这一项,')
    console.log('窗口缩放会自动恢复上次的设置。')
  }
} finally {
  db.close()
}
