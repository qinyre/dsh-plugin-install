/**
 * Mount-toggle mechanics: the insert-row collector must target exactly the
 * entries a bundle creates (bare rows and group rows are out), the disabled
 * scanner must read both layers' rows, and the managed block must round-trip
 * without touching a user's own rows.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  collectInsertIds,
  readDisabledIds,
  readMountRows,
  setPluginMounted,
  stripPluginRows,
  writeManagedBlock,
} from './mounts.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-mounts-'))
const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-mounts-home-'))
afterAll(() => {
  for (const dir of [root, home]) {
    if (dir.startsWith(tmpdir()) && dir.includes('dsh-plugin-install-mounts')) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

/** Install a fake bundle under the profile's node_modules with a patch. */
function fakeBundle(name: string, patch: string): string {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    description: `${name} test bundle`,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  return dir
}

describe('collectInsertIds（只收集 patch 创建的行）', () => {
  it('collects the single-row shape every first-party plugin ships', () => {
    const patch = [
      '# bundle patch comment',
      '- insert:',
      "    - id: dsh-plugin-install",
      "      name: 'dsh-plugin-install'",
    ].join('\n')
    expect(collectInsertIds(patch)).toEqual({ ids: ['dsh-plugin-install'], toggleable: true })
  })

  it('collects multiple rows and skips the bare modifier row above an insert', () => {
    const patch = [
      '- id: settings-tabs',
      '  insert:',
      '    - id: my-tab',
      '      name: my-plugin',
      '- insert:',
      '    - id: my-host',
    ].join('\n')
    expect(collectInsertIds(patch)).toEqual({ ids: ['my-tab', 'my-host'], toggleable: true })
  })

  it('bails on group rows — the loader cannot disable a group', () => {
    const patch = ['- insert:', '  - id: tabs', '    group: true'].join('\n')
    expect(collectInsertIds(patch).toggleable).toBe(false)
  })

  it('bails on rows without an id and on patches with no inserts at all', () => {
    expect(collectIdsBail('- insert:\n  - name: anon\n')).toBe(false)
    expect(collectIdsBail('- id: bare-override\n  config: {a: 1}\n')).toBe(false)
  })
})

function collectIdsBail(patch: string): boolean {
  return collectInsertIds(patch).toggleable
}

describe('scanDisabledIds / readDisabledIds（跨两层读禁用行）', () => {
  beforeEach(() => {
    rmSync(join(root, 'cordis.patch.yml'), { force: true })
    rmSync(join(home, 'cordis.patch.yml'), { force: true })
  })

  it('sees managed rows, hand-written rows, and home-layer rows', () => {
    writeManagedBlock(join(root, 'cordis.patch.yml'), ['demo-plugin'])
    // a hand-written disable in the same file, after the managed block
    const profilePatch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    writeFileSync(join(root, 'cordis.patch.yml'), `${profilePatch}- id: hand-row\n  disabled: true\n`)
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: home-row\n  disabled: true\n', 'utf8')
    const ids = readDisabledIds(root, home)
    expect([...ids].sort()).toEqual(['demo-plugin', 'hand-row', 'home-row'])
  })

  it('ignores insert rows even when their entries carry disabled', () => {
    writeFileSync(join(root, 'cordis.patch.yml'), '- insert:\n    - id: seed\n      disabled: true\n', 'utf8')
    expect([...readDisabledIds(root, home)]).toEqual([])
  })
})

describe('managed block（marker 手术不动用户行）', () => {
  it('creates the file when absent and leaves a valid empty root when cleared', () => {
    const file = join(root, 'fresh', 'cordis.patch.yml')
    mkdirSync(join(root, 'fresh'), { recursive: true })
    writeManagedBlock(file, ['a', 'b'])
    const once = readFileSync(file, 'utf8')
    expect(once).toContain('- id: a')
    expect(once).toContain('- id: b')
    writeManagedBlock(file, [])
    // An emptied layer must still parse as a top-level array: the live
    // watcher re-reads it on every change and fails loud otherwise.
    expect(readFileSync(file, 'utf8')).toBe('[]\n')
  })

  it('keeps a comments-only layer parsable when the block empties', () => {
    const file = join(root, 'seeded', 'cordis.patch.yml')
    mkdirSync(join(root, 'seeded'), { recursive: true })
    writeFileSync(file, '# Your patch layer\n# more docs\n[]\n', 'utf8')
    writeManagedBlock(file, ['demo-plugin'])
    const withBlock = readFileSync(file, 'utf8')
    expect(withBlock.startsWith('# Your patch layer\n# more docs\n')).toBe(true)
    expect(withBlock).toContain('- id: demo-plugin')
    writeManagedBlock(file, [])
    expect(readFileSync(file, 'utf8')).toBe('# Your patch layer\n# more docs\n[]\n')
  })

  it('preserves user rows byte-for-byte outside the markers', () => {
    const file = join(root, 'user', 'cordis.patch.yml')
    mkdirSync(join(root, 'user'), { recursive: true })
    writeFileSync(file, '# my own layer\n- id: mine\n  config: {x: 1}\n', 'utf8')
    writeManagedBlock(file, ['demo-plugin'])
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('# my own layer\n- id: mine\n  config: {x: 1}\n')).toBe(true)
    expect(text).toContain('begin dsh-plugin-install mounts')
    expect(text).toContain('- id: demo-plugin')
    writeManagedBlock(file, [])
    expect(readFileSync(file, 'utf8')).toBe('# my own layer\n- id: mine\n  config: {x: 1}\n')
  })
})

describe('setPluginMounted / stripPluginRows', () => {
  const patch = '- insert:\n    - id: demo-plugin\n      name: demo-plugin\n'

  beforeEach(() => {
    rmSync(join(root, 'cordis.patch.yml'), { force: true })
    rmSync(join(home, 'cordis.patch.yml'), { force: true })
  })

  it('toggles the rows and cleans them on strip', () => {
    fakeBundle('demo-plugin', patch)
    const rows = readMountRows(root, 'demo-plugin')
    expect(rows).toEqual({ ids: ['demo-plugin'], toggleable: true })
    setPluginMounted(root, rows, false)
    expect([...readDisabledIds(root, home)]).toContain('demo-plugin')
    setPluginMounted(root, rows, true)
    expect([...readDisabledIds(root, home)]).not.toContain('demo-plugin')
    setPluginMounted(root, rows, false)
    stripPluginRows(root, rows)
    expect([...readDisabledIds(root, home)]).not.toContain('demo-plugin')
  })

  it('keeps another plugin\'s rows when toggling one', () => {
    fakeBundle('demo-plugin', patch)
    fakeBundle('other-plugin', '- insert:\n    - id: other-plugin\n      name: other-plugin\n')
    setPluginMounted(root, readMountRows(root, 'demo-plugin'), false)
    setPluginMounted(root, readMountRows(root, 'other-plugin'), false)
    setPluginMounted(root, readMountRows(root, 'demo-plugin'), true)
    const ids = [...readDisabledIds(root, home)]
    expect(ids).toContain('other-plugin')
    expect(ids).not.toContain('demo-plugin')
    stripPluginRows(root, readMountRows(root, 'other-plugin'))
    expect([...readDisabledIds(root, home)]).toEqual([])
  })

  it('reports non-toggleable for bundles without a readable patch', () => {
    expect(readMountRows(root, 'ghost-plugin').toggleable).toBe(false)
    fakeBundle('grouped-plugin', '- insert:\n  - id: g\n    group: true\n')
    expect(readMountRows(root, 'grouped-plugin').toggleable).toBe(false)
  })
})
