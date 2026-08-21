/**
 * Standalone self-restart: hand the process over to a relay that outlives
 * us, waits past the shutdown, and re-runs the exact invocation that booted
 * this host. Desktop never uses this — the sidecar is supervised by the
 * shell, and a raw re-exec would orphan it.
 *
 * The relay has two modes. A host launched from an interactive terminal
 * hands the terminal down: relay and successor stay attached to the same
 * console, so the restarted dsh lives — and dies via Ctrl+C — in the window
 * it was started in, instead of escaping into a hidden orphan. A host
 * without a console (desktop-style pipes, service launchers) takes the
 * detached hidden path as before.
 */

import { spawn } from 'node:child_process'

/**
 * The relay program: sleep past the parent's shutdown, then re-launch the
 * recorded argv. The command travels through the environment so no
 * user-controlled text ever reaches a command line.
 */
const RELAY_PROGRAM = `
const { spawn } = require('node:child_process')
const argv = JSON.parse(process.env.DSH_RESTART_ARGV || '[]')
const cwd = process.env.DSH_RESTART_CWD || undefined
setTimeout(() => {
  if (argv.length === 0) process.exit(1)
  if (process.env.DSH_RESTART_ATTACH === '1') {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', cwd })
    child.on('exit', (code, signal) => process.exit(code ?? (signal != null ? 1 : 0)))
    child.on('error', () => process.exit(1))
    return
  }
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, cwd })
  child.unref()
  process.exit(child.pid === undefined ? 1 : 0)
}, 800)
`
export { RELAY_PROGRAM }

/**
 * True when this process knows how to re-launch itself: node must have a
 * script entry (argv[1]) to re-run. A host booted through exotic wrappers
 * (no argv[1]) reports false and the route answers not-supported instead of
 * exiting into nothing.
 */
export function canSelfRestart(): boolean {
  return process.argv.length >= 2 && typeof process.argv[1] === 'string' && process.argv[1] !== ''
}

/**
 * Spawn the relay and exit this process. Called only after the HTTP response
 * has flushed, so the browser already holds its `ok` before the port drops.
 *
 * Shutdown prefers the graceful path: profile-boot listens for SIGTERM and
 * disposes the tree (bounded at 5s by its own shutdown controller) before
 * exiting; a hard fallback exit covers a hung disposal so the relay's 800ms
 * window is never left waiting forever.
 */
export function scheduleSelfRestart(): void {
  if (!canSelfRestart()) return
  // Interactive console: the relay must inherit the real terminal handles
  // (a detached relay would carry nulls, and the successor's Ctrl+C would
  // never reach it), and must not detach, or the successor would grow up
  // outside the console entirely.
  const attached = process.stdout?.isTTY === true || process.stdin?.isTTY === true
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_RESTART_ARGV: JSON.stringify([process.execPath, ...process.execArgv, ...process.argv.slice(1)]),
    DSH_RESTART_CWD: process.cwd(),
  }
  if (attached) env.DSH_RESTART_ATTACH = '1'
  spawn(process.execPath, ['-e', RELAY_PROGRAM], {
    detached: !attached,
    stdio: attached ? 'inherit' : 'ignore',
    windowsHide: true,
    env,
  }).unref()
  setTimeout(() => process.exit(0), 8000).unref()
  // Real signals with no listener would terminate the process; a synthetic
  // emit with none just returns false — exit at once instead of idling out.
  if (!process.emit('SIGTERM')) process.exit(0)
}
