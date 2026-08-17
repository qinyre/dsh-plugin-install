import { describe, expect, it } from 'vitest'
import { readInstalledBundles, readInstalledSpecs, readInstalledVersion, readLockCommits, argvProfile, profileDir, isLocalLink } from './profile.ts'

describe('readInstalledBundles（可装清单 = bundles − 基线）', () => {
  it('filters the in-box baseline and returns user bundles', () => {
    const dir = mkFakeProfile(JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0', 'dsh-context': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-context'] } },
    }))
    expect(readInstalledBundles(dir)).toEqual(['dsh-context'])
  })

  it('returns [] when the manifest is missing or malformed', () => {
    expect(readInstalledBundles(mkFakeProfile('not json'))).toEqual([])
    expect(readInstalledBundles(mkFakeProfile('{}'))).toEqual([])
    expect(readInstalledBundles(mkFakeProfile(JSON.stringify({ dsh: { profile: {} } })))).toEqual([])
  })
})

describe('argvProfile', () => {
  it('reads the --profile flag value', () => {
    expect(argvProfile(['dsh', 'web', '--profile', 'demo', '--port', '0'])).toBe('demo')
  })

  it('returns undefined without a profile flag', () => {
    expect(argvProfile(['dsh', 'web'])).toBeUndefined()
  })

  it('ignores a flag-looking value', () => {
    expect(argvProfile(['dsh', '--profile', '--port'])).toBeUndefined()
  })
})

describe('profileDir', () => {
  it('resolves under DSH_HOME when set', () => {
    expect(profileDir('web', '/custom/home')).toBe(join('/custom/home', 'profiles', 'web'))
  })

  it('defaults to ~/.dsh', () => {
    expect(profileDir('web')).toBe(join(homedir(), '.dsh', 'profiles', 'web'))
  })
})

describe('isLocalLink', () => {
  it('recognizes file:, link:, and relative/absolute paths', () => {
    expect(isLocalLink('file:../x')).toBe(true)
    expect(isLocalLink('link:./x')).toBe(true)
    expect(isLocalLink('./x')).toBe(true)
    expect(isLocalLink('/abs/x')).toBe(true)
    expect(isLocalLink('dsh-context')).toBe(false)
    expect(isLocalLink('github:user/repo')).toBe(false)
  })
})

describe('readInstalledSpecs（bundles × dependencies）', () => {
  it('returns the spec of every user bundle', () => {
    const dir = mkFakeProfile(JSON.stringify({
      dependencies: {
        '@deepseek-ai/dsh-base': '1.0.0',
        'dsh-context': '^1.2.0',
        'my-plugin': 'github:user/repo#main',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-context', 'my-plugin'] } },
    }))
    expect(readInstalledSpecs(dir)).toEqual({ 'dsh-context': '^1.2.0', 'my-plugin': 'github:user/repo#main' })
  })

  it('skips bundles without a dependency entry and returns {} when malformed', () => {
    const dir = mkFakeProfile(JSON.stringify({
      dependencies: { 'dsh-context': '^1.0.0' },
      dsh: { profile: { bundles: ['dsh-context', 'ghost'] } },
    }))
    expect(readInstalledSpecs(dir)).toEqual({ 'dsh-context': '^1.0.0' })
    expect(readInstalledSpecs(mkFakeProfile('not json'))).toEqual({})
  })
})

describe('readInstalledVersion', () => {
  it('reads the version from node_modules', () => {
    const dir = mkFakeProfile('{}')
    mkdirSync(join(dir, 'node_modules', 'dsh-context'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dsh-context', 'package.json'), '{"name":"dsh-context","version":"1.2.3"}', 'utf8')
    expect(readInstalledVersion(dir, 'dsh-context')).toBe('1.2.3')
  })

  it('returns null when the manifest is missing', () => {
    expect(readInstalledVersion(mkFakeProfile('{}'), 'nope')).toBeNull()
  })
})

describe('readLockCommits', () => {
  it('maps lowercase owner/repo to the pinned tarball sha', () => {
    const dir = mkFakeProfile('{}')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), [
      'dependencies:',
      '  my-plugin:',
      "    specifier: github:User/Repo#main",
      '    version: https://codeload.github.com/User/Repo/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      "  other: https://codeload.github.com/other/repo/post/1.0.0",
    ].join('\n'), 'utf8')
    expect(readLockCommits(dir)).toEqual(new Map([['user/repo', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']]))
  })

  it('returns an empty map without a lockfile', () => {
    expect(readLockCommits(mkFakeProfile('{}')).size).toBe(0)
  })
})

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

let counter = 0
function mkFakeProfile(manifest: string): string {
  const dir = join(tmpdir(), `dsh-plugin-install-test-${process.pid}-${counter++}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), manifest, 'utf8')
  afterCleanup.push(dir)
  return dir
}

const afterCleanup: string[] = []
afterEach(() => { for (const dir of afterCleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

import { afterEach } from 'vitest'