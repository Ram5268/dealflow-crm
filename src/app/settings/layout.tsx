import { SettingsRail } from '@/components/settings/SettingsRail'

/**
 * Shell for every /settings/* page: the rail persists, only the panel swaps
 * (M5 §3). AppShell already owns <main> and the top-bar title, so this renders
 * a plain flex row.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      <SettingsRail />
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
