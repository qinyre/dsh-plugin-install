/**
 * Standalone self-restart: hand the process over to a detached relay that
 * outlives us, waits for the old process to release the port, and re-runs
 * the exact invocation that booted this host. Desktop never uses this — the
 * sidecar is supervised by the shell, and a raw re-exec would orphan it.
 *
 * The successor's home depends on how this host was launched. A host with a
 * terminal restarts into that same terminal: the relay is spawned with the
 * old process's stdio (the original console's handles) and hands them to the
 * successor, so its output keeps flowing into the original window — no
 * second terminal is opened. A piped host (desktop-style service launchers)
 * takes the hidden detached path as before.
 *
 * Why the successor is spawned detached even so: on machines whose process
 * governance kills non-detached children when their parent exits (verified
 * in isolation, plain console, no dsh involved), nothing spawned by the old
 * process survives its death unless detached — but a relay descendant does,
 * which is why the relay sits in between. Console handles keep working
 * across detachment (the shell still owns the window), but the successor is
 * never ATTACHED, so Ctrl+C in the window reaches the waiting shell instead;
 * closing the window — or killing the pid — is what stops the successor.
 */

import { spawn } from 'node:child_process'
import { appendFileSync as writeFileAppending } from 'node:fs'

/**
 * The relay program: wait until the old process is truly gone (a heavy
 * profile disposes for seconds — a fixed sleep raced its port release and
 * killed the successor with EADDRINUSE), pause briefly for socket teardown,
 * then re-launch the recorded argv. The command travels through the
 * environment so no user-controlled text ever reaches a command line.
 */
const RELAY_PROGRAM = `
const { spawn } = require('node:child_process')
const dbg = process.env.DSH_RESTART_DEBUG
const trace = (m) => { if (dbg) { try { require('node:fs').appendFileSync(dbg, Date.now() + ' ' + m + '\\n') } catch {} } }
process.on('uncaughtException', (e) => { trace('UNCAUGHT ' + (e && e.stack || e)); process.exit(1) })
const argv = JSON.parse(process.env.DSH_RESTART_ARGV || '[]')
const cwd = process.env.DSH_RESTART_CWD || undefined
const parent = Number(process.env.DSH_RESTART_PARENT_PID || 0)
let waited = 0
trace('relay start attach=' + (process.env.DSH_RESTART_ATTACH === '1' ? 'same-console' : 'detached') + ' parent=' + parent)
const launch = () => {
  setTimeout(() => {
    if (argv.length === 0) process.exit(1)
    // The console window is a Windows construct; elsewhere (or if the host
    // was piped) the successor takes the hidden detached path.
    if (process.platform === 'win32' && process.env.DSH_RESTART_ATTACH === '1') {
      // Same-terminal restart: this relay was spawned with the old process's
      // stdio — the original console's handles — and the successor inherits
      // them in turn, so its output lands in the original window instead of
      // a second terminal. Detached keeps the governance kill at old-process
      // exit from reaching it; the handles stay writable because the shell
      // still owns the console. Direct spawn (no start command, no batch
      // files): spawn passes argv natively, which is exactly what the old
      // window path's cmd quoting dance worked around.
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'inherit', cwd })
      child.unref()
      trace('same-console successor pid=' + child.pid)
      process.exit(child.pid === undefined ? 1 : 0)
    }
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, cwd })
    child.unref()
    trace('detached successor pid=' + child.pid)
    process.exit(child.pid === undefined ? 1 : 0)
  }, 250)
}
if (!parent) { launch() } else {
  const tick = () => {
    let alive = true
    try { process.kill(parent, 0) } catch (error) { alive = error.code !== 'ESRCH' }
    if (!alive || (waited += 100) >= 7000) { trace('parent gone (alive=' + alive + ')'); launch() } else { setTimeout(tick, 100) }
  }
  tick()
}
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
 * disposes the tree (bounded by its own shutdown controller) before exiting;
 * the detached relay outlives every possible exit timing.
 */
export function scheduleSelfRestart(): void {
  if (!canSelfRestart()) return
  const attached = process.stdout?.isTTY === true || process.stdin?.isTTY === true
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_RESTART_ARGV: JSON.stringify([process.execPath, ...process.execArgv, ...process.argv.slice(1)]),
    DSH_RESTART_CWD: process.cwd(),
    DSH_RESTART_PARENT_PID: String(process.pid),
  }
  if (attached) env.DSH_RESTART_ATTACH = '1'
  const debug = process.env.DSH_RESTART_DEBUG
  const trace = (message: string): void => {
    if (debug === undefined) return
    try { writeFileAppending(debug, `${Date.now()} [old ${process.pid}] ${message}\n`) } catch { /* tracing owns nothing */ }
  }
  trace(`scheduling restart attached=${attached} argv=${env.DSH_RESTART_ARGV}`)
  // stdio inherit is load-bearing in attach mode: the relay must hold the
  // original console's handles or the successor has nothing to inherit.
  const relay = spawn(process.execPath, ['-e', RELAY_PROGRAM], {
    detached: true,
    stdio: 'inherit',
    windowsHide: true,
    env,
  })
  relay.unref()
  trace(`relay spawn pid=${relay.pid ?? 'none'}`)
  relay.on('error', (error: Error) => trace(`relay error ${String(error)}`))
  // Real signals with no listener would terminate the process; a synthetic
  // emit with none just returns false — exit at once instead of idling out.
  if (!process.emit('SIGTERM')) { trace('no SIGTERM listener, exiting'); process.exit(0) }
  trace('SIGTERM dispatched to dispose listeners')
}
