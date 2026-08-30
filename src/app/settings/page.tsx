import { redirect } from 'next/navigation'
import { DEFAULT_SETTINGS_SLUG, settingsHref } from '@/lib/settings/nav'

// Bare /settings lands on the first section (M5 §3).
export default function SettingsIndexPage() {
  redirect(settingsHref(DEFAULT_SETTINGS_SLUG))
}
