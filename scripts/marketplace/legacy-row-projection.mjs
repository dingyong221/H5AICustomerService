// Compare every pre-runtime business field across additive migrations. New
// knowledge result data must remain NULL on these seeded completed legacy jobs.
export function legacyRowJson(table, row) {
  if (table !== 'job') return JSON.stringify(row);
  if (Object.hasOwn(row, 'result') && row.result !== null)
    throw Error('Unexpected knowledge result on a retained legacy job');
  const legacy = { ...row };
  delete legacy.claim_generation;
  delete legacy.model_outcome;
  delete legacy.model_attempt_id;
  delete legacy.result;
  return JSON.stringify(legacy);
}
