'use client'

import './globals.css'
import { useEffect } from 'react'
import { ThemeProvider } from '@/components/theme/ThemeProvider'
import { ErrorScreen, logPageError, retryOf, type ErrorPageProps } from '@/components/ErrorScreen'
import { THEME_INIT_SCRIPT } from '@/lib/ui/theme'

// Brief 50 PR 2: the last resort, when the app's frame itself (the root layout:
// sidebar, top bar, phone bar) breaks. It replaces the whole document, so it
// brings its own <html>/<body>, the styles, and the light/dark theme: the head
// script paints it before first paint, and ThemeProvider paints it again when
// this page is drawn in the browser (React rebuilds <html> without the theme).
// It leans on nothing from the app's frame (no toasts, no tooltips, no
// in-app links): "Go to Focus" is a plain link, a full page load.
export default function GlobalError(props: ErrorPageProps) {
  const { error } = props
  useEffect(() => {
    logPageError('whole app', error)
  }, [error])

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Something went wrong · DealFlow CRM</title>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <main className="flex min-h-screen items-center justify-center bg-bg px-4">
            <ErrorScreen
              title="Something went wrong on this page"
              description="The CRM couldn't load. Try again in a moment, or start over from Focus."
              digest={error.digest}
              onRetry={retryOf(props)}
              backHref="/"
              backLabel="Go to Focus"
              fullReload
            />
          </main>
        </ThemeProvider>
      </body>
    </html>
  )
}
