import { getProfileInfo } from '@/lib/settings/queries'
import { findSettingsSection } from '@/lib/settings/nav'
import { NotSet, SettingsCard, SettingsPanel, SettingsRow } from '@/components/settings/SettingsPanel'

export const dynamic = 'force-dynamic'

const SECTION = findSettingsSection('profile')!

/**
 * Profile is READ-ONLY (M5 §4). There is no UserProfile model and no auth, and
 * the brief said not to create one — so rather than render inputs that cannot
 * save, every field is displayed with the source it came from.
 */
export default async function ProfileSettingsPage() {
  const profile = await getProfileInfo()

  return (
    <SettingsPanel title={SECTION.label} blurb={SECTION.blurb}>
      <SettingsCard
        title="Account"
        footer="Read-only. Editable when auth lands — there is no profile model or signed-in session to write to yet."
      >
        <dl>
          <SettingsRow
            label="Display name"
            value={profile.displayName}
            caption={
              profile.source.name === 'db'
                ? 'From your user record.'
                : profile.source.name === 'env'
                  ? 'From USER_DISPLAY_NAME.'
                  : 'No user record or USER_DISPLAY_NAME set.'
            }
          />
          <SettingsRow
            label="Email"
            value={profile.email ?? <NotSet />}
            caption={
              profile.source.email === 'db'
                ? 'From your user record.'
                : 'No user record — sign-in will supply this.'
            }
          />
          <SettingsRow
            label="Timezone"
            hint="Env-configured"
            value={profile.timezone}
            caption="Used for day boundaries in Focus and the calling window."
          />
        </dl>
      </SettingsCard>
    </SettingsPanel>
  )
}
