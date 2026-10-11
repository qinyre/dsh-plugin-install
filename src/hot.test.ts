import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { hotReloadUpdate, parseSimplePatch } from './hot.ts'
import { readDisabledIds } from './mounts.ts'
import type { InstallerHost } from './types.ts'

describe('parseSimplePatch（热载可行性判断）', () => {
  it('parses a plain insert block', () => {
    const rows = parseSimplePatch(`- insert:\n    - id: hello\n      name: dsh-hello-plugin\n`)
    expect(rows).toEqual([{ id: 'hello', name: 'dsh-hello-plugin' }])
  })

  it('parses multiple rows in one insert', () => {
    const rows = parseSimplePatch(`- insert:\n    - id: a\n      name: pkg-a\n    - id: b\n      name: pkg-b\n`)
    expect(rows).toHaveLength(2)
  })

  it('accepts quoted names and comments', () => {
    const rows = parseSimplePatch(`# comment\n- insert:\n    - id: a\n      name: 'pkg-a'  # trailing\n`)
    expect(rows).toEqual([{ id: 'a', name: 'pkg-a' }])
  })

  it('rejects config-bearing rows (fall back to restart)', () => {
    expect(parseSimplePatch(`- insert:\n    - id: a\n      name: pkg-a\n      config:\n        x: 1\n`)).toBeNull()
  })

  it('rejects disable rows and free patches', () => {
    expect(parseSimplePatch(`- id: a\n  disabled: true\n`)).toBeNull()
    expect(parseSimplePatch(`[]`)).toBeNull()
    expect(parseSimplePatch(``)).toBeNull()
  })

  it('rejects a dangling id without a name', () => {
    expect(parseSimplePatch(`- insert:\n    - id: a\n- insert:\n    - id: b\n      name: c\n`)).toBeNull()
  })
})

