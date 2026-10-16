/**
 * Plugin command execution: route to the desktop bridge when running inside
 * DSH Desktop, otherwise re-invoke the dsh CLI so pnpm resolution stays the
 * CLI's own (its `plugin` forwarder spawns pnpm with shell:true on win32).
 */

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { InstallProgress, InstallResult, SPEC_RE, MAX_SPEC_LENGTH } from './types.ts'

/** True when this host runs inside DSH Desktop's sidecar (the client env). */
export function inDesktop(): boolean {
  return process.env.DSH_DESKTOP === '1'
}

/** How the dsh CLI should be invoked for plugin commands. */
export interface DshArgv {
  file: string
  args: string[]
  cwd: string | undefined
  viaShell: boolean
  /** Extra environment (Electron-as-Node when reusing the host executable). */
  env?: NodeJS.ProcessEnv
}

export interface DshArgvOptions {
  argv?: readonly string[]
  execPath?: string
  execArgv?: readonly string[]
  exists?: (path: string) => boolean
}

/** The CLI entry the scan below resolved, with how it will be invoked. */
interface CliAnchor {
  entry: string
  /** The desktop's own CLI entry (bundled pnpm, --expose-internals). */
  desktop: boolean
  /** argv named the entry outright — the host re-runs it as itself. */
  direct: boolean
}

/**
 * Locate the dsh CLI entry this host booted from — a plain install's bin.js
 * on argv, or (for the desktop launch, whose argv carries Electron switches
 * before the host script and never names the CLI) the desktop's own entry
 * next to the runtime the host script lives in. The entry anchors resolution
 * of runtime packages (@deepseek-ai/dsh-app-boot) that live in the dsh
 * installation tree, unreachable from a profile plugin's own module path.
 */
export function dshCliAnchor(options: DshArgvOptions = {}): CliAnchor | undefined {
  const argv = options.argv ?? process.argv
  const exists = options.exists ?? existsSync

  const direct = argv[1]
  if (direct !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(direct)) {
    return { entry: resolve(direct), desktop: false, direct: true }
  }

  for (const candidate of argv.slice(1)) {
    if (typeof candidate !== 'string' || !/\.[cm]?js$/.test(candidate) || !exists(candidate)) continue
    let dir = dirname(resolve(candidate))
    for (let depth = 0; depth < 6 && dir !== dirname(dir); depth++) {
      const scoped = join(dir, 'node_modules', '@deepseek-ai')
      // DSH Desktop ships its own CLI entry (the one runtime/cli/bin/dsh.cmd
      // invokes): it wires the bundled pnpm and node so plugin commands never
      // depend on the GUI PATH. Plain dsh installs only have bin.js.
      const desktopCli = join(scoped, 'dsh-desktop-host', 'lib', 'cli.js')
      const cliEntry = join(scoped, 'dsh', 'lib', 'bin.js')
      if (exists(desktopCli)) return { entry: desktopCli, desktop: true, direct: false }
      if (exists(cliEntry)) return { entry: cliEntry, desktop: false, direct: false }
      dir = dirname(dir)
    }
  }
  return undefined
}

/**
 * The dsh binary invocation that launched this host, so plugin commands work
 * whether dsh runs from a global bin, a local install, repo source — or the
 * desktop host. The desktop launch carries Electron switches before the host
 * script and never names the CLI, so the CLI entry is found relative to the
 * running runtime: the desktop's own entry when present (it injects the
 * bundled pnpm/node, exactly what runtime/cli/bin/dsh.cmd invokes), else a
 * dsh install's bin.js — both executed through Electron's executable as plain
 * Node with the child anchored at the executable's real directory (Windows
 * cannot chdir inside an asar, so an archive-derived cwd kills the spawn).
 * The GUI PATH never enters the picture. A bare `dsh` on the shell stays the
 * last resort.
 */
export function dshArgv(options: DshArgvOptions = {}): DshArgv {
  const execPath = options.execPath ?? process.execPath
  const execArgv = options.execArgv ?? process.execArgv

  const anchor = dshCliAnchor(options)
  if (anchor !== undefined) {
    if (anchor.direct) {
      return { file: execPath, args: [...execArgv, anchor.entry], cwd: dirname(anchor.entry), viaShell: false }
    }
    return anchor.desktop
      ? {
          file: execPath,
          args: [...execArgv, '--expose-internals', anchor.entry],
          cwd: dirname(execPath),
          viaShell: false,
          env: { ELECTRON_RUN_AS_NODE: '1' },
        }
      : {
          file: execPath,
          args: [...execArgv, anchor.entry],
          cwd: dirname(execPath),
          viaShell: false,
          env: { ELECTRON_RUN_AS_NODE: '1' },
        }
  }

  // Bare `dsh` is a .cmd shim on Windows; only a shell can start it.
  return { file: 'dsh', args: [], cwd: undefined, viaShell: process.platform === 'win32' }
}

