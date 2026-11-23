export type ToolOrigin = 'provider';
export type ConnectorFilters = { query?: string; catalog_query?: string; domain?: string; category?: string; connector_id?: string; cursor?: string; tool_origin?: ToolOrigin };
export type ConnectorCandidate = {
  tool_origin?: ToolOrigin; account_label?: string;
  name: string; description: string; category: string; domains: string[];
  connector_id: string; toolkit: string; availability: 'describe_required' | 'manual_only'; request_only?: true;
};