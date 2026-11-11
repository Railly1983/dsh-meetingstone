// @ts-check
/**
 * P0-1 命名清洗单测。
 *
 * 覆盖验收点：
 * - Markdown 符号剥离（`* _ # ` [ ] ( )` 等）
 * - `meetingstone:` 内部前缀与 `任务：` / `Task:` 正文标签剥离
 * - 任务摘要按码点截到 ≤14 字（含省略号），英文/数字保留
 * - 空任务回退「未命名任务」、空角色回退「未知角色」
 * - TaskSpec.title 优先于任务正文
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTaskLabel,
  clipChars,
  LABEL_SEPARATOR,
  roleShortName,
  stripMarkdown,
  taskShortTitle,
  TASK_TITLE_MAX_CHARS,
  UNKNOWN_ROLE_NAME,
  UNKNOWN_TASK_TITLE,
} from '../src/naming.js'

test('stripMarkdown：去掉 Markdown 符号、内部前缀与正文标签', () => {
  assert.equal(
    stripMarkdown('meetingstone:**修复** [F1](https://example.com) `code` # 标题'),
    '修复 F1 code 标题',
  )
  assert.equal(stripMarkdown('任务：**修复 F1–F8** (证据：日志)'), '修复 F1–F8 证据：日志')
  assert.equal(stripMarkdown('Task: **fix** the `login` flow'), 'fix the login flow')
  assert.equal(stripMarkdown('> 引用\n> - 列表项'), '引用 列表项')
  assert.equal(stripMarkdown('***'), '')
  assert.equal(stripMarkdown(undefined), '')
})

test('stripMarkdown：保留英文、数字与任务中的连字符/斜杠', () => {
  assert.equal(stripMarkdown('fix P0-D/C 去重 v2'), 'fix P0-D/C 去重 v2')
  assert.equal(stripMarkdown('F1–F8 与 429 重试'), 'F1–F8 与 429 重试')
})

test('taskShortTitle：码点截断到 ≤14 字，超长以省略号收尾', () => {
  const title = taskShortTitle('一'.repeat(100))
  assert.equal(Array.from(title).length, TASK_TITLE_MAX_CHARS)
  assert.equal(TASK_TITLE_MAX_CHARS, 14)
  assert.ok(title.endsWith('…'))

  // 恰好 14 字不截断
  assert.equal(taskShortTitle('一二三四五六七八九十一二三四'), '一二三四五六七八九十一二三四')
  // 15 字 -> 13 字 + 省略号
  const clipped = taskShortTitle('一二三四五六七八九十一二三四五')
  assert.equal(Array.from(clipped).length, 14)
  assert.ok(clipped.endsWith('…'))
})

test('taskShortTitle：TaskSpec.title 优先，任务正文只取首个有效行', () => {
  assert.equal(taskShortTitle('很长的任务正文……', { title: '**短标题**' }), '短标题')
  assert.equal(taskShortTitle('第一行目标\n第二行细节'), '第一行目标')
  assert.equal(taskShortTitle('\n\n# 有效标题\n正文'), '有效标题')
})

test('taskShortTitle：空任务 / 只有 Markdown 符号时回退「未命名任务」', () => {
  assert.equal(taskShortTitle(''), UNKNOWN_TASK_TITLE)
  assert.equal(taskShortTitle('***__``'), UNKNOWN_TASK_TITLE)
  assert.equal(taskShortTitle('', { title: '**' }), UNKNOWN_TASK_TITLE)
  assert.equal(taskShortTitle(null), UNKNOWN_TASK_TITLE)
  assert.equal(taskShortTitle({ not: 'a string' }), UNKNOWN_TASK_TITLE)
})

test('roleShortName：优先角色名，其次 roleId；空角色回退「未知角色」', () => {
  assert.equal(roleShortName({ name: '**沙僧**', roleId: 'role-sashi' }), '沙僧')
  assert.equal(roleShortName({ name: '', roleId: 'role-selftest' }), 'selftest')
  assert.equal(roleShortName({ roleId: 'meetingstone:role-selftest' }), 'selftest')
  assert.equal(roleShortName({}), UNKNOWN_ROLE_NAME)
})

test('buildTaskLabel：统一为「角色简称 · 简短目标（≤14 字）」且不含 Markdown', () => {
  const label = buildTaskLabel({ name: '沙僧' }, '任务：**修复 F1–F8** (证据：日志)')
  assert.equal(label, `沙僧${LABEL_SEPARATOR}修复 F1–F8 证据：日志`)
  assert.doesNotMatch(label, /[*_#`[\](){}<>|~\\]/)

  // 英文 / 数字原样保留
  assert.equal(
    buildTaskLabel({ name: '小白' }, 'fix P0-D 去重 v2'),
    '小白 · fix P0-D 去重 v2',
  )

  // 未知任务回退
  assert.equal(buildTaskLabel({ name: '悟空' }, ''), '悟空 · 未命名任务')

  // 角色缺失时也不产生空标签
  assert.equal(buildTaskLabel({}, '改个函数'), '未知角色 · 改个函数')
})

test('clipChars：非法 max 回退到默认上限，不影响正常截断', () => {
  assert.equal(clipChars('一二三', 0), '一二三')
  assert.equal(clipChars('一二三四五六七八九十一二三四五', 5), '一二三四…')
})
