/**
 * The relay program's two modes, exercised as real processes: detached mode
 * must leave a running successor behind (verified through a file it writes),
 * and attach mode must keep the successor's output flowing through the relay
 * and mirror its exit code — that is the whole point of terminal handover.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RELAY_PROGRAM } from './restart.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-relay-'))
afterAll(() => {
  // Best effort: a detached successor can outlive the test by a few ms and
  // hold the directory on Windows.
  try {
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
  } catch { /* next tmp sweep owns it */ }
})

// Single-line on purpose: the window launcher writes the argv into a batch
// file, and cmd cannot carry raw newlines inside a quoted argument (real
// argv comes from a command line, so it never contains them either).
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

  // The window handover is cmd.exe mechanics; CI's ubuntu runner has none.
  it.runIf(process.platform === 'win32')('attach mode: opens a console window whose successor runs and writes through', async () => {
    const file = join(root, 'attached.txt')
    const relay = await startRelay({
      DSH_RESTART_ATTACH: '1',
      DSH_RESTART_ARGV: JSON.stringify([process.execPath, '-e', SUCCESSOR]),
      DSH_RESTART_CWD: root,
      SUCCESSOR_FILE: file,
      SUCCESSOR_TEXT: 'attached-ok',
      SUCCESSOR_CODE: '0',
    })
    // The relay's job ends once `start` has opened the window; the
    // successor lives in that window and writes its marker from there.
    expect(relay.code).toBe(0)
    for (let i = 0; i < 60 && !existsSync(file); i++) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    expect(readFileSync(file, 'utf8')).toBe('attached-ok')
  }, 20_000)

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
