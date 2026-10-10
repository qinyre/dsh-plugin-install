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

import { createElement as h, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { snapshot, subscribe, updatePlugin, restartHost, type UpdateStatus } from './store.ts'

export type Translate = (key: string) => string

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
  const label = available ? (updating ? t('updating') : t('updateBtn')) : t('restartShort')
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
