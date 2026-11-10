// @ts-check
/**
 * 本机 CLI 的真实解析源（Windows 优先，其它平台降级到 PATH / npm 全局）。
 *
 * 为什么不是"查 PATH 就完了"（docs/audit/04-cli-matrix.md §1）：
 * - Codex 以 Windows 商店应用（ChatGPT 桌面版）安装，CLI 在
 *   `Program Files\WindowsApps\OpenAI.Codex_<版本>\app\resources\codex.exe`，
 *   `where codex` 与 `Get-Command codex` 都查不到
 * - 目录名带包版本号，应用一升级路径就整体变化 → 必须**运行时解析**，不能写死
 * - `Program Files\WindowsApps` 对本进程不可枚举（ACL），所以 Appx 源要走
 *   `Get-AppxPackage` 查询，而不是遍历目录
 *
 * 所有函数都接受注入的 `exists` / `run`，便于测试；不在这里做缓存（由 probe.js 管）。
 */
import { existsSync } from 'node:fs'
import { win32, posix, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'


/**
 * 按目标平台选路径工具，使 Windows 语义在任意宿主上都可复现（测试用）。
 * @param {{ pathImpl?: typeof win32, platform?: string }} deps
 */
function pickPath(deps) {
  const platform = deps.platform ?? process.platform
  return deps.pathImpl ?? (platform === 'win32' ? win32 : posix)
}

/** Windows 上按 PATHEXT 顺序尝试的扩展名。 */
const WIN_EXTS = ['.exe', '.cmd', '.bat', '']

/**
 * 运行一个可执行文件并收集输出（带超时与输出上限）。
 * `.cmd` / `.bat` 需要走 shell，`.exe` 直接 spawn。
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runCommand(file, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxBytes = opts.maxBytes ?? 64 * 1024
  const needsShell = /\.(cmd|bat)$/i.test(file)

  return new Promise((resolve) => {
    // Windows 上 .cmd/.bat 必须经 cmd.exe 执行；含空格的路径要整体加引号
    // （实测：`cmd /d /s /c ""C:\a b\x.cmd" --version"` 与不含空格时直接拼接都可）
    const command = needsShell
      ? {
          file: process.env.ComSpec || 'cmd.exe',
          args: [
            '/d',
            '/s',
            '/c',
            /\s/.test(file) ? `""${file}" ${args.join(' ')}"` : `${file} ${args.join(' ')}`,
          ],
        }
      : { file, args }

    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(command.file, command.args, {
        windowsHide: true,
        // 关闭 stdin：codex exec 在 stdin 未关时会尝试读取（04-cli-matrix §1 坑 1）
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      return
    }

    let stdout = ''
    let stderr = ''
    let done = false

    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程可能已退出 */
      }
      finish(124)
    }, timeoutMs)

    child.stdout?.on('data', (buf) => {
      if (stdout.length < maxBytes) stdout += buf.toString('utf8')
    })
    child.stderr?.on('data', (buf) => {
      if (stderr.length < maxBytes) stderr += buf.toString('utf8')
    })
    child.on('error', (err) => {
      stderr += err.message
      finish(127)
    })
    child.on('close', (code) => finish(code ?? 0))
  })
}

/**
 * PATH 解析：按 PATH 目录 × 扩展名顺序找第一个存在的文件。
 *
 * @param {{ exists?: (p: string) => boolean, pathEnv?: string, platform?: string }} [deps]
 * @returns {(spec: any) => Array<{ path: string, source: string }>}
 */
export function createPathResolver(deps = {}) {
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? ''
  const exts = platform === 'win32' ? WIN_EXTS : ['']
  const P = pickPath(deps)

  return (spec) => {
    /** @type {Array<{ path: string, source: string }>} */
    const out = []
    for (const dir of pathEnv.split(P.delimiter)) {
      if (!dir) continue
      for (const ext of exts) {
        const candidate = P.join(dir, spec.bin + ext)
        if (exists(candidate)) {
          out.push({ path: candidate, source: 'path' })
          break
        }
      }
    }
    return out
  }
}

