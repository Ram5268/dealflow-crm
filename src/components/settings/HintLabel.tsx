'use client'

import { Tooltip } from '@/components/ui'

/**
 * A field label carrying a hover hint ("Env-configured"). Isolated in its own
 * client file so SettingsRow — and every settings page — stays a Server
 * Component; Radix Tooltip needs a client boundary.
 */
export function HintLabel({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip content={hint}>
      <span
        tabIndex={0}
        className="cursor-help border-b border-dotted border-line text-xs text-muted"
      >
        {label}
      </span>
    </Tooltip>
  )
}
