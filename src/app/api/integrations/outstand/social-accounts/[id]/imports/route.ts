import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { requireOutstandConversationSite } from '@/lib/integrations/outstand/conversation-access';

interface SocialAccount {
  id?: string;
  network?: string;
  tenant_id?: string;
  isActive?: boolean | string | number;
}

const MAX_IMPORT_POSTS = 100;

function active(account: SocialAccount): boolean {
  return account.isActive === true || account.isActive === 'true' || account.isActive === 1;
}

async function authorizeAccount(request: Request, id: string) {
  const siteId = await requireOutstandConversationSite(request);
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    return { response: NextResponse.json({ success: false, error: 'Invalid social account ID' }, { status: 400 }) };
  }

  // Accounts may be shared within an Outstand organization. Never operate on
  // an account based solely on its presence in the provider's accounts list.
  const { data: settings, error } = await supabaseAdmin.from('settings')
    .select('site_id, social_media').not('social_media', 'is', null);
  if (error) throw error;
  const owners = (settings || []).filter((setting) =>
    Array.isArray(setting.social_media)
    && setting.social_media.some((account: SocialAccount) => account.id === id && active(account)),
  );
  if (owners.length !== 1 || owners[0].site_id !== siteId) {
    return { response: NextResponse.json({ success: false, error: 'Social account not uniquely owned by this site' }, { status: 403 }) };
  }

  const client = getOutstandClient();
  const response = await client.listAccounts(siteId, { tenantId: siteId, limit: 100 });
  if (response?.success === false) {
    return { response: NextResponse.json({ success: false, error: 'Unable to verify social account' }, { status: 502 }) };
  }
  const accounts: SocialAccount[] = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.accounts) ? response.accounts : [];
  const providerAccount = accounts.find((account) => account.id === id);
  const siteAccount: SocialAccount = owners[0].social_media.find(
    (account: SocialAccount) => account.id === id && active(account),
  );
  if (!providerAccount || !active(providerAccount)
    || providerAccount.network !== siteAccount.network
    || (providerAccount.tenant_id && providerAccount.tenant_id !== siteId)) {
    return { response: NextResponse.json({ success: false, error: 'Connected social account not found' }, { status: 404 }) };
  }
  return { siteId, client };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const auth = await authorizeAccount(request, id);
    if (auth.response) return auth.response;
    const jobs = await auth.client!.listSocialAccountImports(id, auth.siteId!);
    return NextResponse.json(jobs);
  } catch (error) {
    return importErrorResponse(error);
  }
}

function importErrorResponse(error: unknown) {
  const status = (error as Error & { status?: number }).status || 500;
  return NextResponse.json({
    success: false,
    error: error instanceof Error ? error.message : 'Unable to read social imports',
  }, { status });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const auth = await authorizeAccount(request, id);
    if (auth.response) return auth.response;
    const { siteId, client } = auth;
    const body = await request.json().catch(() => null);
    if (body?.confirm !== true || !Number.isInteger(body?.limit)
      || body.limit < 1 || body.limit > MAX_IMPORT_POSTS
      || Object.keys(body).some((key) => key !== 'confirm' && key !== 'limit')) {
      return NextResponse.json({
        success: false,
        error: `Explicit confirmation and a limit from 1 to ${MAX_IMPORT_POSTS} are required`,
      }, { status: 400 });
    }
    // One import may charge for every successfully fetched post. Never allow
    // a blind replay of an existing job (including failed/partial jobs).
    const existing = await client!.listSocialAccountImports(id, siteId!);
    if (!existing.success || !Array.isArray(existing.data)) {
      return NextResponse.json({ success: false, error: 'Unable to verify existing import jobs' }, { status: 502 });
    }
    if (existing.data.length > 0) {
      return NextResponse.json({
        success: false,
        error: 'An import job already exists for this account; inspect its status before starting another',
      }, { status: 409 });
    }
    const result = await client!.importSocialAccountPosts(id, siteId!, { limit: body.limit });
    if (result && typeof result === 'object' && 'success' in result && result.success === false) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return importErrorResponse(error);
  }
}
