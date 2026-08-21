/** Settings → Plugins “Install” tab: third-party plugin install/uninstall,
 * mount pausing, and (in standalone dsh) self-restart. Pure presentation
 * layer: receives everything through injected props. The stylesheet rides
 * the host's --dsw-* tokens (same design language as the plugin-inventory
 * tab) so light and dark themes both stay correct. */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconDownloadOutline16,
  IconRefreshOutline14,
  Modal,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { setNavBadgeCount } from './navBadge.ts'
import type { Translate } from './index.ts'

/** One installed plugin's card row, as served by /status and /installed. */
export interface PluginRow {
  name: string
  version: string | null
  description: string | null
  /** Repository as a browsable https URL, when derivable; null otherwise. */
  repository: string | null
  /** False while the running composition holds the plugin paused. */
  mounted: boolean
  /** False when the bundle patch resists row-level disabling. */
  toggleable: boolean
  /** True for the installer itself — paused only by uninstalling it. */
  self: boolean
}

/** Injected business face: HTTP calls to the installer host routes. */
export interface InstallTabInjected {
  status(): Promise<InstallStatus>
  install(spec: string): Promise<InstallOutcome>
  checkUpdates(force?: boolean): Promise<UpdatesResponse>
  update(name: string): Promise<InstallOutcome>
  uninstall(name: string): Promise<InstallOutcome>
  mount(name: string, enabled: boolean): Promise<MountResponse>
  cancel(): Promise<void>
  /** Desktop bridge restart (supervised sidecar); standalone dsh ignores it. */
  restart(): void
  /** Standalone self-restart: resolves once the relaunched host answers. */
  restartWeb(): Promise<void>
  desktop: boolean
}

export interface InstallStatus {
  desktop: boolean
  active: boolean
  target: string
  lastLine: string
  lastError: string | null
  cancelling: boolean
  installed: string[]
  plugins: PluginRow[]
  updatesAvailable: number
}

export interface InstallOutcome {
  ok: boolean
  hot: boolean
  cancelled?: boolean
  error?: string
  staleRegistry?: boolean
  /** Version actually present after an update add; null = no package dir. */
  resolvedVersion?: string | null
  /** Registry version the update was expected to land on. */
  expectedVersion?: string
  installed: string[]
}

/** Mount-toggle response: the effective card rows after the write. */
export interface MountResponse {
  ok: boolean
  name: string
  mounted: boolean
  plugins: PluginRow[]
  installed: string[]
  error?: string
}

