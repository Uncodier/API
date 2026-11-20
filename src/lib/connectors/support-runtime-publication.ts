import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError } from './access';
import { isPublicationLabel } from './support-public-gmail';

type Audience = 'anonymous' | 'verified';
const eligible = (audience: Audience) => audience === 'verified' ? ['anonymous', 'verified'] : ['anonymous'];
const signal = () => AbortSignal.timeout(5000);

/** The SQL filter applies before the limit. Unpublished accounts do not affect public pagination. */
export async function publicationWindow(siteId: string, agentId: string, audience: Audience, after: string, exact?: string) {
  const { data, error } = await supabaseAdmin.rpc('connector_support_publication_page', {
    p_site_id: siteId, p_agent_id: agentId, p_audience: audience, p_after: after || null, ...(exact ? { p_exact: exact } : {}),
  }).order('connector_id').abortSignal(signal());
  if (error || !Array.isArray(data) || data.length > 6) connectorDatabaseError(error);
  return data.map((row: {connector_id: string}) => row.connector_id);
}

export async function loadSupportPublication(siteId: string, connectorId: string, audience: Audience, agentId: string) {
  const allowed = await publicationWindow(siteId, agentId, audience, '', connectorId);
  if (allowed.length !== 1 || allowed[0] !== connectorId) return null;
  const { data, error } = await supabaseAdmin.from('connector_policies').select('support_publication,revision')
    .eq('site_id', siteId).eq('connector_id', connectorId).abortSignal(signal()).maybeSingle();
  if (error) connectorDatabaseError(error);
  const settings = data?.support_publication;
  if (!settings || !eligible(audience).includes(settings.audience) || !isPublicationLabel(settings.label_id) ||
      !Number.isSafeInteger(data?.revision)) return null;
  return { labelId: settings.label_id as string, revision: data!.revision as number, audience: settings.audience as Audience };
}