import { connectorAccessMode, isGrantCurrent, type Connector, type ConnectorAgentGrant, type ConnectorMemberGrant } from './types';

// Caller must first verify current site eligibility. A persisted exception never
// inherits, including revoked and expired rows and rows with a false flag.
export function effectiveMemberGrant(connector: Connector, row: ConnectorMemberGrant | null) {
  if (row === null) {
    const inherited = connectorAccessMode(connector) === 'workspace';
    return { can_view: inherited, can_use: inherited };
  }
  const can_view = row.can_view === true && isGrantCurrent(row);
  return { can_view, can_use: can_view && row.can_use === true };
}

// Caller must also verify the actual agent is active in the connector's site.
export function effectiveAgentGrant(connector: Connector, row: Pick<ConnectorAgentGrant, 'enabled' | 'expires_at' | 'revoked_at'> | null) {
  return row === null
    ? connectorAccessMode(connector) === 'workspace'
    : row.enabled === true && isGrantCurrent(row);
}