/** Validate one install/uninstall target against the spec allowlist. */
export function validateSpec(spec: string): string | null {
  if (spec.length === 0 || spec.length > MAX_SPEC_LENGTH) return 'spec is empty or too long'
  if (spec.startsWith('-')) return 'spec must not start with "-" (argument injection)'
  if (!SPEC_RE.test(spec)) return `spec contains unsafe characters: ${JSON.stringify(spec)}`
  return null
}

/** Progress singleton; the status route reads it, runPlugin writes it. */
export const progress: InstallProgress = {
  active: false,
  target: '',
  startedAt: 0,
  lastLine: '',
  lastError: null,
  cancelling: false,
}

/** Kill a child and its whole tree: taskkill on Windows, SIGTERM→SIGKILL on POSIX. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      return
    } catch { /* fall through */ }
  }
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, signal) } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
  signalTree('SIGTERM')
  const escalate = setTimeout(() => signalTree('SIGKILL'), 5000)
  escalate.unref?.()
}

/** Cancel the plugin command currently running, if any. */
export function cancelActive(): boolean {
  if (activeChild === null) return false
  cancelRequested = true
  progress.cancelling = true
  killTree(activeChild)
  return true
}

/** The child of the operation currently running, for cancellation. */
let activeChild: ChildProcess | null = null
let cancelRequested = false

const INSTALL_TIMEOUT_MS = Number(process.env.DSH_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000

/**
 * Run one `dsh plugin --profile <profile> <args…>` command with a timeout and
 * live progress. Inside DSH Desktop the command is executed through the
 * desktop bridge (the sidecar's own Node, no system Node/pnpm required);
 * outside, the CLI is re-invoked exactly as it booted this host.
 */
export function runPlugin(profile: string, pluginArgs: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<InstallResult> {
  const target = pluginArgs[pluginArgs.length - 1] ?? ''
  const validation = validateSpec(target)
  if (validation !== null) {
    return Promise.resolve({ exitCode: 1, timedOut: false, stdout: '', stderr: validation, cancelled: false })
  }
  progress.active = true
  progress.target = target
  progress.startedAt = Date.now()
  progress.lastLine = ''
  progress.lastError = null
  progress.cancelling = false

  const { file, args, cwd, viaShell, env: spawnEnv } = dshArgv()
  const child = spawn(file, [...args, 'plugin', '--profile', profile, ...pluginArgs], {
    cwd: cwd ?? process.cwd(),
    env: spawnEnv === undefined ? opts.env ?? process.env : { ...(opts.env ?? process.env), ...spawnEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: viaShell,
    // The chain below re-runs cmd shims (`dsh`, then pnpm via the CLI's
    // shell:true forwarder). Without this flag each layer allocates a
    // visible console when the host has none to inherit — the flashing cmd
    // windows on standalone web. A hidden console here is inherited by the
    // whole subtree, so one flag covers every layer.
    windowsHide: true,
  })
  activeChild = child
  cancelRequested = false
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, INSTALL_TIMEOUT_MS)

  return new Promise<InstallResult>((resolvePromise) => {
    // Line-buffered progress: keep lastLine human, cap stdout/stderr tails.
    const feed = (text: string): void => {
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed !== '') progress.lastLine = trimmed.slice(0, 200)
      }
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue
      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        if (stream === child.stdout) stdout = (stdout + text).slice(-256 * 1024)
        else stderr = (stderr + text).slice(-64 * 1024)
        feed(text)
      })
    }
    // close (not exit): wait for stdio to drain so lastLine flushes fully.
    child.once('close', (code) => {
      clearTimeout(timer)
      progress.active = false
      progress.cancelling = false
      if (activeChild === child) activeChild = null
      if ((code !== 0 || timedOut) && stderr !== '') progress.lastError = stderr.slice(-500)
      resolvePromise({ exitCode: code, timedOut, stdout, stderr, cancelled: cancelRequested })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      progress.active = false
      progress.cancelling = false
      if (activeChild === child) activeChild = null
      progress.lastError = error.message
      resolvePromise({ exitCode: 127, timedOut: false, stdout, stderr: `${stderr}\n${error.message}`, cancelled: false })
    })
  })
}