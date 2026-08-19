/**
 * Retry-contract tests for the post-publish propagation race: an add that
 * dies with ERR_PNPM_NO_VERSIONS inside the metadata window gets exactly one
 * delayed retry; everything else fails through untouched.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('./cli.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cli.ts')>()
  return { ...actual, runPlugin: vi.fn() }
})

import { installPlugin } from './install.ts'
import { runPlugin } from './cli.ts'
import type { InstallResult } from './types.ts'

// Keep the retry pause at 1ms so the suite stays instant.
beforeAll(() => { process.env.DSH_INSTALL_RETRY_MS = '1' })
afterAll(() => { delete process.env.DSH_INSTALL_RETRY_MS })

const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-retry-'))
afterAll(() => {
  if (root.startsWith(tmpdir()) && root.includes('dsh-plugin-install-retry-')) {
    rmSync(root, { recursive: true, force: true })
  }
})

const host = { webServer: { register: () => () => undefined }, plugin: () => ({ await: () => Promise.resolve(undefined), dispose: () => undefined }) } as Parameters<typeof installPlugin>[0]

const staleFail: InstallResult = {
  exitCode: 1,
  timedOut: false,
  stdout: '',
  stderr: ' ERR_PNPM_NO_VERSIONS  No versions available for 0.3.3. The package may be unpublished.',
  cancelled: false,
}

const okRun: InstallResult = {
  exitCode: 0,
  timedOut: false,
  stdout: 'Progress: resolved 106, reused 12, downloaded 1, added 1, done',
  stderr: '',
  cancelled: false,
}

describe('installPlugin retry (publish-then-update race)', () => {
  it('retries once when ERR_PNPM_NO_VERSIONS and keeps the success', async () => {
    vi.mocked(runPlugin).mockReset()
      .mockResolvedValueOnce(staleFail)
      .mockResolvedValueOnce(okRun)
    const outcome = await installPlugin(host, 'web', root, 'dsh-plugin-capabilities@latest')
    expect(runPlugin).toHaveBeenCalledTimes(2)
    expect(outcome.ok).toBe(true)
    expect(outcome.staleRegistry).toBeUndefined()
  })

  it('flags staleRegistry when the retry still hits the same race', async () => {
    vi.mocked(runPlugin).mockReset()
      .mockResolvedValueOnce(staleFail)
      .mockResolvedValueOnce({ ...staleFail, stderr: `${staleFail.stderr}\nsecond attempt` })
    const outcome = await installPlugin(host, 'web', root, 'dsh-plugin-capabilities@latest')
    expect(runPlugin).toHaveBeenCalledTimes(2)
    expect(outcome.ok).toBe(false)
    expect(outcome.staleRegistry).toBe(true)
    expect(outcome.error).toContain('ERR_PNPM_NO_VERSIONS')
  })

  it('does not retry other failures', async () => {
    vi.mocked(runPlugin).mockReset()
      .mockResolvedValueOnce({ ...staleFail, stderr: 'ERR_PNPM_EPERM [importPackage]' })
    const outcome = await installPlugin(host, 'web', root, 'dsh-plugin-atlas')
    expect(runPlugin).toHaveBeenCalledTimes(1)
    expect(outcome.ok).toBe(false)
    expect(outcome.staleRegistry).toBeUndefined()
  })

  it('does not retry a cancelled run even when the marker matches', async () => {
    vi.mocked(runPlugin).mockReset()
      .mockResolvedValueOnce({ ...staleFail, cancelled: true })
    const outcome = await installPlugin(host, 'web', root, 'dsh-plugin-atlas')
    expect(runPlugin).toHaveBeenCalledTimes(1)
    expect(outcome.cancelled).toBe(true)
  })
})