/** Server-side update check result for one installed plugin. */
export interface UpdateStatus {
  kind: 'npm' | 'github' | 'linked' | 'unknown'
  version: string | null
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

export interface UpdatesResponse {
  updates: Record<string, UpdateStatus>
}

/** Scoped class prefix; the sheet is injected once with the tab. */
const CSS = `
.dpi-section{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}
.dpi-head{display:flex;align-items:center;gap:8px}
.dpi-head h3{margin:0;font-size:13px;line-height:20px;font-weight:600}
.dpi-mode{display:inline-flex;align-items:center;min-height:20px;border-radius:5px;padding:1px 6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.dpi-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dpi-installRow{display:flex;gap:8px;align-items:center}
.dpi-field{position:relative;flex:1;display:flex;align-items:center;color:var(--dsw-alias-label-tertiary)}
.dpi-field>svg{position:absolute;left:12px;pointer-events:none}
.dpi-field input{width:100%;height:36px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 12px 0 34px;outline:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dpi-field input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dpi-field input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.dpi-progress{display:flex;align-items:center;gap:8px;min-height:20px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dpi-progressLine{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code)}
.dpi-banner{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3)}
.dpi-banner[data-kind='ok']{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.dpi-banner[data-kind='error']{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dpi-dot{flex:none;margin-top:5px}
.dpi-bannerBody{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:20px}
.dpi-bannerHint{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dpi-errorText{margin:0;overflow-wrap:anywhere;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dpi-hintText{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dpi-listHead{display:flex;align-items:baseline;gap:7px;padding:0 2px;margin-top:2px}
.dpi-listHead h3{margin:0;font-size:13px;line-height:20px;font-weight:600}
.dpi-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dpi-spacer{flex:1}
.dpi-refresh{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dpi-refresh:hover{background:var(--dsw-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dpi-refresh:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dpi-empty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dpi-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch;gap:10px;margin:0;padding:0;list-style:none}
.dpi-card{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;min-height:52px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);padding:12px 12px 12px 14px}
.dpi-card:hover{background:var(--dsw-interactive-bg-hover)}
.dpi-card[data-paused='1']{border-style:dashed}
.dpi-cardMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dpi-titleRow{display:flex;align-items:center;gap:6px;min-width:0}
.dpi-cardTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;font-weight:600}
.dpi-card[data-paused='1'] .dpi-cardTitle{color:var(--dsw-alias-label-secondary)}
.dpi-src{flex:none;display:inline-flex;align-items:center;min-height:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:0 5px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;text-decoration:none;white-space:nowrap}
.dpi-src:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}
.dpi-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dpi-cardActions{display:flex;align-items:center;gap:6px;flex:none}
.dpi-meta{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dpi-metaUpdate{color:var(--dsw-alias-state-success-primary);font-weight:600}
.dpi-metaPaused{color:var(--dsw-alias-state-warning-primary);font-weight:600}
.dpi-listActions{display:flex;align-items:center;gap:6px}
@media(max-width:680px){.dpi-cards{grid-template-columns:minmax(0,1fr)}}
`

/** One installed card's version/update line; null before any check. */
function CardMeta(props: { status: UpdateStatus | undefined; row: PluginRow; t: Translate }): ReactElement | null {
  const { status, row, t } = props
  const paused = row.mounted ? null : <span className="dpi-meta dpi-metaPaused">{t('paused')}</span>
  if (status === undefined) return paused
  const version = status.version !== null ? `v${status.version}` : ''
  if (status.kind === 'linked') {
    return <span className="dpi-meta">{paused}{version !== '' ? `${version} · ` : ''}{t('linkedLocal')}</span>
  }
  if (status.updateAvailable) {
    if (status.kind === 'github') return <span className="dpi-meta">{paused}<span className="dpi-metaUpdate">{t('newCommits')}</span></span>
    if (status.current !== null && status.latest !== null) {
      return <span className="dpi-meta">{paused}<span className="dpi-metaUpdate">v{status.current} → v{status.latest}</span></span>
    }
    return <span className="dpi-meta">{paused}<span className="dpi-metaUpdate">{t('updateAvailable')}</span></span>
  }
  if (version !== '' && status.latest !== null) return <span className="dpi-meta">{paused}{version} · {t('upToDate')}</span>
  if (version !== '') return <span className="dpi-meta">{paused}{version}</span>
  return paused
}

export function InstallTab(props: { t: Translate; injected: InstallTabInjected }): ReactElement {
  const { t, injected } = props
  const [spec, setSpec] = useState('')
  const [plugins, setPlugins] = useState<PluginRow[] | null>(null)
  const [updates, setUpdates] = useState<Record<string, UpdateStatus> | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lastLine, setLastLine] = useState('')
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null)
  const [op, setOp] = useState<'install' | 'update' | 'uninstall' | 'mount'>('install')
  const [mountDone, setMountDone] = useState<{ name: string; mounted: boolean } | null>(null)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [restartFailed, setRestartFailed] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let current = true
    void injected.status().then(
      (status) => { if (current) { setPlugins(status.plugins); setBusy(status.active) } },
      () => { if (current) setPlugins([]) },
    )
    // Opening the page checks updates on its own — non-forced, so the
    // server's TTL cache answers instantly when the scheduled check is
    // fresh, and a cold cache costs one deduped registry pass. The button
    // remains for an immediate re-check.
    void doCheckUpdates(false)
    return () => { current = false }
  }, [injected, reload])

  // While an operation runs, poll the host for its live progress line.
  useEffect(() => {
    if (!busy) { setLastLine(''); return }
    let current = true
    const timer = setInterval(() => {
      void injected.status().then(
        (status) => { if (current) setLastLine(status.lastLine) },
        () => undefined,
      )
    }, 1200)
    return () => { current = false; clearInterval(timer) }
  }, [busy, injected])

  // Transport-level failures (route crash, 409 race, offline) carry no
  // outcome body — fold them into the same failed-outcome banner instead of
  // vanishing as unhandled rejections.
  const setFailedOutcome = (error: unknown, what: 'install' | 'update' | 'uninstall' | 'mount' = 'install'): void => {
    setOp(what)
    setMountDone(null)
    setOutcome({ ok: false, hot: false, error: error instanceof Error ? error.message : String(error), installed: [] })
  }

  const refreshAfterOp = (): void => {
    setReload((value) => value + 1)
  }

  const doInstall = async (): Promise<void> => {
    const trimmed = spec.trim()
    if (trimmed === '') return
    setBusy(true)
    setOp('install')
    setMountDone(null)
    setOutcome(null)
    try {
      const result = await injected.install(trimmed)
      setOutcome(result)
      if (result.ok) {
        setSpec('')
        void doCheckUpdates(false)
      }
      refreshAfterOp()
    } catch (error) {
      setFailedOutcome(error)
    } finally {
      setBusy(false)
    }
  }

  const doUpdate = async (name: string): Promise<void> => {
    setBusy(true)
    setOp('update')
    setMountDone(null)
    setOutcome(null)
    try {
      const result = await injected.update(name)
      setOutcome(result)
      if (result.ok) void doCheckUpdates(false)
      refreshAfterOp()
    } catch (error) {
      setFailedOutcome(error, 'update')
    } finally {
      setBusy(false)
    }
  }

  const doUninstall = async (): Promise<void> => {
    if (confirmName === null) return
    setBusy(true)
    setOp('uninstall')
    setMountDone(null)
    try {
      const result = await injected.uninstall(confirmName)
      setOutcome(result)
      setUpdates(current => {
        if (current === null) return null
        const next = { ...current }
        delete next[confirmName]
        return next
      })
      refreshAfterOp()
    } catch (error) {
      setFailedOutcome(error, 'uninstall')
    } finally {
      setBusy(false)
      setConfirmName(null)
    }
  }

  // Pause/resume a plugin's composition rows; the profile patch layer is
  // watched live, so the new state applies without a restart.
  const doMount = async (row: PluginRow, enabled: boolean): Promise<void> => {
    setBusy(true)
    setOp('mount')
    setOutcome(null)
    try {
      const result = await injected.mount(row.name, enabled)
      setPlugins(result.plugins)
      setMountDone({ name: result.name, mounted: result.mounted })
      setOutcome({ ok: result.ok, hot: true, error: result.error, installed: result.installed })
      refreshAfterOp()
    } catch (error) {
      setFailedOutcome(error, 'mount')
    } finally {
      setBusy(false)
    }
  }

  // A fresh check after an operation re-reads the server cache, which the
  // operation itself just invalidated; force=false is enough.
  const doCheckUpdates = async (force = true): Promise<void> => {
    if (checking || busy) return
    setChecking(true)
    try {
      const response = await injected.checkUpdates(force)
      setUpdates(response.updates)
      setNavBadgeCount(Object.values(response.updates).filter(status => status.updateAvailable).length)
    } catch {
      setUpdates({})
    } finally {
      setChecking(false)
    }
  }

  const doRestart = async (): Promise<void> => {
    if (injected.desktop) {
      injected.restart()
      return
    }
    setRestarting(true)
    setRestartFailed(false)
    try {
      await injected.restartWeb()
    } catch {
      setRestartFailed(true)
    } finally {
      setRestarting(false)
    }
  }

  const restartControl = (
    <Button variant="ghost" size="sm" disabled={busy || restarting} onClick={() => void doRestart()}>
      {restarting ? t('restarting') : t('restartBtn')}
    </Button>
  )

  return (
    <div className="dpi-section">
      <style>{CSS}</style>

      <div className="dpi-head">
        <h3>{t('title')}</h3>
        <span className="dpi-mode">{injected.desktop ? t('desktopMode') : t('normalMode')}</span>
      </div>
      <p className="dpi-intro">{t('intro')}</p>

      <div className="dpi-installRow">
        <label className="dpi-field">
          <IconDownloadOutline16 aria-hidden="true" />
          <input
            placeholder={t('specPh')}
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void doInstall() }}
          />
        </label>
        <Button variant="primary" disabled={busy || spec.trim() === ''} onClick={() => void doInstall()}>
          {busy ? t('installing') : t('install')}
        </Button>
      </div>

      {busy && (
        <div className="dpi-progress">
          <StateDot state="ongoing" size={10} />
          <span className="dpi-progressLine">{lastLine !== '' ? lastLine : t('installing')}</span>
          <Button variant="ghost" size="sm" onClick={() => void injected.cancel()}>{t('cancelOp')}</Button>
        </div>
      )}

      {outcome !== null && (
        <div className="dpi-banner" data-kind={outcome.ok ? 'ok' : 'error'} role="status">
          <StateDot className="dpi-dot" state={outcome.ok ? 'done' : 'error'} size={10} />
          <div className="dpi-bannerBody">
            {op === 'mount'
              ? (outcome.ok
                  ? <span>{mountDone !== null && mountDone.mounted ? t('resumeDone') : t('pauseDone')} — {t('liveNow')}</span>
                  : <span>{t('toggleFailed')}</span>)
              : (outcome.ok
                  ? <span>{op === 'update' ? t('updateSuccess') : op === 'uninstall' ? t('uninstallSuccess') : t('success')} — {outcome.hot ? t('hotReady') : t('restartNeeded')}</span>
                  : <span>{op === 'update' ? t('updateFailed') : op === 'uninstall' ? t('uninstallFailed') : t('failed')}</span>)}
            {!outcome.ok && outcome.error !== undefined && <p className="dpi-errorText">{outcome.error}</p>}
            {!outcome.ok && outcome.staleRegistry === true && <p className="dpi-hintText">{t('staleHint')}</p>}
            {outcome.ok && op !== 'mount' && outcome.expectedVersion !== undefined && outcome.resolvedVersion != null
              && outcome.resolvedVersion !== outcome.expectedVersion && (
              <p className="dpi-hintText">
                {t('resolvedMismatch')
                  .replace('{resolved}', outcome.resolvedVersion)
                  .replace('{expected}', outcome.expectedVersion)}
              </p>
            )}
            {outcome.ok && op !== 'mount' && !outcome.hot && (
              <span className="dpi-bannerHint">{restartControl}</span>
            )}
          </div>
        </div>
      )}

      {restartFailed && (
        <div className="dpi-banner" data-kind="error" role="status">
          <StateDot className="dpi-dot" state="error" size={10} />
          <div className="dpi-bannerBody">
            <span>{t('restartFailedTitle')}</span>
            <p className="dpi-hintText">{t('restartTimeout')}</p>
          </div>
        </div>
      )}

      <div className="dpi-listHead">
        <h3>{t('installedHeading')}</h3>
        {plugins !== null && <span className="dpi-count">{plugins.length}</span>}
        <span className="dpi-spacer" />
        <div className="dpi-listActions">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || checking || plugins === null || plugins.length === 0}
            onClick={() => void doCheckUpdates()}
          >
            {checking ? t('checking') : t('checkUpdates')}
          </Button>
          {restartControl}
          <button
            type="button"
            className="dpi-refresh"
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >
            <IconRefreshOutline14 size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {plugins === null && <p className="dpi-empty">{t('loading')}</p>}
      {plugins !== null && plugins.length === 0 && <p className="dpi-empty">{t('empty')}</p>}
      {plugins !== null && plugins.length > 0 && (
        <ul className="dpi-cards">
          {plugins.map((row) => (
            <li className="dpi-card" data-paused={row.mounted ? undefined : '1'} key={row.name}>
              <div className="dpi-cardMain">
                <div className="dpi-titleRow">
                  <strong className="dpi-cardTitle" title={row.name}>{row.name}</strong>
                  {row.repository !== null && (
                    <a className="dpi-src" href={row.repository} target="_blank" rel="noopener noreferrer">
                      {t('source')}
                    </a>
                  )}
                </div>
                {row.description !== null && <span className="dpi-desc" title={row.description}>{row.description}</span>}
                <CardMeta status={updates?.[row.name]} row={row} t={t} />
              </div>
              <div className="dpi-cardActions">
                {updates?.[row.name]?.updateAvailable === true && (
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void doUpdate(row.name)}>
                    {t('updateBtn')}
                  </Button>
                )}
                {row.toggleable && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void doMount(row, !row.mounted)}>
                    {row.mounted ? t('pause') : t('resume')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmName(row.name)}>
                  {t('uninstall')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={confirmName !== null}
        onClose={() => setConfirmName(null)}
        title={t('confirmRemove')}
        description={confirmName ?? undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmName(null)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void doUninstall()}>{t('uninstall')}</Button>
          </>
        }
      >
        <p>{t('confirmWarn')}</p>
      </Modal>
    </div>
  )
}
