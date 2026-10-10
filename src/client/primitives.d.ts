/** Minimal ambient types for the primitives the browser half uses, matching
 * @deepseek-ai/dsh-client-ui-primitives (provided by the host's frozen
 * platform module table; never bundled). Members are reached through a
 * structural table with plain-element fallbacks, so only the module shape
 * matters here — a renamed primitive degrades instead of blanking the page
 * (the 0.3.11 lesson). */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement, ReactNode } from 'react'

  export function Button(props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    className?: string | undefined
    disabled?: boolean
    title?: string | undefined
    onClick?: () => void
    children?: ReactNode
  }): ReactElement | null

  export function Tag(props: {
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string | undefined
    children?: ReactNode
  }): ReactElement | null
}
