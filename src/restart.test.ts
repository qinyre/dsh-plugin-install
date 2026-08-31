/**
 * The relay program's two modes, exercised as real processes: detached mode
 * must leave a running successor behind (verified through a file it writes),
 * and attach mode must hand the successor to a PowerShell helper that starts
 * it after the old process is gone — that is the whole point of
 * same-terminal restarts.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BOOT_AT, BOOT_ID, RELAY_PROGRAM, handoffWindowOpen, newHandoffNonce, nonceMatches } from './restart.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-relay-'))
afterAll(() => {
  // Best effort: a detached successor can outlive the test by a few ms and
  // hold the directory on Windows.
  try {
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
  } catch { /* next tmp sweep owns it */ }
})

// Single-line on purpose: real argv comes from a command line, which never
// carries raw newlines either.
const SUCCESSOR = "const fs = require('node:fs'); fs.writeFileSync(process.env.SUCCESSOR_FILE, process.env.SUCCESSOR_TEXT); setTimeout(() => process.exit(Number(process.env.SUCCESSOR_CODE)), 100)"

function startRelay(env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', RELAY_PROGRAM], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.on('exit', (code) => { resolve({ code, stdout }) })
  })
}

describe('restart relay', () => {
  it('boot identity and handoff helpers', () => {
    // One stable id per process generation: the restarting tab detects the
    // successor by watching this value change between polls.
    expect(BOOT_ID).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof BOOT_AT).toBe('number')
    expect(handoffWindowOpen()).toBe(true)
    expect(handoffWindowOpen(BOOT_AT + 120_000)).toBe(true)
    expect(handoffWindowOpen(BOOT_AT + 120_001)).toBe(false)
    const nonce = newHandoffNonce()
    expect(nonce.length).toBeGreaterThanOrEqual(40)
    expect(newHandoffNonce()).not.toBe(nonce)
    expect(nonceMatches(nonce, nonce)).toBe(true)
    expect(nonceMatches('another', nonce)).toBe(false)
    expect(nonceMatches(undefined, nonce)).toBe(false)
    expect(nonceMatches(nonce, undefined)).toBe(false)
  })

  it('detached mode: exits at once and leaves the successor running', async () => {
    const file = join(root, 'detached.txt')
    const relay = await startRelay({
      DSH_RESTART_ARGV: JSON.stringify([process.execPath, '-e', SUCCESSOR]),
      DSH_RESTART_CWD: root,
      SUCCESSOR_FILE: file,
      SUCCESSOR_TEXT: 'detached-ok',
      SUCCESSOR_CODE: '0',
    })
    expect(relay.code).toBe(0)
    // The relay is gone before the 100ms successor finishes; wait for the mark.
    for (let i = 0; i < 40 && !existsSync(file); i++) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    expect(readFileSync(file, 'utf8')).toBe('detached-ok')
  }, 15_000)

  // The handover is conhost + PowerShell mechanics; CI's ubuntu runner has
  // no stake in it. The successor travels as a script FILE on purpose —
  // Start-Process re-quotes its argument list, and an inline -e payload
  // full of semicolons and quotes would not survive that (real argv is a
  // bin.js path plus plain flags).
  // Hosted CI runners kill this chain outright: 28s of run left zero
  // PowerShell-side trace lines while conhost itself spawned fine — the
  // runner's script hardening blocks the temp .ps1 before it executes.
  // The handover targets real user terminals anyway; local Windows runs
  // keep it covered.
  it.runIf(process.platform === 'win32' && !process.env.CI)('attach mode: the PowerShell helper starts the successor once the old process is gone', async () => {
    const file = join(root, 'attached.txt')
    const dbg = join(root, 'relay-debug.log')
    const succ = join(root, 'succ.cjs')
    writeFileSync(succ, "require('node:fs').writeFileSync(process.env.SUCCESSOR_FILE, process.env.SUCCESSOR_TEXT)")
    const relay = await startRelay({
      DSH_RESTART_ATTACH: '1',
      // A pid that never existed: AttachConsole fails, the wait loop breaks
      // at once, and the successor still starts — headless in this pipe
      // world, which is exactly the degraded-but-alive fallback.
      DSH_RESTART_OLDPID: '99999',
      DSH_RESTART_ARGV: JSON.stringify([process.execPath, succ]),
      DSH_RESTART_CWD: root,
      SUCCESSOR_FILE: file,
      SUCCESSOR_TEXT: 'attached-ok',
      SUCCESSOR_CODE: '0',
      DSH_RESTART_DEBUG: dbg,
    })
    // The relay exits right after spawning the helper; the helper starts
    // the successor on its own schedule (PowerShell warm-up included).
    // CI runners cold-start powershell.exe plus an Add-Type csc compile in
    // the tens of seconds — the poll rides the full vitest budget.
    expect(relay.code).toBe(0)
    for (let i = 0; i < 280 && !existsSync(file); i++) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    if (!existsSync(file)) {
      // The helper chain fails invisibly by design (detached, stdio off), so
      // a CI-only death must surface both sides: what the relay traced and
      // whether PowerShell got far enough to append its own lines.
      let trace = ''
      try { trace = readFileSync(dbg, 'utf8') } catch { trace = '(no trace file)' }
      throw new Error(`attached.txt never appeared\nrelay stdout: ${JSON.stringify(relay.stdout)}\nhelper trace:\n${trace}`)
    }
    expect(readFileSync(file, 'utf8')).toBe('attached-ok')
  }, 30_000)

  // The helper chain can be killed outright by script-hardening AV (proven on
  // hosted CI: conhost spawned, PowerShell never executed a line) — the relay
  // must notice the silence and start the successor itself instead of leaving
  // the user with a closed app. HELPER=0 suppresses the helper so the
  // watchdog path runs deterministically here and on CI alike.
  it.runIf(process.platform === 'win32')('watchdog: a silent helper does not strand the restart — the relay starts the successor itself', async () => {
    const file = join(root, 'watchdog.txt')
    const succ = join(root, 'succ.cjs')
    writeFileSync(succ, "require('node:fs').writeFileSync(process.env.SUCCESSOR_FILE, process.env.SUCCESSOR_TEXT)")
    const t0 = Date.now()
    const relay = await startRelay({
      DSH_RESTART_ATTACH: '1',
      DSH_RESTART_HELPER: '0',
      DSH_RESTART_WATCHDOG_MS: '1200',
      DSH_RESTART_OLDPID: '99999',
      DSH_RESTART_ARGV: JSON.stringify([process.execPath, succ]),
      DSH_RESTART_CWD: root,
      SUCCESSOR_FILE: file,
      SUCCESSOR_TEXT: 'watchdog-ok',
      SUCCESSOR_CODE: '0',
    })
    expect(relay.code).toBe(0)
    // The relay must have stayed alive for the watchdog window instead of
    // exiting right after the (suppressed) handover.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1100)
    for (let i = 0; i < 50 && !existsSync(file); i++) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    expect(readFileSync(file, 'utf8')).toBe('watchdog-ok')
  }, 20_000)

  // The claim file is the double-start arbiter between helper and watchdog:
  // whoever creates it first owns the successor, and a relay that finds it
  // already present must stand down entirely.
  it.runIf(process.platform === 'win32')('watchdog: an existing claim stops the relay from starting anything', async () => {
    const file = join(root, 'claimed.txt')
    const succ = join(root, 'succ.cjs')
    writeFileSync(succ, "require('node:fs').writeFileSync(process.env.SUCCESSOR_FILE, process.env.SUCCESSOR_TEXT)")
    // Someone (the helper, in production terms) has already filed the claim.
    writeFileSync(join(root, 'pre.claim'), '')
    const relay = await startRelay({
      DSH_RESTART_ATTACH: '1',
      DSH_RESTART_HELPER: '0',
      DSH_RESTART_WATCHDOG_MS: '600',
      DSH_RESTART_CLAIM: join(root, 'pre.claim'),
      DSH_RESTART_OLDPID: '99999',
      DSH_RESTART_ARGV: JSON.stringify([process.execPath, succ]),
      DSH_RESTART_CWD: root,
      SUCCESSOR_FILE: file,
      SUCCESSOR_TEXT: 'claimed-ok',
      SUCCESSOR_CODE: '0',
    })
    expect(relay.code).toBe(0)
    await new Promise(resolve => { setTimeout(resolve, 2500) })
    expect(existsSync(file)).toBe(false)
  }, 15_000)

  it('passes the handoff nonce through to the successor (relay env inheritance)', async () => {
    const file = join(root, 'handoff.txt')
    const relay = await startRelay({
      DSH_RESTART_ARGV: JSON.stringify([process.execPath, '-e', "require('node:fs').writeFileSync(process.env.SUCCESSOR_FILE, process.env.DSH_RESTART_HANDOFF || 'MISSING')"]),
      DSH_RESTART_CWD: root,
      DSH_RESTART_HANDOFF: 'nonce-on-the-wire',
      SUCCESSOR_FILE: file,
    })
    expect(relay.code).toBe(0)
    for (let i = 0; i < 40 && !existsSync(file); i++) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    expect(readFileSync(file, 'utf8')).toBe('nonce-on-the-wire')
  }, 15_000)

  it('waits for the old process to exit before launching the successor', async () => {
    const file = join(root, 'waited.txt')
    // A stand-in "old process" that lives 600ms — the successor must appear
    // only after it is gone (the EADDRINUSE race this guards against).
    const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'])
    const relay = await startRelay({
      DSH_RESTART_PARENT_PID: String(old.pid),
      DSH_RESTART_ARGV: JSON.stringify([process.execPath, '-e', SUCCESSOR]),
      DSH_RESTART_CWD: root,
      SUCCESSOR_FILE: file,
      SUCCESSOR_TEXT: 'waited-ok',
      SUCCESSOR_CODE: '0',
    })
    expect(relay.code).toBe(0)
    // The detached successor needs a moment to be scheduled before its very
    // first statement lands.
    for (let i = 0; i < 40 && !existsSync(file); i++) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    expect(readFileSync(file, 'utf8')).toBe('waited-ok')
  }, 15_000)
})
