import { supabaseAdmin } from '@/lib/database/supabase-client';

function getPreviousDayRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function getWrapUpInputs(siteId: string) {
  try {
    const { start, end } = getPreviousDayRange();

    const [settingsRes, leadsRes, conversationsRes, tasksRes, pendingContentRes] = await Promise.all([
      // Site settings (latest row if multiple)
      supabaseAdmin
        .from('settings')
        .select('*')
        .eq('site_id', siteId)
        .order('created_at', { ascending: false })
        .limit(1),

      // New leads created in previous day
      supabaseAdmin
        .from('leads')
        .select('*')
        .eq('site_id', siteId)
        .gte('created_at', start)
        .lt('created_at', end)
        .order('created_at', { ascending: false })
        .limit(200),

      // New conversations created in previous day (include messages for quick summary)
      supabaseAdmin
        .from('conversations')
        .select('*, messages(*)')
        .eq('site_id', siteId)
        .gte('created_at', start)
        .lt('created_at', end)
        .order('created_at', { ascending: false })
        .limit(100),

      // Tasks created in previous day
      supabaseAdmin
        .from('tasks')
        .select('*')
        .eq('site_id', siteId)
        .gte('created_at', start)
        .lt('created_at', end)
        .order('created_at', { ascending: false })
        .limit(200),

      // Pending content (draft or review) regardless of day, but relevant to wrapUp
      supabaseAdmin
        .from('content')
        .select('*')
        .eq('site_id', siteId)
        .in('status', ['draft', 'review'])
        .order('updated_at', { ascending: false })
        .limit(200)
    ]);

    const settings = (settingsRes.data && settingsRes.data[0]) || null;
    const leads = leadsRes.data || [];
    const conversations = conversationsRes.data || [];
    const tasks = tasksRes.data || [];
    const pendingContents = pendingContentRes.data || [];

    return {
      settings,
      prevDayRange: { start, end },
      prevDay: {
        leads,
        conversations,
        tasks
      },
      pendingContents,
      counts: {
        leads: leads.length,
        conversations: conversations.length,
        tasks: tasks.length,
        pendingContents: pendingContents.length
      }
    };
  } catch (error) {
    console.error('Error building wrap-up inputs:', error);
    return null;
  }
}


