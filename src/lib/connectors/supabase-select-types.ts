export type AnalyticsResultType = 'text' | 'numeric' | 'integer' | 'date' | 'timestamptz' | 'boolean';
export type AnalyticsColumnType = AnalyticsResultType | 'uuid';

/** Server-owned capability, never tool input. The complete SELECT scopes every underlying
 * relation; guardSql attests those relations in the same statement (ownership, RLS, etc.). */
export interface AnalyticsSource {
  /** Units for monetary aggregates; no implicit conversion or aggregation across currencies. */
  readonly money?: { readonly currency: string; readonly measures: readonly string[] };
  readonly sql: string;
  readonly guardSql: string;
  readonly columns: Readonly<Record<string, AnalyticsColumnType>>;
}
export interface AnalyticsDataset {
  /** Trusted opt-in only for a tenant-bound workspace; never set on global datasets. */
  readonly allowRows?: true;
  readonly sources: Readonly<Record<string, AnalyticsSource>>;
  /** Reserved parameter prefix used only by the trusted source/guard, e.g. the verified site ID. */
  readonly parameters: readonly string[];
}
export interface CompiledAnalyticsSelect {
  query: string;
  parameters: string[];
  source: string;
  columns: { name: string; type: AnalyticsResultType }[];
  limit: number;
  /** Compare with the one response frame before releasing any rows. Never send to the model. */
  attestation: string;
}
