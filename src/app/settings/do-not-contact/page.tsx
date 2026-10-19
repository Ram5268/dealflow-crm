import { getDoNotContactList } from '@/lib/settings/queries'
import { DoNotContactView } from './DoNotContactView'

export const dynamic = 'force-dynamic'

/**
 * Brief 47 (PR 5): Settings → Do not contact. The form adds an opt-out through
 * the existing route; the list is read here, on the server, with only each
 * number's last 4 digits (see DoNotContactView).
 */
export default async function DoNotContactSettingsPage() {
  return <DoNotContactView list={await getDoNotContactList()} />
}
