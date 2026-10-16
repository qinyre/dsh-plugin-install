/**
 * Audit-contract tests for the post-removal integrity check: every
 * remaining profile-tree plugin must still resolve its declared
 * dependencies, peers, and client injects the way the runtime would.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditProfileTree, repairableIssues } from './integrity.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-integrity-'))
afterAll(() => {
  if (root.startsWith(tmpdir()) && root.includes('dsh-plugin-install-integrity-')) {
    rmSync(root, { recursive: true, force: true })
  }
})

function writePackage(relPath: string, manifest: Record<string, unknown>): void {
  const dir = join(root, relPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', ...manifest }))
}

beforeAll(() => {
  // A dependency that genuinely resolves: real directory, real entry file.
  writePackage('node_modules/dep-present', { name: 'dep-present', main: 'index.js' })
  writeFileSync(join(root, 'node_modules', 'dep-present', 'index.js'), 'export {}\n')
  writePackage('node_modules/keeper', {
    name: 'keeper',
    dependencies: { 'dep-present': '^1.0.0' },
    peerDependencies: { '@definitely/missing-peer': '^2.0.0' },
    dsh: { client: { inject: ['@definitely/missing-inject'] } },
  })
})

describe('auditProfileTree', () => {
  it('reports unresolvable dependencies, peers, and injects with their ranges', () => {
    const issues = auditProfileTree(root, ['keeper'])
    expect(issues).toEqual([
      { plugin: 'keeper', requirement: '@definitely/missing-peer', range: '^2.0.0' },
      { plugin: 'keeper', requirement: '@definitely/missing-inject', range: '*' },
    ])
  })

  it('skips bundles without a profile-tree package (runtime-resolved)', () => {
    expect(auditProfileTree(root, ['@deepseek-ai/dsh-web-app'])).toEqual([])
  })

  it('stays silent when every requirement resolves', () => {
    writePackage('node_modules/self-sufficient', { name: 'self-sufficient', dependencies: { 'dep-present': '^1.0.0' } })
    expect(auditProfileTree(root, ['self-sufficient'])).toEqual([])
  })
})

describe('repairableIssues', () => {
  it('keeps declared ranges and drops runtime-owned inject entries', () => {
    const issues = auditProfileTree(root, ['keeper'])
    expect(repairableIssues(issues)).toEqual([
      { plugin: 'keeper', requirement: '@definitely/missing-peer', range: '^2.0.0' },
    ])
  })
})
