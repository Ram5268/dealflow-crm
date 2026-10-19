import type {
  FolderDTO, GroupDTO, ListDTO, PipelineBoard, PipelineCard, PipelineTable, WorkflowDTO,
} from '@/lib/core-data/lists/types'
import type { PipelinePageData } from '@/app/pipeline/types'

// Brief 45 PR D — made-up Pipeline data for the page's pure and render tests.
// Fictional names ("Test Owner N") and streets ("10N Example St") only.

/** A Wednesday, noon in New York. */
export const NOW = '2026-10-14T16:00:00.000Z'
export const daysBefore = (days: number, from = NOW) => new Date(new Date(from).getTime() - days * 86_400_000).toISOString()

export const HOT: GroupDTO = { id: 'g_hot', name: 'Hot', color: 'red', sortOrder: 0, memberCount: 2 }
export const NURTURE: GroupDTO = { id: 'g_nurture', name: 'Nurture', color: 'green', sortOrder: 1, memberCount: 2 }
export const APPT: GroupDTO = { id: 'g_appt', name: 'Appointment Set', color: 'blue', sortOrder: 2, memberCount: 1 }
export const GROUPS: GroupDTO[] = [HOT, NURTURE, APPT]
const chip = (g: GroupDTO) => ({ id: g.id, name: g.name, color: g.color })

export const FOLDERS: FolderDTO[] = [{ id: 'f_exp', name: 'Expireds', sortOrder: 0, listCount: 1, archivedListCount: 0 }]
export const LISTS: ListDTO[] = [
  { id: 'l_oct', name: 'Expireds – Oct 2026', folderId: 'f_exp', source: 'manual', sortOrder: 0, archivedAt: null, memberCount: 3, createdAt: daysBefore(20) },
  { id: 'l_ref', name: 'Referrals', folderId: null, source: 'manual', sortOrder: 0, archivedAt: null, memberCount: 1, createdAt: daysBefore(20) },
]

export function card(over: Partial<PipelineCard> & Pick<PipelineCard, 'leadId'>): PipelineCard {
  return {
    displayName: 'Test Owner',
    address: null,
    value: null,
    bestBuyer: null,
    lastContactAt: null,
    nextTask: null,
    inGroupSince: daysBefore(1),
    groups: [],
    alsoIn: [],
    rank: 1,
    ...over,
  }
}

// Owner 1 is in Hot and Nurture (one lead, two columns, "also in" both ways).
export const OWNER1_HOT = card({
  leadId: 'lead_1', displayName: 'Test Owner 1', address: '101 Example St', rank: 2,
  bestBuyer: { name: 'Sample Buyer Agent', score: 92, isTestData: true },
  lastContactAt: '2026-10-11T04:00:00.000Z', // "Last Contacted Date" Oct 11 (New York midnight)
  nextTask: { text: 'Call back', dueDate: '2026-10-14T18:00:00.000Z' }, // today, 2 pm New York
  inGroupSince: daysBefore(100), groups: [chip(HOT), chip(NURTURE)], alsoIn: [{ id: NURTURE.id, name: NURTURE.name }],
})
export const OWNER2_HOT = card({
  leadId: 'lead_2', displayName: 'Test Owner 2', address: '102 Example St', rank: 3,
  lastContactAt: daysBefore(45), nextTask: { text: 'Overdue follow-up', dueDate: '2026-10-10T15:00:00.000Z' },
  inGroupSince: daysBefore(40), groups: [chip(HOT)],
})
export const OWNER1_NURTURE = { ...OWNER1_HOT, inGroupSince: daysBefore(10), alsoIn: [{ id: HOT.id, name: HOT.name }] }
export const OWNER3_NURTURE = card({
  leadId: 'lead_3', displayName: 'Test Owner 3', address: '103 Example St', rank: 5,
  nextTask: { text: 'Friday check-in', dueDate: '2026-10-16T15:00:00.000Z' },
  inGroupSince: daysBefore(5), groups: [chip(NURTURE)],
})
export const OWNER4_APPT = card({
  leadId: 'lead_4', displayName: 'Test Owner 4', address: '104 Example St', rank: 4,
  lastContactAt: daysBefore(70), inGroupSince: daysBefore(1), groups: [chip(APPT)],
})

const FILTER_OPTIONS = {
  propertyTypes: ['Apartment House (5+ Units)', 'Duplex', 'Single Family Residence', 'Triplex'],
  neighborhoods: ['Bedford-Stuyvesant', 'Park Slope', 'Tribeca'],
  boroughs: ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'],
  hasValues: false,
}

/** A fresh board each call (tests mutate nothing, but compare against it). */
export function makeBoard(): PipelineBoard {
  return structuredClone({
    view: 'board',
    columns: [
      { group: HOT, count: 2, cards: [OWNER1_HOT, OWNER2_HOT], hasMore: false, page: 1 },
      { group: NURTURE, count: 2, cards: [OWNER1_NURTURE, OWNER3_NURTURE], hasMore: false, page: 1 },
      { group: APPT, count: 1, cards: [OWNER4_APPT], hasMore: false, page: 1 },
    ],
    filterOptions: FILTER_OPTIONS,
  } satisfies PipelineBoard)
}

export function makeTable(over: Partial<PipelineTable> = {}): PipelineTable {
  const row = (c: PipelineCard) => ({
    leadId: c.leadId, displayName: c.displayName, address: c.address, value: null, bestBuyer: c.bestBuyer,
    lastContactAt: c.lastContactAt, nextTask: c.nextTask, inGroupSince: c.inGroupSince, groups: c.groups, rank: c.rank,
    priorityScore: 90 - c.rank, topMatchFit: 80,
  })
  return structuredClone({
    view: 'table', rows: [OWNER1_HOT, OWNER2_HOT, OWNER4_APPT, OWNER3_NURTURE].map(row), total: 4, page: 1, pageSize: 100,
    filterOptions: FILTER_OPTIONS, ...over,
  } satisfies PipelineTable)
}

export const WORKFLOWS: WorkflowDTO[] = [
  { id: 'wf_brown', name: 'Brownstone nurtures', view: 'board', filters: { borough: 'Brooklyn' }, groupIds: [NURTURE.id], sort: null },
  { id: 'wf_exp', name: 'Expired hot leads', view: 'table', filters: { list: 'l_oct', tier: 'hot' }, groupIds: [HOT.id], sort: { key: 'lastContact', dir: 'desc' } },
]

export function pageData(over: Partial<PipelinePageData> = {}): PipelinePageData {
  return {
    query: { view: 'board', filters: {} },
    workflowId: null,
    result: makeBoard(),
    groups: GROUPS,
    folders: FOLDERS,
    lists: LISTS,
    archivedLists: [],
    workflows: WORKFLOWS,
    notices: [],
    now: NOW,
    ...over,
  }
}