/**
 * npm 全局解析：`%APPDATA%\npm\<bin>.cmd` 与 `<bin>`。
 * （本机 codebuddy 就在这里：C:\Users\<user>\AppData\Roaming\npm\codebuddy.cmd）
 *
 * @param {{ exists?: (p: string) => boolean, npmGlobalDir?: string, platform?: string }} [deps]
 */
export function createNpmGlobalResolver(deps = {}) {
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  const base = deps.npmGlobalDir ?? process.env.APPDATA
  const dir = base ? pickPath(deps).join(base, 'npm') : ''

  return (spec) => {
    if (!dir) return []
    const exts = platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
    const P = pickPath(deps)
    /** @type {Array<{ path: string, source: string }>} */
    const out = []
    for (const ext of exts) {
      const candidate = P.join(dir, spec.bin + ext)
      if (exists(candidate)) out.push({ path: candidate, source: 'npm-global' })
    }
    return out
  }
}

/**
 * 商店应用（Appx）解析：用 `Get-AppxPackage` 拿 InstallLocation，再拼包内相对路径。
 * 只对声明了 `appxPattern` 的 CLI 生效。
 *
 * @param {{ run?: (file: string, args: string[]) => Promise<{ code: number, stdout: string }>,
 *           exists?: (p: string) => boolean, platform?: string }} [deps]
 * @returns {(spec: any) => Promise<Array<{ path: string, source: string }>>}
 */
export function createAppxResolver(deps = {}) {
  const run = deps.run ?? runCommand
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform

  return async (spec) => {
    if (platform !== 'win32' || !spec.appxName) return []

    // 用 -Name 精确查询：全量枚举 Get-AppxPackage 要好几秒，且容易超时
    const query = `Get-AppxPackage -Name ${spec.appxName} | ForEach-Object { $_.InstallLocation }`
    const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query])
    if (res.code !== 0 || !res.stdout.trim()) return []

    /** @type {Array<{ path: string, source: string }>} */
    const out = []
    for (const line of res.stdout.split(/\r?\n/)) {
      const location = line.trim()
      if (!location || !isAbsolute(location)) continue
      // 排除同族但没有 CLI 的包（如 CodexPrimaryRuntime）
      const pkgName = location.split(/[\\/]/).pop() ?? ''
      if (spec.appxPattern && !spec.appxPattern.test(pkgName)) continue
      const candidate = pickPath(deps).join(location, ...spec.appxRelative)
      if (exists(candidate)) out.push({ path: candidate, source: 'appx' })
    }
    return out
  }
}

/**
 * 常见安装目录兜底（用户手装、非 npm 的发行版）。
 *
 * @param {{ exists?: (p: string) => boolean, env?: Record<string, string | undefined> }} [deps]
 */
export function createKnownDirResolver(deps = {}) {
  const exists = deps.exists ?? existsSync
  const env = deps.env ?? process.env
  const P = pickPath(deps)

  return (spec) => {
    /** @type {Array<{ path: string, source: string }>} */
    const out = []
    const dirs = [
      env.LOCALAPPDATA ? P.join(env.LOCALAPPDATA, 'Programs', spec.bin) : '',
      env.ProgramFiles ? P.join(env.ProgramFiles, spec.bin) : '',
      env['ProgramFiles(x86)'] ? P.join(env['ProgramFiles(x86)'], spec.bin) : '',
    ].filter(Boolean)

    for (const dir of dirs) {
      for (const ext of WIN_EXTS) {
        const candidate = P.join(dir, spec.bin + ext)
        if (exists(candidate)) {
          out.push({ path: candidate, source: 'known-dir' })
          break
        }
      }
    }
    return out
  }
}

/**
 * 组装一套默认解析器（顺序即优先级）。
 * @param {{ exists?: (p: string) => boolean, run?: (f: string, a: string[]) => Promise<any>, platform?: string }} [deps]
 */
export function createDefaultResolvers(deps = {}) {
  return [
    createPathResolver(deps),
    createAppxResolver(deps),
    createNpmGlobalResolver(deps),
    createKnownDirResolver(deps),
  ]
}
