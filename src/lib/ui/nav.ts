import {
  BarChart3,
  Cog,
  FileText,
  Inbox,
  Search,
  Target,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** `g <key>` sequence that jumps here, when one exists. */
  goKey?: string
  /** Shows the unread count pill. */
  badge?: 'inbox-unread'
}

/** Sidebar order mirrors Close (brief §7). Search is NOT a route — it opens ⌘K. */
export const PRIMARY_NAV: NavItem[] = [
  { href: '/', label: 'Focus', icon: Target, goKey: 'f' },
  { href: '/inbox', label: 'Inbox', icon: Inbox, goKey: 'i', badge: 'inbox-unread' },
  { href: '/leads', label: 'Leads', icon: Users, goKey: 'l' },
  { href: '/sequences', label: 'Sequences', icon: Zap, goKey: 's' },
  { href: '/templates', label: 'Templates', icon: FileText },
  { href: '/reports', label: 'Reports', icon: BarChart3 },
]

export const SETTINGS_NAV: NavItem = { href: '/settings', label: 'Settings', icon: Cog }

export const SEARCH_ICON = Search

/** Every destination the ⌘K palette can jump to. */
export const ALL_DESTINATIONS: NavItem[] = [
  ...PRIMARY_NAV,
  { href: '/dialer', label: 'Dialer', icon: Target },
  { href: '/queue', label: 'Call Queue', icon: Users },
  { href: '/imports', label: 'Imports', icon: FileText },
  SETTINGS_NAV,
]

/** True when `href` should render as the active nav item for `pathname`. */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}
