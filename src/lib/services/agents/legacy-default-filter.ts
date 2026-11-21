// PostgREST's `neq` alone drops SQL NULL, including old rows with no configuration or origin.
export const LEGACY_DEFAULT_AGENT_FILTER =
  'configuration->>agentOrigin.is.null,configuration->>agentOrigin.neq.independent';
