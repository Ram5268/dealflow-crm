import { ListNotFound } from './ListView'

// Brief 45 — /lists/<id> for a list that doesn't exist (deleted, a mistyped
// link, or another organization's): a real 404, in plain English.
export default function ListNotFoundPage() {
  return <ListNotFound />
}
