// Brief 45 — "New list" / "New folder" / "New group" from ⌘K open the
// sidebar's inline name box. The shell passes the request to whichever
// sidebar is on screen: the left column, or the drawer at phone width.
export type CreateKind = 'folder' | 'list' | 'group'

export interface CreateRequest {
  kind: CreateKind
  /** A fresh number per request, so asking twice opens the box twice. */
  nonce: number
}

/** Tailwind's `md` breakpoint: below it the sidebar is a drawer behind the top bar's menu button. */
export const PHONE_QUERY = '(max-width: 767.98px)'
