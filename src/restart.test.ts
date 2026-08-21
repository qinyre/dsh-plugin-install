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
  if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
})

const SUCCESSOR = `
const fs = require('node:fs')
fs.writeFileSync(process.env.SUCCESSOR_FILE, process.env.SUCCESSOR_TEXT)
setTimeout(() => process.exit(Number(process.env.SUCCESSOR_CODE)), 100)
`

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

  it('attach mode: successor output flows through the relay and the exit code mirrors', async () => {
    const file = join(root, 'attached.txt')
    const relay = await startRelay({
      DSH_RESTART_ATTACH: '1',
      DSH_RESTART_ARGV: JSON.stringify([process.execPath, '-e', SUCCESSOR]),
      DSH_RESTART_CWD: root,
      SUCCESSOR_FILE: file,
      SUCCESSOR_TEXT: 'attached-ok',
      SUCCESSOR_CODE: '7',
    })
    // The relay outlives the successor and hands its exit code back.
    expect(relay.code).toBe(7)
    expect(relay.stdout).toBe('')
    expect(readFileSync(file, 'utf8')).toBe('attached-ok')
  }, 15_000)
})
