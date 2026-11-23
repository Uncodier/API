export type ConnectorFilters = { query?: string; catalog_query?: string; domain?: string; category?: string; connector_id?: string; cursor?: string };
export type ConnectorCandidate = {
  name: string; description: string; category: string; domains: string[];
  connector_id: string; toolkit: string; availability: 'describe_required' | 'manual_only'; request_only?: true;
};