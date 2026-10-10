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

export interface UpdateStore {
  updates: Record<string, UpdateStatus>
  ops: Record<string, OpState>
}

type Listener = () => void

let state: UpdateStore = { updates: {}, ops: {} }
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
 * "updated" — its button turns into the restart control until the restart
 * lands. Errors surface through the op state and clear themselves.
 */
export async function updatePlugin(name: string): Promise<void> {
  if (state.ops[name] !== undefined) return
  patch({ ops: { ...state.ops, [name]: 'updating' } })
  try {
    const response = await fetch('/dsh-plugin-install/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (response.ok && body.ok === true) {
      await refresh(false)
      patch({ ops: { ...snapshot().ops, [name]: 'updated' } })
    } else {
      fail(name, body.error ?? `HTTP ${response.status}`)
    }
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error))
  }
}

function fail(name: string, message: string): void {
  patch({ ops: { ...snapshot().ops, [name]: { error: message } } })
  setTimeout(() => {
    const ops = { ...snapshot().ops }
    if (ops[name] !== undefined && typeof ops[name] === 'object' && (ops[name] as { error: string }).error === message) {
      delete ops[name]
      patch({ ops })
    }
  }, 6000)
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
