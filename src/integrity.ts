/**
 * Post-removal integrity: a package-manager removal prunes hoisted entries
 * nothing in the profile manifest depends on any more — and a plugin whose
 * peer or dependency was only ever satisfied by that hoisted copy (desktop
 * profiles install with autoInstallPeers: false, so peers are never
 * auto-installed and routinely ride a neighbour's hoisted cordis) stops
 * resolving and fails the next boot with "import failed". The uninstall
 * flow audits every remaining profile-tree plugin after a remove and lets
 * the caller repair the gaps with a cooldown-bypassed add.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

/** One unresolvable requirement of one remaining plugin. */
export interface IntegrityIssue {
  plugin: string
  requirement: string
  /** Declared range; '*' marks requirements we can repair-install (deps,
   * peers) as opposed to runtime-owned client injects. */
  range: string
}

interface PluginManifestShape {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { client?: { inject?: string[] } }
}

/**
 * Check that every remaining plugin in the bundle list can still resolve its
 * declared dependencies, peer dependencies, and client injects the way the
 * runtime would (Node resolution from the plugin's own directory, which
 * includes the profiles-tree interception layer). Bundles without a profile
 * tree package resolve from the dsh installation and stay outside this audit.
 */
export function auditProfileTree(profileDirPath: string, bundles: readonly string[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = []
  for (const name of bundles) {
    const manifestPath = join(profileDirPath, 'node_modules', name, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest: PluginManifestShape
    try {
      // tolerate a stray BOM rather than failing the audit over formatting
      const raw = readFileSync(manifestPath, 'utf8')
      manifest = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as PluginManifestShape
    } catch {
      continue
    }
    const require = createRequire(manifestPath)
    const wanted: Array<[string, string]> = [
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(manifest.peerDependencies ?? {}),
    ]
    for (const inject of manifest.dsh?.client?.inject ?? []) wanted.push([inject, '*'])
    for (const [requirement, range] of wanted) {
      try {
        require.resolve(requirement)
      } catch {
        issues.push({ plugin: name, requirement, range })
      }
    }
  }
  return issues
}

/** Issues an add can fix (a declared range to install); inject entries are
 * runtime-owned and only reported. */
export function repairableIssues(issues: readonly IntegrityIssue[]): IntegrityIssue[] {
  return issues.filter(issue => issue.range !== '*')
}
