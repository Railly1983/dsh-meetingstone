// @ts-check
/**
 * 工作树隔离（src/worktree.js）的真实 git 测试。
 *
 * 全部使用临时仓库 + 真实 `git init/add/commit/worktree`；超时用假 gitRunner 注入，
 * 避免测试真的等 30 秒。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  createDispatchWorktree,
  computeChangedFiles,
  sanitizedGitEnv,
  WORKTREE_ERRORS,
  WORKTREE_RELATIVE_DIR,
} from '../src/worktree.js'
import { git, makeRepo, removeRepo } from './helpers.mjs'

/** Windows 路径比较：大小写不敏感；同时解析 symlink/junction。 */
function samePath(a, b) {
  const left = realpathSync(resolve(a))
  const right = realpathSync(resolve(b))
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/** @param {unknown} err @param {string} code */
function hasCode(err, code) {
  return Boolean(err && typeof err === 'object' && /** @type {any} */ (err).code === code)
}

test('建树成功：路径/分支/baseSha/repositoryRoot 正确，文件已检出', async () => {
  const { root, baseSha } = await makeRepo({ 'a.txt': 'a\n', 'old.txt': 'old\n' })
  try {
    const wt = await createDispatchWorktree({ projectRoot: root, operationId: 'op-success' })
    assert.equal(wt.operationId, 'op-success')
    assert.equal(wt.branch, 'meetingstone/op-success')
    assert.equal(wt.baseSha, baseSha)
    assert.ok(samePath(wt.repositoryRoot, root), `repositoryRoot 应为 ${root}，实际 ${wt.repositoryRoot}`)
    assert.ok(
      samePath(wt.path, join(root, WORKTREE_RELATIVE_DIR, 'op-success')),
      `工作树路径应在项目内：${wt.path}`,
    )
    assert.equal(existsSync(join(wt.path, 'a.txt')), true, '已提交文件应被检出')
    assert.match(git(root, 'branch', '--list', 'meetingstone/op-success'), /meetingstone\/op-success/)
    assert.match(git(root, 'worktree', 'list', '--porcelain'), /op-success/)
  } finally {
    await removeRepo(root)
  }
})

test('路径冲突：同一 operationId 第二次建树失败，不覆盖', async () => {
  const { root } = await makeRepo()
  try {
    await createDispatchWorktree({ projectRoot: root, operationId: 'op-dup' })
    await assert.rejects(
      () => createDispatchWorktree({ projectRoot: root, operationId: 'op-dup' }),
      (err) => hasCode(err, WORKTREE_ERRORS.PATH_EXISTS),
    )
    // 原工作树内容没有被破坏
    assert.equal(existsSync(join(root, WORKTREE_RELATIVE_DIR, 'op-dup', 'a.txt')), true)
  } finally {
    await removeRepo(root)
  }
})

test('分支冲突：分支已存在时失败，不复用/不覆盖', async () => {
  const { root } = await makeRepo()
  try {
    git(root, 'branch', 'meetingstone/op-branch')
    await assert.rejects(
      () => createDispatchWorktree({ projectRoot: root, operationId: 'op-branch' }),
      (err) => hasCode(err, WORKTREE_ERRORS.BRANCH_EXISTS),
    )
    assert.equal(existsSync(join(root, WORKTREE_RELATIVE_DIR, 'op-branch')), false)
  } finally {
    await removeRepo(root)
  }
})

test('非 git 目录：失败关闭，错误码可诊断', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-not-git-'))
  try {
    await assert.rejects(
      () => createDispatchWorktree({ projectRoot: root, operationId: 'op-nogit' }),
      (err) => hasCode(err, WORKTREE_ERRORS.NOT_GIT_REPOSITORY),
    )
    assert.equal(existsSync(join(root, WORKTREE_RELATIVE_DIR, 'op-nogit')), false)
  } finally {
    await removeRepo(root)
  }
})

test('base 无效：WORKTREE_BASE_INVALID，且不建树', async () => {
  const { root } = await makeRepo()
  try {
    await assert.rejects(
      () =>
        createDispatchWorktree({
          projectRoot: root,
          operationId: 'op-bad-base',
          base: 'no-such-ref',
        }),
      (err) => hasCode(err, WORKTREE_ERRORS.BASE_INVALID),
    )
    assert.equal(existsSync(join(root, WORKTREE_RELATIVE_DIR, 'op-bad-base')), false)
  } finally {
    await removeRepo(root)
  }
})

test('git 超时：WORKTREE_TIMEOUT（假 gitRunner 注入，不等 30 秒）', async () => {
  const { root } = await makeRepo()
  try {
    const runner = async () => ({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    })
    await assert.rejects(
      () =>
        createDispatchWorktree({
          projectRoot: root,
          operationId: 'op-timeout',
          gitRunner: runner,
        }),
      (err) => hasCode(err, WORKTREE_ERRORS.TIMEOUT),
    )
  } finally {
    await removeRepo(root)
  }
})

