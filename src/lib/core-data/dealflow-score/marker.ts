// Brief 45 (PR F): how a DealFlowDerivedSignal row written by an upload's
// scoring is told apart from one the 7:00 morning sync copied.
//
// Both kinds sit in the same table, and the morning sync overwrites an
// upload's row when DealFlow's next call list includes that seller. Two clocks
// read this table and must keep meaning "the morning update"
// (src/lib/core-data/lists/sql.ts rankingTimesSql):
//   - "ranked 7:02" is the newest syncedAt;
//   - the ranking cutoff (the newest list's generatedAt) decides whether an
//     unscored lead shows "scoring…" or "not ranked: no match".
// So an upload's rows carry dealflowRawJson.source = IMPORT_SCORING_SOURCE (and
// no generatedAt or generation run id), and both clocks skip them
// [engineering precaution, Brief 45 PR E review].
export const IMPORT_SCORING_SOURCE = 'import-scoring'
