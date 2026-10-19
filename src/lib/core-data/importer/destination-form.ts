// Brief 45 (PR F): the destination step's choice as the browser holds it, and
// how it travels: as form fields with the upload (POST /api/imports) and as
// JSON for the check before the file is sent (POST /api/imports/destination).
// Browser-safe: the name rule is the lists API's own (PR A rules.ts), so the
// page refuses exactly what the server would, with the same words; the server
// checks again (and is the only judge of a name that is already taken).
import { nameProblem } from '@/lib/core-data/lists/rules'

export type DestinationChoice =
  | { mode: 'list'; listId: string }
  /** folderId '' = No folder (the list sits outside any folder [Ryan, 2026-10-18]). */
  | { mode: 'new'; name: string; folderId: string }

export const DESTINATION_FIELDS = {
  listId: 'listId',
  newListName: 'newListName',
  newListFolderId: 'newListFolderId',
} as const

export const PICK_A_LIST = 'Pick a list, or choose "A new list".'

/** The plain-English problem with the choice, or null when it can be sent. */
export function choiceProblem(choice: DestinationChoice): string | null {
  if (choice.mode === 'list') return choice.listId ? null : PICK_A_LIST
  return nameProblem(choice.name)
}

export function destinationFormFields(choice: DestinationChoice): [string, string][] {
  return choice.mode === 'list'
    ? [[DESTINATION_FIELDS.listId, choice.listId]]
    : [
        [DESTINATION_FIELDS.newListName, choice.name],
        [DESTINATION_FIELDS.newListFolderId, choice.folderId],
      ]
}

export type DestinationJson = { listId: string } | { newList: { name: string; folderId: string | null } }

export function destinationJson(choice: DestinationChoice): DestinationJson {
  return choice.mode === 'list' ? { listId: choice.listId } : { newList: { name: choice.name, folderId: choice.folderId || null } }
}
