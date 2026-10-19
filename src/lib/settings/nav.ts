import { CreditCard, Link2, Phone, PhoneOff, ShieldCheck, User, type LucideIcon } from 'lucide-react'

export interface SettingsSection {
  slug: string
  label: string
  icon: LucideIcon
  /** One-line description shown under the page heading. */
  blurb: string
}

/**
 * The settings left rail (M5 §3). Close groups ~28 sub-pages under seven
 * headers; with six sections a flat rail is clearer, so we keep Close's visual
 * treatment (accent bar on the active row) without the grouping. See §13.2.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    slug: 'profile',
    label: 'Profile',
    icon: User,
    blurb: 'Your name, email and timezone.',
  },
  {
    slug: 'connected-accounts',
    label: 'Connected Accounts',
    icon: Link2,
    blurb: 'Mailboxes DealFlow reads and sends from.',
  },
  {
    slug: 'calling',
    label: 'Calling',
    icon: Phone,
    blurb: 'Caller ID, ring timeout and dialer pacing.',
  },
  {
    slug: 'compliance',
    label: 'Compliance',
    icon: ShieldCheck,
    blurb: 'Calling windows and suppression vendors.',
  },
  // Brief 47 (PR 5): its own section, because Compliance is display-only by
  // design (M5 §7). Adding an opt-out is the one thing this page writes.
  {
    slug: 'do-not-contact',
    label: 'Do not contact',
    icon: PhoneOff,
    blurb: 'Numbers this CRM will never call or text.',
  },
  {
    slug: 'usage',
    label: 'Usage',
    icon: CreditCard,
    blurb: 'Month-to-date telephony spend against the cap.',
  },
]

/** The section every bare `/settings` visit lands on. */
export const DEFAULT_SETTINGS_SLUG = SETTINGS_SECTIONS[0].slug

export function settingsHref(slug: string): string {
  return `/settings/${slug}`
}

export function findSettingsSection(slug: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.slug === slug)
}

/**
 * Active-row test for the rail. Exact match only: settings sections have no
 * nested routes, so a `startsWith` here would light up two rows the moment one
 * slug becomes a prefix of another (`calling` / `calling-hours`).
 */
export function isActiveSettingsPath(pathname: string, slug: string): boolean {
  return pathname === settingsHref(slug)
}