describe('hotReloadUpdate（更新后热替换）', () => {
  const ids = ['fixture-row-a', 'fixture-row-b']
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-hotreload-'))
  const home = join(root, 'home')
  const profilePatch = join(root, 'cordis.patch.yml')
  const homePatch = join(home, 'cordis.patch.yml')
  const pkgDir = join(root, 'node_modules', 'fixture-plugin')
  const patchText = `- insert:\n${ids.map(id => `    - id: ${id}\n      name: fixture-${id}`).join('\n')}\n`

  mkdirSync(pkgDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), patchText)

  beforeEach(() => {
    vi.stubEnv('DSH_HOME', home)
    rmSync(profilePatch, { force: true })
    rmSync(homePatch, { force: true })
  })
  afterEach(() => { vi.unstubAllEnvs() })
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  type ReloadMode = 'reload' | 'unload-timeout' | 'load-timeout'

  /** A host whose live fibers mirror the profile layer's pause rows, like the
   * watched recompose does; timeout modes simulate either leg getting stuck. */
  function mirrorHost(mode: ReloadMode = 'reload'): { host: InstallerHost; seenLive: Set<string>; stop: () => void } {
    const disabledBefore = readDisabledIds(root)
    const live = new Set(ids.filter(id => !disabledBefore.has(id)))
    const seenLive = new Set(live)
    const timer = setInterval(() => {
      if (mode === 'unload-timeout') return
      const disabled = readDisabledIds(root)
      for (const id of ids) {
        if (disabled.has(id)) live.delete(id)
        else if (mode !== 'load-timeout') {
          live.add(id)
          seenLive.add(id)
        }
      }
    }, 25)
    return {
      host: {
        webServer: { register: () => () => undefined },
        plugin: () => ({ await: () => Promise.resolve(undefined), dispose: () => undefined }),
        loaderEntries: () => [...live].map(id => ({ options: { id }, fiber: {} })),
      },
      seenLive,
      stop: () => { clearInterval(timer) },
    }
  }

  it('pauses and resumes a running plugin and reports hot', async () => {
    const { host, stop } = mirrorHost()
    try {
      const result = await hotReloadUpdate(host, root, 'fixture-plugin', { unloadTimeoutMs: 3000, loadTimeoutMs: 3000 })
      expect(result).toEqual({ hot: true })
      expect(readDisabledIds(root).size).toBe(0)
    } finally {
      stop()
    }
  })

  it.each<ReloadMode>(['reload', 'unload-timeout', 'load-timeout'])('keeps a pre-disabled row disabled during %s', async mode => {
    writeFileSync(profilePatch, `- id: ${ids[1]}\n  disabled: true\n- id: unrelated-paused\n  disabled: true\n`)
    const disabledBefore = readDisabledIds(root)
    const { host, seenLive, stop } = mirrorHost(mode)
    try {
      const result = await hotReloadUpdate(host, root, 'fixture-plugin', { unloadTimeoutMs: 350, loadTimeoutMs: 350 })
      if (mode === 'reload') expect(result).toEqual({ hot: true })
      else {
        expect(result?.hot).toBe(false)
        expect(result?.note).toContain(mode === 'unload-timeout' ? 'unload' : 'activating')
      }
      expect(readDisabledIds(root)).toEqual(disabledBefore)
      expect([...seenLive]).toEqual([ids[0]])
      expect(host.loaderEntries().map(entry => entry.options?.id)).toEqual(mode === 'load-timeout' ? [] : [ids[0]])
    } finally {
      stop()
    }
  })

  it('restores the rows and declines when the old generation never unloads', async () => {
    const { host, stop } = mirrorHost('unload-timeout')
    try {
      const result = await hotReloadUpdate(host, root, 'fixture-plugin', { unloadTimeoutMs: 350, loadTimeoutMs: 350 })
      expect(result?.hot).toBe(false)
      expect(result?.note).toContain('unload')
      expect(readDisabledIds(root).size).toBe(0)
    } finally {
      stop()
    }
  })

  it('declines with a restart note when the new generation never activates', async () => {
    const { host, stop } = mirrorHost('load-timeout')
    try {
      const result = await hotReloadUpdate(host, root, 'fixture-plugin', { unloadTimeoutMs: 350, loadTimeoutMs: 350 })
      expect(result?.hot).toBe(false)
      expect(result?.note).toContain('activating')
      expect(readDisabledIds(root).size).toBe(0)
    } finally {
      stop()
    }
  })

  it.each(['profile', 'home'])('preserves %s-layer pause configuration and unrelated user rows', async layer => {
    const userRows = [{ id: 'user-row', config: { keep: 'user value' } }]
    const pause = { id: ids[1], name: 'fixture-b', disabled: true, config: { keep: 'pause value' } }
    const profileBefore = layer === 'profile' ? [...userRows, pause] : userRows
    writeFileSync(profilePatch, `# profile comment\n${JSON.stringify(profileBefore)}\n`)
    const homeBefore = `# home comment\n${JSON.stringify(layer === 'home' ? [pause] : [])}\n`
    writeFileSync(homePatch, homeBefore)
    const { host, seenLive, stop } = mirrorHost()
    try {
      expect(await hotReloadUpdate(host, root, 'fixture-plugin', { unloadTimeoutMs: 350, loadTimeoutMs: 350 }))
        .toEqual({ hot: true })
      expect(parse(readFileSync(profilePatch, 'utf8'))).toEqual(profileBefore)
      expect(readFileSync(profilePatch, 'utf8')).toContain('# profile comment')
      expect(readFileSync(homePatch, 'utf8')).toBe(homeBefore)
      expect([...seenLive]).toEqual([ids[0]])
    } finally {
      stop()
    }
  })

  it('restores the original enabled set when unload polling throws', async () => {
    writeFileSync(profilePatch, `- id: ${ids[1]}\n  disabled: true\n`)
    const { host, stop } = mirrorHost()
    const spy = vi.spyOn(host, 'loaderEntries')
      .mockReturnValueOnce([{ options: { id: ids[0] }, fiber: {} }])
      .mockImplementationOnce(() => { throw new Error('loader unavailable') })
    try {
      await expect(hotReloadUpdate(host, root, 'fixture-plugin')).rejects.toThrow('loader unavailable')
      expect([...readDisabledIds(root)]).toEqual([ids[1]])
    } finally {
      spy.mockRestore()
      stop()
    }
  })

  it('leaves an entirely disabled plugin untouched', async () => {
    const before = `${JSON.stringify(ids.map(id => ({ id, disabled: true })))}\n`
    writeFileSync(profilePatch, before)
    const { host, stop } = mirrorHost()
    try {
      await expect(hotReloadUpdate(host, root, 'fixture-plugin')).resolves.toBeNull()
      expect(readFileSync(profilePatch, 'utf8')).toBe(before)
    } finally {
      stop()
    }
  })

  it('returns null for a plugin with nothing running', async () => {
    const host: InstallerHost = {
      webServer: { register: () => () => undefined },
      plugin: () => ({ await: () => Promise.resolve(undefined), dispose: () => undefined }),
      loaderEntries: () => [],
    }
    await expect(hotReloadUpdate(host, root, 'fixture-plugin', { unloadTimeoutMs: 200, loadTimeoutMs: 200 }))
      .resolves.toBeNull()
    expect(existsSync(profilePatch)).toBe(false)
  })

  it('returns null for a non-toggleable patch', async () => {
    const groupDir = join(root, 'node_modules', 'fixture-group')
    mkdirSync(groupDir, { recursive: true })
    writeFileSync(
      join(groupDir, 'package.json'),
      JSON.stringify({ name: 'fixture-group', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    )
    writeFileSync(join(groupDir, 'cordis.patch.yml'), `- insert:\n    - group: g\n      id: fixture-g\n`)
    const { host, stop } = mirrorHost()
    try {
      await expect(hotReloadUpdate(host, root, 'fixture-group', { unloadTimeoutMs: 200, loadTimeoutMs: 200 }))
        .resolves.toBeNull()
    } finally {
      stop()
    }
  })
})
