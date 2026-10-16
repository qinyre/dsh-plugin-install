/** Detail-page slot entries for the Plugins page: an update tag beside the
 * title (`plugins.detail.badge`) and an Update/Restart control in the head
 * actions (`plugins.detail.actions`). Both render only for a bundle subject
 * with a pending update and read the shared store through
 * useSyncExternalStore, so they move with the same state the list rows do.
 *
 * Host primitives (Tag/Button) resolve through the platform module table
 * where a missing name is undefined rather than a link error — each falls
 * back to a plain element so a primitives rename degrades instead of
 * blanking the page (the 0.3.11 lesson). */

import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { snapshot, subscribe, updatePlugin, restartHost, uninstallPlugin, type UpdateStatus } from './store.ts'

export type Translate = (key: string) => string

/** This plugin's own package name — never offers to uninstall itself. */
const SELF_PACKAGE = 'dsh-plugin-install'

/** The subject a detail contribution renders with (structural subset). */
export interface DetailSubject {
  kind: 'bundle' | 'row' | 'item'
  pkg?: { name: string }
}

interface PrimitiveTable {
  Tag?: (props: { tone?: string; className?: string; children?: unknown }) => ReactElement | null
  Button?: (props: {
    variant?: string
    size?: string
    className?: string
    disabled?: boolean
    title?: string | undefined
    onClick?: () => void
    children?: unknown
  }) => ReactElement | null
}

const table = primitives as unknown as PrimitiveTable

function useUpdateStore(): void {
  useSyncExternalStore(subscribe, snapshot, snapshot)
}

function statusFor(subject: DetailSubject): UpdateStatus | undefined {
  if (subject.kind !== 'bundle' || subject.pkg === undefined) return undefined
  return snapshot().updates[subject.pkg.name]
}

/** The green tag beside a detail title: 「可更新 x.y.z」 (npm) or 「有新提交」
 * (github); nothing when the package is current. */
export function UpdateBadge({ subject, t }: { subject: DetailSubject; t: Translate }): ReactElement | null {
  useUpdateStore()
  const status = statusFor(subject)
  if (status?.updateAvailable !== true) return null
  const label = status.kind === 'github'
    ? t('newCommits')
    : status.latest !== null
      ? t('badgeUpdate').replace('{version}', status.latest)
      : t('updateAvailable')
  const Tag = table.Tag
  if (typeof Tag !== 'function') {
    return h('span', { className: 'dpi-updateTag', style: { color: 'var(--dsw-alias-state-success-primary)' } }, label)
  }
  return h(Tag, { tone: 'success' }, label)
}

/** The head-action control: 更新 while an update is available, 重启 once one
 * has been fetched and awaits the activating restart. */
export function UpdateAction({ subject, t }: { subject: DetailSubject; t: Translate }): ReactElement | null {
  useUpdateStore()
  const name = subject.kind === 'bundle' ? subject.pkg?.name : undefined
  if (name === undefined) return null
  const state = snapshot()
  const status = state.updates[name]
  const op = state.ops[name]
  const available = status?.updateAvailable === true
  if (!available && op !== 'updated') return null
  const updating = available && op === 'updating'
  const error = op !== undefined && typeof op === 'object' ? op.error : undefined
  const label = available ? (updating ? t('updating') : error !== undefined ? t('updateFailed') : t('updateBtn')) : t('restartShort')
  const Button = table.Button
  if (typeof Button !== 'function') {
    return h('button', {
      type: 'button',
      disabled: updating,
      title: error,
      onClick: () => { void (available ? updatePlugin(name) : restartHost()) },
      style: { cursor: updating ? 'default' : 'pointer' },
    }, label)
  }
  return h(Button, {
    variant: 'primary',
    size: 'sm',
    disabled: updating,
    title: error,
    onClick: () => { void (available ? updatePlugin(name) : restartHost()) },
  }, label)
}

/** The head-action fallback removal control: 强制卸载 beside the official
 * 卸载. It routes through the installer's own cooldown-free remove, so it
 * works where the official one is refused by the bundled pnpm's whole-lockfile
 * publish-window audit (DSH Desktop). Two clicks: the first arms a five-second
 * confirmation, the second executes; success reloads the page so the official
 * listing drops the row. Never offered for the installer itself. */
export function UninstallAction({ subject, t }: { subject: DetailSubject; t: Translate }): ReactElement | null {
  useUpdateStore()
  const [confirming, setConfirming] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => { window.clearTimeout(timerRef.current) }, [])
  const name = subject.kind === 'bundle' ? subject.pkg?.name : undefined
  if (name === undefined || name === SELF_PACKAGE) return null
  const op = snapshot().uninstalls[name]
  const error = op !== undefined && typeof op === 'object' ? op.error : undefined
  // The store marks a successful uninstall that left a remaining plugin
  // unresolvable (the removal pruned a hoisted dependency) as
  // "integrity:<pairs>" — render it as its own state, not a plain failure.
  const integrity = error !== undefined && error.startsWith('integrity:')
    ? error.slice('integrity:'.length)
    : undefined
  const busy = op === 'uninstalling'
  const label = busy
    ? t('uninstalling')
    : integrity !== undefined
      ? t('integrityBroken')
      : error !== undefined
        ? t('uninstallFailed')
        : confirming
          ? t('confirmUninstall')
          : t('forceUninstall')
  const onClick = (): void => {
    if (busy) return
    if (confirming) {
      window.clearTimeout(timerRef.current)
      setConfirming(false)
      void uninstallPlugin(name).then((ok) => { if (ok) window.location.reload() })
      return
    }
    setConfirming(true)
    timerRef.current = window.setTimeout(() => { setConfirming(false) }, 5000)
  }
  const title = integrity !== undefined
    ? `${t('integrityBroken')}: ${integrity}`
    : error !== undefined
      ? `${t('uninstallFailed')}: ${error}`
      : confirming
        ? t('confirmUninstallHint')
        : t('forceUninstallHint')
  const Button = table.Button
  if (typeof Button !== 'function') {
    return h('button', {
      type: 'button',
      disabled: busy,
      title,
      onClick,
      style: { cursor: busy ? 'default' : 'pointer' },
    }, label)
  }
  return h(Button, {
    variant: confirming ? 'danger' : undefined,
    size: 'sm',
    disabled: busy,
    title,
    onClick,
  }, label)
}
