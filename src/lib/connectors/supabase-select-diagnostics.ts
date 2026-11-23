import { ConnectorInputGuidance } from './types';

// These server-owned strings are safe for the agent. Never echo a token, SQL fragment or provider error.
const hints = {
  syntax: 'Use one SELECT on a listed analytics source. Use only listed columns, supported aggregates and the documented monthly date_trunc form.',
  source: 'Select one listed analytics source, unqualified or in the analytics schema.',
  name: 'Use simple column and source names from the analytics list.',
  column: 'Use only columns listed for this analytics source.',
  alias: 'Give every projected column a unique, simple alias.',
  identifier: 'Identifiers are available only inside COUNT(DISTINCT column).',
  month: "For monthly groups use date_trunc('month', column) on a listed date or timestamptz. Timestamps use UTC. Use literal 'month', with no additional arguments.",
  ordinal: 'Use a positive whole SELECT-list position from 1 through the number of projected columns in GROUP BY or ORDER BY. A GROUP BY position must refer to a non-aggregate dimension.',
  grouping: 'Include an aggregate and GROUP BY each non-aggregate projected column. Group a monthly bucket by its position, alias or the same date_trunc expression.',
  groupKey: 'Use each grouping dimension only once. Aggregate expressions cannot be GROUP BY keys.',
  order: 'Order by a projected expression, its unique output alias or its position; use each sort key only once.',
  scope: 'This scope requires an aggregate SELECT. Row samples are only available for explicitly admitted workspace sources.',
  sample: 'For a workspace row sample omit GROUP BY. For a grouped summary include an aggregate.',
  currency: 'For monetary aggregates, project and GROUP BY the source currency, or require currency equality to one uppercase three-letter code.',
  moneyMapping: 'This source does not have a valid monetary measure and currency mapping.',
  numeric: 'Use SUM or AVG only on a numeric measure.',
  range: 'Use MIN or MAX only on a number, date, timestamp or text column.',
  comparison: 'Compare a listed column to a typed scalar literal or a supplied $n parameter.',
  value: 'Match each comparison to its column type. Supply exact decimals and large integers as strings, ISO dates, and timestamps with timezone.',
  parameters: 'Supply at most sixteen scalar parameters as an array, or omit parameters.',
  bind: 'Supply one correctly typed value for every $n, numbered consecutively from $1.',
  unusedBind: 'Every supplied parameter must be used, numbered consecutively from $1.',
  limit: 'Use a LIMIT from 1 to 25.',
  width: 'Use at most five projections, groups, or sort keys.',
} as const;

export class AnalyticsSelectInputError extends ConnectorInputGuidance {
  constructor(readonly reason: keyof typeof hints) { super(hints[reason]); }
  get hint(): string { return hints[this.reason]; }
}

export function invalid(reason: keyof typeof hints = 'syntax'): never {
  throw new AnalyticsSelectInputError(reason);
}