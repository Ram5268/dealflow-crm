'use client'

// Brief 45 — small browser helpers shared by the sidebar and the list pages.
import { ListsApiError } from '@/lib/core-data/lists/client'

/** The API's own plain-English message, or a plain one when the CRM couldn't be reached. */
export function messageOf(err: unknown): string {
  if (err instanceof ListsApiError) return err.message
  return "Couldn't reach the CRM just now. Check the connection and try again."
}

/** Save a file from a same-origin URL (the CSV routes answer with an attachment). */
export function downloadUrl(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Save text made in the browser (e.g. the selected rows as CSV). */
export function downloadText(text: string, filename: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