test('operationId 越界（../）被拒绝：WORKTREE_PATH_OUTSIDE', async () => {
  const { root } = await makeRepo()
  try {
    for (const operationId of ['../evil', 'a/b', '', '.hidden']) {
      await assert.rejects(
        () => createDispatchWorktree({ projectRoot: root, operationId }),
        (err) => hasCode(err, WORKTREE_ERRORS.PATH_OUTSIDE),
        `应拒绝 operationId=${JSON.stringify(operationId)}`,
      )
    }
  } finally {
    await removeRepo(root)
  }
})

test('并发建树：同一仓库两个不同 operationId 都成功（进程内锁不误伤）', async () => {
  const { root } = await makeRepo()
  try {
    const [a, b] = await Promise.all([
      createDispatchWorktree({ projectRoot: root, operationId: 'op-concurrent-a' }),
      createDispatchWorktree({ projectRoot: root, operationId: 'op-concurrent-b' }),
    ])
    assert.equal(existsSync(join(a.path, 'a.txt')), true)
    assert.equal(existsSync(join(b.path, 'a.txt')), true)
    const list = git(root, 'worktree', 'list', '--porcelain')
    assert.match(list, /op-concurrent-a/)
    assert.match(list, /op-concurrent-b/)
  } finally {
    await removeRepo(root)
  }
})

test('computeChangedFiles：已提交/暂存/未暂存/未跟踪/重命名（新旧路径）全部覆盖', async () => {
  const { root, baseSha } = await makeRepo({
    'tracked.txt': 'one\n',
    'old.txt': 'old\n',
  })
  try {
    const wt = await createDispatchWorktree({ projectRoot: root, operationId: 'op-changes' })
    const cwd = wt.path

    // 未暂存修改
    await writeFile(join(cwd, 'tracked.txt'), 'two\n', 'utf8')
    // 暂存新增
    await writeFile(join(cwd, 'staged.txt'), 'staged\n', 'utf8')
    git(cwd, 'add', 'staged.txt')
    // 未跟踪
    await writeFile(join(cwd, 'untracked.txt'), 'untracked\n', 'utf8')
    // 重命名（暂存）
    git(cwd, 'mv', 'old.txt', 'renamed.txt')
    // 已提交改动
    await writeFile(join(cwd, 'committed.txt'), 'committed\n', 'utf8')
    git(cwd, 'add', 'committed.txt')
    git(cwd, 'commit', '-q', '-m', 'committed change')

    const result = await computeChangedFiles(cwd, baseSha)
    assert.equal(result.unknown, false, `不应未知：${JSON.stringify(result)}`)
    const files = new Set(/** @type {string[]} */ (result.files))
    for (const expected of [
      'tracked.txt',
      'staged.txt',
      'untracked.txt',
      'old.txt',
      'renamed.txt',
      'committed.txt',
    ]) {
      assert.ok(files.has(expected), `缺少 ${expected}，实际 ${JSON.stringify([...files])}`)
    }
  } finally {
    await removeRepo(root)
  }
})

test('computeChangedFiles：失败返回 unknown，不伪装成"无改动"', async () => {
  const { root } = await makeRepo()
  try {
    const wt = await createDispatchWorktree({ projectRoot: root, operationId: 'op-unknown' })
    const badBase = await computeChangedFiles(wt.path, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    assert.equal(badBase.unknown, true)
    assert.ok(badBase.unknown && badBase.reason)

    const notGit = await mkdtemp(join(tmpdir(), 'mt-changes-nogit-'))
    try {
      const res = await computeChangedFiles(notGit, 'HEAD')
      assert.equal(res.unknown, true)
      assert.ok(res.unknown && res.reason)
    } finally {
      await removeRepo(notGit)
    }
  } finally {
    await removeRepo(root)
  }
})

test('sanitizedGitEnv：清掉所有 GIT_* 并强制 GIT_TERMINAL_PROMPT=0', () => {
  const env = sanitizedGitEnv({
    PATH: '/bin',
    GIT_DIR: '/evil',
    GIT_WORK_TREE: '/evil-work',
    git_askpass: '/evil-askpass',
    GIT_TERMINAL_PROMPT: '1',
    HOME: '/home/user',
  })
  assert.equal(env.PATH, '/bin')
  assert.equal(env.HOME, '/home/user')
  assert.equal(env.GIT_DIR, undefined)
  assert.equal(env.GIT_WORK_TREE, undefined)
  assert.equal(env.git_askpass, undefined)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
})

test('工作树不复制未跟踪/忽略文件（文档承诺的行为）', async () => {
  const { root } = await makeRepo({ 'a.txt': 'a\n', '.gitignore': 'ignored.txt\n' })
  try {
    await writeFile(join(root, 'ignored.txt'), 'local\n', 'utf8')
    const wt = await createDispatchWorktree({ projectRoot: root, operationId: 'op-no-copy' })
    assert.equal(existsSync(join(wt.path, 'a.txt')), true)
    assert.equal(existsSync(join(wt.path, 'ignored.txt')), false, '未跟踪/忽略文件不应出现在工作树')
    // 主工作区文件没被改动
    assert.equal(await readFile(join(root, 'ignored.txt'), 'utf8'), 'local\n')
  } finally {
    await removeRepo(root)
  }
})
