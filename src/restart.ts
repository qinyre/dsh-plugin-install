/**
 * Standalone self-restart: hand the process over to a detached relay that
 * outlives us, waits for the old process to release the port, and re-runs
 * the exact invocation that booted this host. Desktop never uses this — the
 * sidecar is supervised by the shell, and a raw re-exec would orphan it.
 *
 * The successor's home depends on how this host was launched. A host with a
 * terminal restarts into that same terminal via a PowerShell handover: a
 * console cannot travel across detachment (the relay must be detached to
 * survive — see below — and node gives a detached child broken stdio), so
 * the helper ATTACHES itself to the old process's still-live console with
 * AttachConsole, waits for the old process to exit, then starts the
 * successor with -NoNewWindow. Attached means real rendering AND Ctrl+C
 * reaching the successor. A piped host (desktop-style service launchers)
 * takes the hidden detached path as before.
 *
 * Why the indirection at all: on machines whose process governance kills
 * non-detached children when their parent exits (verified in isolation,
 * plain console, no dsh involved), nothing spawned by the old process
 * survives its death unless detached — so the detached relay sits between.
 * The PowerShell helper itself is spawned through conhost --headless:
 * powershell.exe is a console application and silently refuses to run with
 * no console at all, while windowsHide's CREATE_NO_WINDOW console would
 * make AttachConsole fail with "already attached" — FreeConsole first
 * handles that case too.
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
trace('relay start attach=' + (process.env.DSH_RESTART_ATTACH === '1' ? 'terminal-handover' : 'detached') + ' parent=' + parent)
// Same-terminal handover (Windows TTY hosts): the PowerShell helper must
// AttachConsole while the old process still owns its console, so it starts
// right now and does its own waiting; every other path keeps the fixed
// pause plus parent-gone poll below.
let handedOver = false
if (process.platform === 'win32' && process.env.DSH_RESTART_ATTACH === '1' && argv.length > 0) {
  try {
    const ps1 = require('node:path').join(require('node:os').tmpdir(), 'dsh-web-restart-' + Date.now() + '.ps1')
    const body = [
      '$ErrorActionPreference="Continue"',
      '$sig=\\'using System;using System.Runtime.InteropServices;public class K32{[DllImport("kernel32.dll",SetLastError=true)]public static extern bool AttachConsole(uint p);[DllImport("kernel32.dll")]public static extern bool FreeConsole();}\\'',
      'try{Add-Type -TypeDefinition $sig}catch{}',
      '$ok=$false',
      'try{$null=[K32]::FreeConsole();$ok=[K32]::AttachConsole([uint32]$env:DSH_RESTART_OLDPID)}catch{}',
      'if($env:DSH_RESTART_DEBUG){Add-Content -LiteralPath $env:DSH_RESTART_DEBUG -Value ("PS attach="+$ok)}',
      'while($true){try{Get-Process -Id ([int]$env:DSH_RESTART_OLDPID) -ErrorAction Stop|Out-Null;Start-Sleep -Milliseconds 100}catch{break}}',
      'Start-Sleep -Milliseconds 400',
      '$av=ConvertFrom-Json $env:DSH_RESTART_ARGV',
      '$rest=@();if($av.Count -gt 1){$rest=@($av[1..($av.Count-1)])}',
      '$p=Start-Process -FilePath $av[0] -ArgumentList $rest -WorkingDirectory $env:DSH_RESTART_CWD -NoNewWindow -PassThru',
      'if($env:DSH_RESTART_DEBUG){Add-Content -LiteralPath $env:DSH_RESTART_DEBUG -Value ("PS successor pid="+$p.Id)}',
    ].join('\\r\\n')
    require('node:fs').writeFileSync(ps1, body)
    // powershell.exe is a console app: fully detached it silently refuses to
    // run, windowsHide's CREATE_NO_WINDOW console makes AttachConsole fail
    // with "already attached" — a headless conhost gives it a disposable
    // console of its own that FreeConsole immediately gives up.
    const h = spawn('conhost.exe', ['--headless', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { detached: true, stdio: 'ignore' })
    h.unref()
    trace('handover helper spawned pid=' + h.pid)
    handedOver = true
  } catch (error) {
    trace('handover setup failed, falling back to hidden detached: ' + (error && error.stack || error))
  }
  if (handedOver) process.exit(0)
}
const launch = () => {
  setTimeout(() => {
    if (argv.length === 0) process.exit(1)
    // The console window is a Windows construct; elsewhere (or if the host
    // was piped, or the handover helper could not be started) the successor
    // takes the hidden detached path.
    if (process.platform === 'win32' && process.env.DSH_RESTART_ATTACH === '1') {
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', cwd })
      child.unref()
      trace('fallback same-console successor pid=' + child.pid)
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
    // The handover helper attaches to THIS process's console while it is
    // still alive — its pid, not the relay's.
    DSH_RESTART_OLDPID: String(process.pid),
  }
  if (attached) env.DSH_RESTART_ATTACH = '1'
  const debug = process.env.DSH_RESTART_DEBUG
  const trace = (message: string): void => {
    if (debug === undefined) return
    try { writeFileAppending(debug, `${Date.now()} [old ${process.pid}] ${message}\n`) } catch { /* tracing owns nothing */ }
  }
  trace(`scheduling restart attached=${attached} argv=${env.DSH_RESTART_ARGV}`)
  const relay = spawn(process.execPath, ['-e', RELAY_PROGRAM], {
    detached: true,
    stdio: 'ignore',
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
