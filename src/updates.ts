/**
 * Update detection: per-plugin comparison of what the profile has against
 * the source of truth — the npm `latest` dist-tag for registry installs,
 * git HEAD for github installs — with a TTL cache. Local links (link:/file:)
 * are reported as such and never checked: they update from their checkout.
 */

import { readInstalledSpecs, readInstalledVersion, readLockCommits } from './profile.ts'

export interface UpdateStatus {
  kind: 'npm' | 'github' | 'linked' | 'unknown'
  version: string | null
  /** Installed-side identity: the version (npm) or pinned commit (github). */
  current: string | null
  /** Registry latest version or repo HEAD commit, null when unreadable. */
  latest: string | null
  updateAvailable: boolean
}

const UPDATES_TTL_MS = 30 * 60 * 1000
let updatesCache: { key: string; at: number; data: Record<string, UpdateStatus> } | null = null
/** In-flight check per profile, so the badge poll and the scheduler never
 * double-fetch a cold cache. */
let updatesInflight: { key: string; promise: Promise<Record<string, UpdateStatus>> } | null = null

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(v: string): { core: number[]; pre: string[] } | null {
  const m = SEMVER.exec(v.trim())
  if (m === null) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') }
}

/**
 * Semver precedence: negative / 0 / positive like a comparator, or null when
 * either side isn't a plain semver version. Build metadata is ignored, a
 * release outranks any prerelease of the same core, and prerelease
 * identifiers compare numerically when both are numeric (so `rc.10` > `rc.9`).
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa === null || pb === null) return null
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * True only when the registry's `latest` is semantically HIGHER than what the
 * profile has. A plain `!==` also fires when a package's `latest` dist-tag is
 * left pointing at an OLDER release than the pinned install — updating then
 * rewrote the exact pin to `@latest` and downgraded the profile (dshmarket
 * #64). Undecidable inputs report no update: without a direction we cannot
 * promise the "update" isn't a downgrade.
 */
export function isUpgrade(installed: string | null, latest: string | null): boolean {
  if (installed === null || latest === null) return false
  const cmp = compareVersions(latest, installed)
  return cmp !== null && cmp > 0
}

/** Drop the cached listing (after a successful install/update/uninstall). */
export function invalidateUpdates(): void {
  updatesCache = null
}

/**
 * The cached listing only — never touches the network. The scheduled
 * background check keeps this warm; /status uses it to report an update
 * count without paying a registry round-trip on every poll.
 */
export function cachedUpdates(profileDirPath: string): Record<string, UpdateStatus> | null {
  return updatesCache?.key === profileDirPath ? updatesCache.data : null
}

/** Count of plugins with an available update, from the cache; 0 when cold. */
export function cachedUpdateCount(profileDirPath: string): number {
  const data = cachedUpdates(profileDirPath)
  if (data === null) return 0
  return Object.values(data).filter(status => status.updateAvailable).length
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-install' },
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as unknown
}

/** The registry's current `latest` version for a package, or null when it can't be read. */
export async function fetchNpmLatest(name: string): Promise<string | null> {
  try {
    const meta = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)) as { version?: string }
    return typeof meta.version === 'string' ? meta.version : null
  } catch {
    return null
  }
}

/** The repo's current HEAD commit, or null when GitHub's API can't be read. */
export async function fetchGithubHead(repo: string): Promise<string | null> {
  try {
    const head = (await fetchJson(`https://api.github.com/repos/${repo}/commits/HEAD`)) as { sha?: string }
    return typeof head.sha === 'string' ? head.sha : null
  } catch {
    return null
  }
}

/** A github: dependency spec reduced to `owner/repo`, or null for other specs. */
export function githubRepoOf(spec: string): string | null {
  const gh = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
  return gh !== null && spec.startsWith('github:') ? gh[1] : null
}

/**
 * Per-plugin update checks; a failed check reports no update rather than
 * failing the listing.
 */
export async function checkUpdates(profileDirPath: string, force = false): Promise<Record<string, UpdateStatus>> {
  if (!force && updatesCache?.key === profileDirPath && Date.now() - updatesCache.at < UPDATES_TTL_MS) {
    return updatesCache.data
  }
  if (!force && updatesInflight?.key === profileDirPath) return updatesInflight.promise
  const promise = runUpdateCheck(profileDirPath)
  updatesInflight = { key: profileDirPath, promise }
  try {
    return await promise
  } finally {
    if (updatesInflight?.promise === promise) updatesInflight = null
  }
}

async function runUpdateCheck(profileDirPath: string): Promise<Record<string, UpdateStatus>> {
  const specs = readInstalledSpecs(profileDirPath)
  const lockCommits = readLockCommits(profileDirPath)
  const result: Record<string, UpdateStatus> = {}
  await Promise.all(Object.entries(specs).map(async ([name, spec]) => {
    const version = readInstalledVersion(profileDirPath, name)
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false }
      return
    }
    const repo = githubRepoOf(spec)
    try {
      if (repo !== null) {
        const current = lockCommits.get(repo.toLowerCase()) ?? null
        const latest = await fetchGithubHead(repo)
        result[name] = {
          kind: 'github', version, current, latest,
          updateAvailable: current !== null && latest !== null && current !== latest,
        }
      } else {
        const latest = await fetchNpmLatest(name)
        result[name] = {
          kind: 'npm', version, current: version, latest,
          updateAvailable: isUpgrade(version, latest),
        }
      }
    } catch {
      result[name] = { kind: repo !== null ? 'github' : 'npm', version, current: null, latest: null, updateAvailable: false }
    }
  }))
  updatesCache = { key: profileDirPath, at: Date.now(), data: result }
  return result
}
