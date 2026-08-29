'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import {
  THEME_STORAGE_KEY,
  isTheme,
  resolveTheme,
  type ResolvedTheme,
  type Theme,
} from '@/lib/ui/theme'

interface ThemeContextValue {
  theme: Theme
  resolved: ResolvedTheme
  setTheme: (t: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start at 'system' on both server and first client render so hydration
  // matches; the stored value is adopted in the effect below. The <head> script
  // has already painted the right palette, so this never flashes.
  const [theme, setThemeState] = useState<Theme>('system')
  const [resolved, setResolved] = useState<ResolvedTheme>('light')

  const apply = useCallback((next: Theme) => {
    const prefersDark =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    const r = resolveTheme(next, prefersDark)
    document.documentElement.setAttribute('data-theme', r)
    setResolved(r)
  }, [])

  useEffect(() => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY)
    } catch {
      // Private mode / blocked storage — fall through to 'system'.
    }
    const initial = isTheme(stored) ? stored : 'system'
    setThemeState(initial)
    apply(initial)
  }, [apply])

  // Follow the OS only while the user has not made an explicit choice.
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme, apply])

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next)
      apply(next)
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next)
      } catch {
        // Non-fatal: the theme still applies for this session.
      }
    },
    [apply],
  )

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
