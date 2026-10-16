/** Shared update state for the Plugins-page layer: the per-package update
 * listing, the per-package operation state behind the row/detail buttons,
 * and the restart handoff. One store feeds both the DOM painter (list rows)
 * and the React slot entries (detail pages), so every surface shows the same
 * thing. React subscribes through useSyncExternalStore; the painter polls. */

/** One package's update check, as /dsh-plugin-install/updates reports it. */
export interface UpdateStatus {
  kind: 'npm' | 'github' | 'linked' | 'unknown'
  version: string | null
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

/** Per-package operation phase: updating → updated (restart pending) → done. */
export type OpState = 'updating' | 'updated' | { error: string }

/** Per-package uninstall phase; success never lands here (the page reloads). */
export type UninstallOp = 'uninstalling' | { error: string }

export interface UpdateStore {
  updates: Record<string, UpdateStatus>
  ops: Record<string, OpState>
  uninstalls: Record<string, UninstallOp>
}

type Listener = () => void

let state: UpdateStore = { updates: {}, ops: {}, uninstalls: {} }
const listeners = new Set<Listener>()

function commit(next: UpdateStore): void {
  state = next
  for (const listener of [...listeners]) listener()
}

/** Currently published state; treat as immutable. */
export function snapshot(): UpdateStore {
  return state
}

/** Subscribe to state changes; returns the unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function patch(partial: Partial<UpdateStore>): void {
  commit({ ...state, ...partial })
}

/** Count of packages with an available update (drives the nav badge). */
export function updateCount(): number {
  return Object.values(state.updates).filter(status => status.updateAvailable).length
}

/**
 * Pull the listing (server-side TTL cache; force bypasses it). Operation
 * markers are intentionally kept: "updated" survives until the restart that
 * activates it — which reloads this document and drops it naturally.
 */
export async function refresh(force = false): Promise<void> {
  try {
    const response = await fetch(`/dsh-plugin-install/updates${force ? '?force=1' : ''}`)
    const body = (await response.json()) as { updates?: Record<string, UpdateStatus> } & { error?: string }
    if (!response.ok || body.updates === undefined) return
    patch({ updates: body.updates })
  } catch { /* offline: the last listing stands */ }
}

/**
 * Update one package, then re-read the listing. Success marks the package
 * "updated" — its button turns into the restart control — unless the host
 * reports the update already went live (hot reload); then the pending
 * marker is simply dropped. Errors surface through the op state and clear
 * themselves.
 */
export async function updatePlugin(name: string): Promise<void> {
  if (state.ops[name] === 'updating') return
  patch({ ops: { ...state.ops, [name]: 'updating' } })
  try {
    const response = await fetch('/dsh-plugin-install/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; hot?: boolean; hotNote?: string; error?: string }
    if (response.ok && body.ok === true) {
      await refresh(false)
      const ops = { ...snapshot().ops }
      if (body.hot === true) delete ops[name]
      else ops[name] = 'updated'
      patch({ ops })
    } else {
      fail(name, body.error ?? `HTTP ${response.status}`)
    }
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error))
  }
}

function fail(name: string, message: string): void {
  // The failed op persists until the next attempt on the same package, so
  // the failure is visible (row button reads 更新失败, title carries why).
  patch({ ops: { ...snapshot().ops, [name]: { error: message } } })
}

/**
 * Remove one package through the installer's own route — the cooldown-free
 * channel the official page's 卸载 lacks wherever pnpm policy-audits the
 * whole lockfile (DSH Desktop's bundled pnpm ignores the exclusion list, so
 * its uninstall fails for as long as any lockfile entry is day-one fresh).
 * Returns whether the removal succeeded; the caller reloads the page on
 * success so the official listing drops the row. Errors persist in the
 * uninstalls state for the button's tooltip.
 */
export async function uninstallPlugin(name: string): Promise<boolean> {
  if (state.uninstalls[name] === 'uninstalling') return false
  patch({ uninstalls: { ...state.uninstalls, [name]: 'uninstalling' } })
  let message: string | undefined
  try {
    const response = await fetch('/dsh-plugin-install/uninstall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      error?: string
      integrity?: { repaired: string[]; broken: Array<{ plugin: string; requirement: string }> }
    }
    if (response.ok && body.ok === true) {
      await refresh(false)
      // Uninstalled fine, but a remaining plugin lost a dependency the
      // removal pruned and the automatic re-install could not fix: surface
      // it instead of reloading, so the pairs stay readable.
      const broken = body.integrity?.broken ?? []
      if (broken.length > 0) {
        const pairs = broken.map(entry => `${entry.plugin}→${entry.requirement}`).join(', ')
        patch({ uninstalls: { ...snapshot().uninstalls, [name]: { error: `integrity:${pairs}` } } })
        return false
      }
      return true
    }
    message = body.error ?? `HTTP ${response.status}`
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  patch({ uninstalls: { ...snapshot().uninstalls, [name]: { error: message } } })
  return false
}

/** Restart the host so updated packages activate: the desktop shell
 * supervises its sidecar; standalone dsh relaunches through the installer's
 * relay and hands the tab a fresh tokened URL. */
export async function restartHost(): Promise<void> {
  if (window.dshDesktop !== undefined) {
    window.dshDesktop.restartSidecar?.()
    return
  }
  const readBoot = (): Promise<string | undefined> =>
    fetch('/dsh-plugin-install/status')
      .then(response => response.json() as Promise<{ boot?: string }>)
      .then(status => status.boot)
      .catch(() => undefined)
  const before = await readBoot()
  let handoff: string | undefined
  try {
    const response = await fetch('/dsh-plugin-install/restart', { method: 'POST' })
    const body = (await response.json().catch(() => ({}))) as { handoff?: string }
    if (response.ok) handoff = body.handoff
  } catch { /* the dying connection is expected mid-restart */ }
  const deadline = Date.now() + 90_000
  for (;;) {
    await new Promise(resolve => { setTimeout(resolve, 1000) })
    if (Date.now() > deadline) window.location.reload()
    try {
      const boot = await readBoot()
      if (boot !== undefined && boot !== before) break
    } catch { /* still down — or the old generation is still disposing */ }
  }
  if (handoff !== undefined) {
    try {
      const handed = await fetch(`/dsh-plugin-install/handoff?nonce=${encodeURIComponent(handoff)}`)
      const body = (await handed.json()) as { url?: string }
      if (handed.ok && body.url !== undefined) {
        window.location.replace(body.url)
        return
      }
    } catch { /* no handoff: reload instead */ }
  }
  window.location.reload()
}
