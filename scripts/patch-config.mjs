/**
 * 保护 profile patch 里的 meetingstone 配置：plugin remove/add 有时会把
 * 该行的 config 清空（实测：安装 0.1.0-alpha.2 后 channels/roles 全丢）。
 *
 * 安全安装流程：安装前 snapshot → 安装后 restoreIfLost。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
export const PATCH_PATH = join(HOME, 'profiles', 'desktop', 'cordis.patch.yml')

export function readPatch() {
  return YAML.parse(readFileSync(PATCH_PATH, 'utf8'))
}

export function writePatch(doc) {
  copyFileSync(PATCH_PATH, `${PATCH_PATH}.bak-config-${Date.now()}`)
  writeFileSync(PATCH_PATH, YAML.stringify(doc), 'utf8')
}

export function meetingstoneRow(doc) {
  return doc.find((row) => row && row.id === 'meetingstone')
}

/** 快照 meetingstone 行 config 到 sidecar，返回快照。 */
export function snapshotConfig(file) {
  const doc = readPatch()
  const config = meetingstoneRow(doc)?.config ?? {}
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  return config
}

/**
 * 安装后若 config 丢失而快照非空，则写回；返回是否恢复。
 */
export function restoreIfLost(file) {
  if (!existsSync(file)) return false
  const snapshot = JSON.parse(readFileSync(file, 'utf8'))
  if (!snapshot || Object.keys(snapshot).length === 0) return false
  const doc = readPatch()
  const row = meetingstoneRow(doc)
  if (!row) return false
  const current = row.config ?? {}
  if (Object.keys(current).length > 0) return false
  row.config = snapshot
  writePatch(doc)
  return true
}
