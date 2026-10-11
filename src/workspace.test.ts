import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { appendCooldownExclusion } from './workspace.ts'

describe('appendCooldownExclusion（冷却期豁免自愈）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-workspace-'))
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  it('creates the workspace file when absent', () => {
    const dir = join(root, 'fresh')
    mkdirSync(dir, { recursive: true })
    appendCooldownExclusion(dir, 'dsh-plugin-install', '0.4.4')
    const doc = parse(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
    expect(doc.minimumReleaseAgeExclude).toEqual(['dsh-plugin-install@0.4.4'])
  })

  it('appends to existing exclusions and preserves other settings', () => {
    const dir = join(root, 'existing')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - .',
      'nodeLinker: hoisted',
      'allowBuilds:',
      '  cpu-features: true',
      'minimumReleaseAgeExclude:',
      '  - dsh-plugin-install@0.4.1',
      '',
    ].join('\n'))
    appendCooldownExclusion(dir, 'dsh-plugin-install', '0.4.4')
    const doc = parse(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
    expect(doc.minimumReleaseAgeExclude).toEqual(['dsh-plugin-install@0.4.1', 'dsh-plugin-install@0.4.4'])
    expect(doc.packages).toEqual(['.'])
    expect(doc.nodeLinker).toBe('hoisted')
    expect(doc.allowBuilds).toEqual({ 'cpu-features': true })
  })

  it('skips duplicates', () => {
    const dir = join(root, 'dupe')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAgeExclude:\n  - dsh-plugin-install@0.4.4\n')
    appendCooldownExclusion(dir, 'dsh-plugin-install', '0.4.4')
    const doc = parse(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
    expect(doc.minimumReleaseAgeExclude).toEqual(['dsh-plugin-install@0.4.4'])
  })

  it('refuses to rewrite an unparseable file', () => {
    const dir = join(root, 'broken')
    mkdirSync(dir, { recursive: true })
    const broken = 'packages: {unclosed\n  - nope\n'
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), broken)
    expect(() => appendCooldownExclusion(dir, 'a', '1.0.0')).toThrow()
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(broken)
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(true)
  })
})
