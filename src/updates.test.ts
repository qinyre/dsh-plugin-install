import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { compareVersions, isUpgrade, checkUpdates, invalidateUpdates, githubRepoOf, fetchNpmLatest } from './updates.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('compareVersions', () => {
  it('orders core versions numerically', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('a release outranks its prereleases and prerelease numbers compare numerically', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
  })

  it('ignores build metadata and rejects non-semver input', () => {
    expect(compareVersions('1.0.0+build', '1.0.0')).toBe(0)
    expect(compareVersions('latest', '1.0.0')).toBeNull()
  })
})

describe('isUpgrade', () => {
  it('is true only when latest is strictly higher', () => {
    expect(isUpgrade('0.1.0', '0.2.0')).toBe(true)
    expect(isUpgrade('0.2.0', '0.1.0')).toBe(false) // downgrade, never "update"
    expect(isUpgrade('0.1.0', '0.1.0')).toBe(false)
    expect(isUpgrade(null, '0.2.0')).toBe(false)
    expect(isUpgrade('0.1.0', null)).toBe(false)
  })
})

describe('githubRepoOf', () => {
  it('reduces github: specs and rejects everything else', () => {
    expect(githubRepoOf('github:user/repo')).toBe('user/repo')
    expect(githubRepoOf('github:user/repo#main')).toBe('user/repo')
    expect(githubRepoOf('user/repo')).toBeNull()
    expect(githubRepoOf('^1.0.0')).toBeNull()
  })
})

/** A profile with one plugin per install kind; fetch is stubbed per test. */
function mkProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-updates-'))
  const manifest = {
    dependencies: {
      '@deepseek-ai/dsh-base': '1.0.0',
      alpha: '^0.1.0',
      gamma: '0.1.0',
      linked: 'link:../alpha',
      gitted: 'github:foo/bar',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'alpha', 'gamma', 'linked', 'gitted'] } },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
  for (const [name, version] of [['alpha', '0.1.0'], ['gamma', '0.1.0'], ['linked', '0.3.0'], ['gitted', '1.0.0']] as const) {
    const pkgDir = join(dir, 'node_modules', name)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
  }
  writeFileSync(join(dir, 'pnpm-lock.yaml'), [
    '  gitted:',
    '    version: https://codeload.github.com/foo/bar/tar.gz/1111111111111111111111111111111111111111',
  ].join('\n'), 'utf8')
  return dir
}

const HEAD = '2222222222222222222222222222222222222222'

function stubFetch(handler: (url: string) => unknown): { calls: string[] } {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    const body = handler(url)
    if (body instanceof Error) throw body
    return { ok: true, json: async () => body } as unknown as Response
  }) as typeof fetch
  return { calls }
}

let profile: string

beforeEach(() => {
  profile = mkProfile()
  invalidateUpdates()
})

afterEach(() => {
  rmSync(profile, { recursive: true, force: true })
  viRestoreFetch()
})

const REAL_FETCH = globalThis.fetch
function viRestoreFetch(): void {
  globalThis.fetch = REAL_FETCH
}

describe('checkUpdates', () => {
  it('compares npm latest, github HEAD, and passes local links through', async () => {
    const { calls } = stubFetch((url) => {
      if (url.endsWith('/alpha/latest')) return { version: '0.2.0' }
      if (url.endsWith('/gamma/latest')) return { version: '0.1.0' }
      if (url === 'https://api.github.com/repos/foo/bar/commits/HEAD') return { sha: HEAD }
      throw new Error(`unexpected url ${url}`)
    })
    const result = await checkUpdates(profile)
    expect(result.alpha).toEqual({ kind: 'npm', version: '0.1.0', current: '0.1.0', latest: '0.2.0', updateAvailable: true })
    expect(result.gamma?.updateAvailable).toBe(false)
    expect(result.linked).toEqual({ kind: 'linked', version: '0.3.0', current: null, latest: null, updateAvailable: false })
    expect(result.gitted).toEqual({ kind: 'github', version: '1.0.0', current: '1111111111111111111111111111111111111111', latest: HEAD, updateAvailable: true })
    // linked plugins never touch the network
    expect(calls.join(' ')).not.toContain('linked')
  })

  it('reports no update rather than failing when a check errors', async () => {
    stubFetch(() => new Error('offline'))
    const result = await checkUpdates(profile)
    expect(result.alpha).toEqual({ kind: 'npm', version: '0.1.0', current: '0.1.0', latest: null, updateAvailable: false })
    expect(result.gitted?.updateAvailable).toBe(false)
    expect(result.linked?.updateAvailable).toBe(false)
  })

  it('serves the TTL cache and bypasses it with force or invalidate', async () => {
    let latest = '0.2.0'
    const { calls } = stubFetch((url) => url.endsWith('/alpha/latest') ? { version: latest } : { sha: HEAD })
    await checkUpdates(profile, true)
    const count = calls.length
    latest = '0.3.0'
    await checkUpdates(profile) // cached: same answer, no new calls
    expect(calls.length).toBe(count)
    expect((await checkUpdates(profile)).alpha.latest).toBe('0.2.0')
    await checkUpdates(profile, true) // forced refetch
    expect((await checkUpdates(profile)).alpha.latest).toBe('0.3.0')
    invalidateUpdates()
    expect((await checkUpdates(profile)).alpha.latest).toBe('0.3.0')
  })
})

describe('fetchNpmLatest', () => {
  it('returns null when the registry answers non-ok', async () => {
    globalThis.fetch = (async (): Promise<Response> => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response
    ) as typeof fetch
    expect(await fetchNpmLatest('missing-pkg')).toBeNull()
  })
})
