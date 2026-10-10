import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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
  const pkgDir = join(root, 'node_modules', 'fixture-plugin')
  const patchText = `- insert:\n${ids.map(id => `    - id: ${id}\n      name: fixture-${id}`).join('\n')}\n`

  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), patchText)

  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  /** A host whose live fibers mirror the profile layer's pause rows, like the
   * watched recompose does; `frozenLive` pins the fibers for stuck-leg tests. */
  function mirrorHost(frozenLive: boolean): { host: InstallerHost; stop: () => void } {
    const live = new Set<string>(ids)
    const timer = setInterval(() => {
      if (frozenLive) return
      const disabled = readDisabledIds(root)
      for (const id of ids) {
        if (disabled.has(id)) live.delete(id)
        else live.add(id)
      }
    }, 25)
    return {
      host: {
        webServer: { register: () => () => undefined },
        plugin: () => ({ await: () => Promise.resolve(undefined), dispose: () => undefined }),
        loaderEntries: () => [...live].map(id => ({ options: { id }, fiber: {} })),
      },
      stop: () => { clearInterval(timer) },
    }
  }

  it('pauses and resumes a running plugin and reports hot', async () => {
    const { host, stop } = mirrorHost(false)
    try {
      const result = await hotReloadUpdate(host, root, 'fixture-plugin', { unloadTimeoutMs: 3000, loadTimeoutMs: 3000 })
      expect(result).toEqual({ hot: true })
      expect(readDisabledIds(root).size).toBe(0)
    } finally {
      stop()
    }
  })

  it('restores the rows and declines when the old generation never unloads', async () => {
    const { host, stop } = mirrorHost(true)
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
    // The mirror honors the pause but never resumes: fibers drop and stay down.
    const live = new Set<string>(ids)
    const timer = setInterval(() => {
      if (readDisabledIds(root).size > 0) live.clear()
    }, 25)
    const host: InstallerHost = {
      webServer: { register: () => () => undefined },
      plugin: () => ({ await: () => Promise.resolve(undefined), dispose: () => undefined }),
      loaderEntries: () => [...live].map(id => ({ options: { id }, fiber: {} })),
    }
    try {
      const result = await hotReloadUpdate(host, root, 'fixture-plugin', { unloadTimeoutMs: 350, loadTimeoutMs: 350 })
      expect(result?.hot).toBe(false)
      expect(result?.note).toContain('activating')
    } finally {
      clearInterval(timer)
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
  })

  it('returns null for a non-toggleable patch', async () => {
    const groupDir = join(root, 'node_modules', 'fixture-group')
    mkdirSync(groupDir, { recursive: true })
    writeFileSync(
      join(groupDir, 'package.json'),
      JSON.stringify({ name: 'fixture-group', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    )
    writeFileSync(join(groupDir, 'cordis.patch.yml'), `- insert:\n    - group: g\n      id: fixture-g\n`)
    const { host, stop } = mirrorHost(false)
    try {
      await expect(hotReloadUpdate(host, root, 'fixture-group', { unloadTimeoutMs: 200, loadTimeoutMs: 200 }))
        .resolves.toBeNull()
    } finally {
      stop()
    }
  })
})