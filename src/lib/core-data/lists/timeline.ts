// Brief 45 — the lead timeline entries for group changes [brief §5.3;
// CONTRACT §5]. An Activity of type 'Group', no user, written in the same
// transaction as the change and only when something really changed.
// "Group" entries are labels, not contact: nothing that measures contact may
// count them (the Pipeline's "last contact" reads Call, Email and SMS only).
import type { Tx } from './sql'

export const GROUP_ACTIVITY_TYPE = 'Group'

export const addedTo = (group: string) => `Added to ${group}`
export const removedFrom = (group: string) => `Removed from ${group}`
export const removedByDelete = (group: string) => `Removed from ${group} (group deleted)`

export async function writeGroupEntries(
  tx: Tx,
  organizationId: string,
  leadIds: readonly string[],
  bodyText: string,
  at: Date,
): Promise<void> {
  if (leadIds.length === 0) return
  await tx.activity.createMany({
    data: leadIds.map((leadId) => ({
      organizationId, leadId, userId: null, type: GROUP_ACTIVITY_TYPE, activityAt: at, bodyText,
    })),
  })
}
