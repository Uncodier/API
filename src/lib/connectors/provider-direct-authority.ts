/** Server-internal evidence returned by the actor-specific admission RPC. */
type AccountPin = {
  directRevision: number; siteId: string; connectorId: string; providerId: string; toolkitSlug: string;
  projectId: string; accountId: string; authConfigId: string; credentialRevision: string;
};
export type DirectProof = (
  | { kind?: 'attested'; attestationId: string; expiresAt: string; resourceBoundary: string }
  | ({ kind: 'connected_account'; authorizationId: string } & (
    | {authScheme?: undefined; boundProjectRef?: undefined}
    | {authScheme: 'OAUTH2'|'API_KEY'; boundProjectRef: string|null}
  ))
);

export type DirectAuthority = AccountPin & DirectProof;

export function authorityStamp(d: DirectAuthority) {
  return [d.kind ?? 'attested', d.kind === 'connected_account' ? d.authorizationId : d.attestationId,
    d.directRevision, d.siteId, d.connectorId, d.providerId, d.toolkitSlug, d.projectId, d.accountId, d.authConfigId, d.credentialRevision,
    ...(d.kind==='connected_account' && d.authScheme ? [d.authScheme,d.boundProjectRef] : [])];
}

/** A project pin is not a row-level tenant boundary. The application’s own project may be shared across sites. */
export function projectMetadataAction(kit:string, slug:string) {
  const prefix=kit.toUpperCase().replace(/-/g,'_')+'_';
  return slug.startsWith(prefix) && /^(GET|FETCH|RETRIEVE)_PROJECT(_(METADATA|DETAILS|STATUS))?$/.test(slug.slice(prefix.length));
}

export function projectActionAllowed(kit:string, slug:string, projectRef:string|null|undefined, delegated:boolean, localRef:string|null|undefined) {
  if (!projectRef) return true;
  if (delegated && localRef && localRef!==projectRef) return true;
  return (!delegated && !/(?:^|_)PROJECTS?(?:_|$)/.test(slug.slice(kit.length+1))) || projectMetadataAction(kit,slug);
}

/** The RPC must explicitly name both the customer-authorized scheme and the
 * selected project (null for unbound). No wire marker means legacy consent. */
export function connectedAccountReady(proof:Extract<DirectProof,{kind:'connected_account'}>,
  connector:{toolkit_slug:string; supabase_project_ref?:string|null; granted_scopes:string[]}, localRef:string|null|undefined) {
  const project=connector.supabase_project_ref;
  if (!proof.authScheme) return proof.boundProjectRef===undefined && project===null && isOrdinaryBusinessGrant(connector.toolkit_slug,connector.granted_scopes);
  if (!['OAUTH2','API_KEY'].includes(proof.authScheme) || project!==proof.boundProjectRef) return false;
  if (connector.toolkit_slug==='supabase' && (!project || proof.authScheme!=='API_KEY')) return false;
  // The application installation still receives only project metadata. Never interpret
  // a different ref as proof a project contains data from just this tenant.
  const ref=(v:unknown)=>typeof v==='string' && v.length===20 && /^[a-z]+$/.test(v);
  return project===null || (ref(project) && ref(localRef));
}

// Screen ACLs, not toolkit eligibility for new customer delegations.
export function ordinaryBusinessScreens(kit: string): readonly string[] {
  switch (kit) {
    case 'gmail': return ['chat'];
    case 'googlecalendar': return ['calendar','reservations'];
    case 'hubspot': return ['people','leads','deals'];
    default: return [];
  }
}

export function isOrdinaryBusinessGrant(kit: string, scopes: readonly string[]) {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  const google = 'https://www.googleapis.com/auth/';
  if (kit === 'gmail') return scopes.every(s => ['gmail.modify','gmail.readonly','gmail.send'].some(g => s === google + g));
  if (kit === 'googlecalendar') return scopes.every(s => ['calendar.events','calendar.events.readonly'].some(g => s === google + g));
  const crm = ['contacts','companies','deals'].flatMap(o => ['read','write'].map(a => `crm.objects.${o}.${a}`));
  return kit === 'hubspot' && scopes.some(s => crm.includes(s)) && scopes.every(s => s === 'oauth' || crm.includes(s));
}
