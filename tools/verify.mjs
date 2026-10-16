#!/usr/bin/env node
// Verifies that the installed extension rows match the extension/ directory
// on disk (byte for byte), and shows basic metadata.
//
// Usage: node tools/verify.mjs [--user-data <dir>]

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXT_ID = 'oc.zoom'
const here = path.dirname(fileURLToPath(import.meta.url))
const extensionDir = path.resolve(here, '..', 'extension')

function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { userData: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user-data') {
      if (!argv[i + 1]) fail('--user-data 需要一个目录参数')
      args.userData = path.resolve(argv[++i])
    } else fail(`未知参数: ${argv[i]}`)
  }
  return args
}

function defaultUserDataDir() {
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) fail('未找到 %APPDATA%')
    return path.join(process.env.APPDATA, 'ai.opencode.desktop')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ai.opencode.desktop')
  }
  return path.join(os.homedir(), '.config', 'ai.opencode.desktop')
}

const args = parseArgs(process.argv.slice(2))
const userData = args.userData ? path.resolve(args.userData) : defaultUserDataDir()
const dbPath = path.join(userData, 'drafts.sqlite')
if (!fs.existsSync(dbPath)) fail(`找不到数据库文件 ${dbPath}`)

const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(dbPath, { readOnly: true })
let ok = true
try {
  const row = db.prepare('SELECT id, enabled, manifest, revision FROM extension WHERE id = ?').get(EXT_ID)
  if (!row) fail(`未安装("extension" 表中没有 ${EXT_ID})`)

  const manifest = JSON.parse(row.manifest)
  console.log(`扩展:      ${row.id}`)
  console.log(`enabled:   ${row.enabled === 1 ? 'yes' : 'NO'}`)
  console.log(`version:   ${manifest.version}`)
  console.log(`revision:  ${row.revision}`)
  console.log(`imports:   main=[${(manifest.imports?.main ?? []).join(', ')}]`)

  const rows = db
    .prepare('SELECT path, data FROM extension_file WHERE extension_id = ? ORDER BY path')
    .all(EXT_ID)
  console.log(`files:     ${rows.length}`)

  for (const fileRow of rows) {
    const diskPath = path.join(extensionDir, fileRow.path)
    if (!fs.existsSync(diskPath)) {
      console.log(`  ${fileRow.path}: 磁盘上不存在`)
      ok = false
      continue
    }
    const dbHash = crypto.createHash('sha256').update(fileRow.data).digest('hex')
    const diskHash = crypto.createHash('sha256').update(fs.readFileSync(diskPath)).digest('hex')
    const same = dbHash === diskHash
    console.log(`  ${fileRow.path}: ${fileRow.data.length} 字节 ${same ? '与磁盘一致' : '与磁盘不一致!'}`)
    if (!same) ok = false
  }

  // files on disk that are not installed (informational only)
  const installed = new Set(rows.map((fileRow) => fileRow.path))
  for (const name of fs.readdirSync(extensionDir)) {
    if (!installed.has(name)) console.log(`  (磁盘多出的文件未安装: ${name})`)
  }
} finally {
  db.close()
}

if (!ok) fail('校验失败:数据库中的内容与 extension/ 目录不一致,建议重跑 install.mjs')
console.log('\n✔ 校验通过(数据库内容与 extension/ 目录完全一致)')
