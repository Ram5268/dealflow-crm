import type { Metadata, Viewport } from 'next'
import './globals.css'
import { AppShell } from '@/components/shell/AppShell'
import { THEME_INIT_SCRIPT } from '@/lib/ui/theme'

export const metadata: Metadata = {
  title: 'DealFlow CRM',
  description: 'Private single-seat CRM + dialer for a solo NYC broker.',
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // TODO: auth wiring — displayName comes from the session once auth exists.
  const displayName = process.env.USER_DISPLAY_NAME || 'You'

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Paints the stored theme before first paint — no FOUC (brief §6). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <AppShell displayName={displayName}>{children}</AppShell>
      </body>
    </html>
  )
}
