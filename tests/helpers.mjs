// @ts-check
/**
 * 测试共用的小工具：临时 git 仓库、git 命令、轮询。
 * 文件名不以 `.test.mjs` 结尾，不会被 scripts/run-tests.mjs 收集为测试。
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizedGitEnv } from '../src/worktree.js'

/**
 * 在 cwd 里执行 git，返回 stdout；非零退出抛错（带 stderr）。
 * @param {string} cwd
 * @param {...string} args
 * @returns {string}
 */
export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * 建一个真实的临时 git 仓库并提交初始文件。
 * @param {Record<string, string>} [files]
 * @returns {Promise<{ root: string, baseSha: string }>}
 */
export async function makeRepo(files = { 'a.txt': 'a\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'mt-git-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'meetingstone-test@example.invalid')
  git(root, 'config', 'user.name', 'MeetingStone Test')
  for (const [name, content] of Object.entries(files)) {
    const full = join(root, name)
    await writeFile(full, content, 'utf8')
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return { root, baseSha: git(root, 'rev-parse', 'HEAD').trim() }
}

/** 尽力删除临时仓库（Windows 下偶发占用，带重试）。 @param {string} root */
export async function removeRepo(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

/** @param {number} ms */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询直到 fn 返回真值或超时。
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {number} [timeoutMs]
 * @param {number} [intervalMs]
 * @returns {Promise<T>}
 */
export async function waitFor(fn, timeoutMs = 5000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await delay(intervalMs)
  }
  throw lastError ?? new Error(`waitFor 超时（${timeoutMs}ms）`)
}
