/** Profile discovery and installed-plugin listing (pure reads). */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Profile that boots this UI: `--profile <name>` on the CLI invocation. */
export function argvProfile(argv: readonly string[] = process.argv): string | undefined {
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) return argv[flag + 1]
  return undefined
}

/** The dsh home directory (default `~/.dsh`). */
export function dshHome(home = process.env.DSH_HOME): string {
  return home ?? join(homedir(), '.dsh')
}

/** Directory of a profile under DSH_HOME (default `~/.dsh`). */
export function profileDir(profile: string, home: string | undefined = process.env.DSH_HOME): string {
  return join(dshHome(home), 'profiles', profile)
}

/** The in-box bundles every profile template ships; never shown as user-installed. */
const INBOX_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

/** User-installed bundles: `dsh.profile.bundles` minus the in-box baseline. */
export function readInstalledBundles(profileDirPath: string): string[] {
  const manifest = join(profileDirPath, 'package.json')
  if (!existsSync(manifest)) return []
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = parsed.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return []
    return bundles.filter((name): name is string => typeof name === 'string' && !INBOX_BUNDLES.has(name))
  } catch {
    return []
  }
}

/** Whether a spec looks like a local filesystem link (file:/link: or a path). */
export function isLocalLink(spec: string): boolean {
  return spec.startsWith('file:') || spec.startsWith('link:') || spec.startsWith('.') || spec.startsWith('/')
}

/** Install spec of every user-installed bundle: name → dependency spec. */
export function readInstalledSpecs(profileDirPath: string): Record<string, string> {
  const manifest = join(profileDirPath, 'package.json')
  if (!existsSync(manifest)) return {}
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      dependencies?: unknown
      dsh?: { profile?: { bundles?: unknown } }
    }
    const deps = parsed.dependencies
    const specs: Record<string, string> = {}
    if (deps === null || typeof deps !== 'object') return {}
    for (const name of readInstalledBundles(profileDirPath)) {
      const spec = (deps as Record<string, unknown>)[name]
      if (typeof spec === 'string') specs[name] = spec
    }
    return specs
  } catch {
    return {}
  }
}

/** The version actually present in the profile's node_modules, or null. */
export function readInstalledVersion(profileDirPath: string, name: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDirPath, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

/** Presentation metadata for one installed plugin's card. */
export interface PluginMeta {
  name: string
  version: string | null
  description: string | null
  /** Repository as a browsable https URL, when derivable; null otherwise. */
  repository: string | null
}

/**
 * Normalize a package.json `repository` field (string shorthand or object
 * with a url) into a browsable https URL. Returns null for anything that is
 * not clearly a web-facing code host — the UI then hides the 源码 tag.
 */
export function repositoryUrl(repository: unknown): string | null {
  const raw = typeof repository === 'string'
    ? repository
    : repository !== null && typeof repository === 'object' && typeof (repository as { url?: unknown }).url === 'string'
      ? (repository as { url: string }).url
      : null
  if (raw === null) return null
  const github = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(raw.trim())
  if (github !== null && (raw.trim().startsWith('github:') || !/^[a-z]+:\/\//.test(raw.trim()))) {
    return `https://github.com/${github[1]}`
  }
  try {
    const url = new URL(raw.trim().replace(/^git\+/, '').replace(/\.git$/, ''))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/** Read one installed plugin's card metadata straight from its manifest. */
export function readPluginMeta(profileDirPath: string, name: string, spec?: string): PluginMeta {
  const meta: PluginMeta = { name, version: null, description: null, repository: null }
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDirPath, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: string; description?: string; repository?: unknown }
    if (typeof manifest.version === 'string') meta.version = manifest.version
    if (typeof manifest.description === 'string' && manifest.description.trim() !== '') {
      meta.description = manifest.description.trim()
    }
    meta.repository = repositoryUrl(manifest.repository)
  } catch { /* missing manifest: version stays null, fields stay hidden */ }
  if (meta.repository === null && spec !== undefined && spec.startsWith('github:')) {
    const repo = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
    if (repo !== null) meta.repository = `https://github.com/${repo[1]}`
  }
  return meta
}

/** Pinned commit per `owner/repo` from the profile lockfile's codeload tarball URLs. */
export function readLockCommits(profileDirPath: string): Map<string, string> {
  const commits = new Map<string, string>()
  try {
    const lock = readFileSync(join(profileDirPath, 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g)) {
      commits.set(m[1].toLowerCase(), m[2])
    }
  } catch { /* no lockfile — no git installs to report */ }
  return commits
}