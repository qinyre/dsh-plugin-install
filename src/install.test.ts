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

import { installPlugin, uninstallPlugin } from './install.ts'
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

describe('installPlugin cooldown bypass (pnpm minimumReleaseAge)', () => {
  // pnpm 11 resolves `@latest` to the newest version OUTSIDE the 24h release
  // cooldown unless the add disables it — silently reinstalling the old
  // version on every day-one update.
  it('adds with the cooldown disabled', async () => {
    vi.mocked(runPlugin).mockReset().mockResolvedValueOnce(okRun)
    await installPlugin(host, 'web', root, 'dsh-plugin-capabilities@latest')
    expect(runPlugin).toHaveBeenCalledWith('web', ['add', '--config.minimum-release-age=0', 'dsh-plugin-capabilities@latest'])
  })

  it('retries plain when pnpm rejects the cooldown flag', async () => {
    const unknownOption: InstallResult = {
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: "[ERROR] Unknown option: 'config.minimum-release-age'\nFor help, run: pnpm help add",
      cancelled: false,
    }
    vi.mocked(runPlugin).mockReset()
      .mockResolvedValueOnce(unknownOption)
      .mockResolvedValueOnce(okRun)
    const outcome = await installPlugin(host, 'web', root, 'dsh-plugin-atlas')
    expect(runPlugin).toHaveBeenCalledTimes(2)
    expect(runPlugin).toHaveBeenLastCalledWith('web', ['add', 'dsh-plugin-atlas'])
    expect(outcome.ok).toBe(true)
  })

  it('reports the resolved version for the update path', async () => {
    vi.mocked(runPlugin).mockReset().mockResolvedValueOnce(okRun)
    const outcome = await installPlugin(host, 'web', root, 'dsh-plugin-install@latest', {
      name: 'dsh-plugin-install',
      expectedVersion: '0.2.3',
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.expectedVersion).toBe('0.2.3')
    expect(outcome.resolvedVersion).toBeNull() // temp profile has no node_modules
  })

  it('omits version fields for a plain install', async () => {
    vi.mocked(runPlugin).mockReset().mockResolvedValueOnce(okRun)
    const outcome = await installPlugin(host, 'web', root, 'dsh-plugin-atlas')
    expect(outcome.resolvedVersion).toBeUndefined()
    expect(outcome.expectedVersion).toBeUndefined()
  })
})

describe('uninstall cooldown bypass (lockfile policy check)', () => {
  // pnpm 11 policy-checks the WHOLE lockfile on removes: any in-window entry
  // (transitive deps of a pinned install) blocks the uninstall wholesale.
  it('removes with the cooldown disabled', async () => {
    vi.mocked(runPlugin).mockReset().mockResolvedValueOnce(okRun)
    await uninstallPlugin('web', root, 'dsh-plugin-atlas')
    expect(runPlugin).toHaveBeenCalledWith('web', ['remove', '--config.minimum-release-age=0', 'dsh-plugin-atlas'])
  })

  it('falls back to a plain remove when pnpm rejects the flag', async () => {
    vi.mocked(runPlugin).mockReset()
      .mockResolvedValueOnce({ ...staleFail, stderr: "[ERROR] Unknown option: 'config.minimum-release-age'" })
      .mockResolvedValueOnce(okRun)
    const outcome = await uninstallPlugin('web', root, 'dsh-plugin-atlas')
    expect(runPlugin).toHaveBeenCalledTimes(2)
    expect(runPlugin).toHaveBeenLastCalledWith('web', ['remove', 'dsh-plugin-atlas'])
    expect(outcome.ok).toBe(true)
  })
})

describe('failure diagnostics surfacing', () => {
  it('names pnpm\'s stdout error when stderr holds only the forwarder summary', async () => {
    // The release-policy violation prints its ERR_PNPM block to STDOUT; the
    // forwarder's stderr carries nothing but the final "dsh: pnpm failed" line.
    vi.mocked(runPlugin).mockReset().mockResolvedValueOnce({
      exitCode: 1,
      timedOut: false,
      stdout: '✗ Lockfile failed supply-chain policy check\n[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 24 lockfile entries failed verification\n',
      stderr: 'dsh: pnpm failed in profile directory C:\\users\\web\n',
      cancelled: false,
    })
    const outcome = await installPlugin(host, 'web', root, 'dsh-plugin-atlas')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
    expect(outcome.error).not.toContain('dsh: pnpm failed')
  })
})
