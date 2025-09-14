import { supabaseAdmin } from '@/lib/database/supabase-client';

type DatabaseEnumCheck = {
  tasks: {
    validStatuses: Array<'completed' | 'in_progress' | 'pending' | 'failed'>;
    isValidStatus: (status: string) => boolean;
  };
  commands: {
    validStatuses: Array<'pending' | 'running' | 'completed' | 'failed' | 'cancelled'>;
    isValidStatus: (status: string) => boolean;
  };
  requirements: {
    validStatuses: Array<'validated' | 'in-progress' | 'on-review' | 'done' | 'backlog' | 'canceled'>;
    isValidStatus: (status: string) => boolean;
  };
};

export function getDatabaseEnumValues(): DatabaseEnumCheck {
  return {
    tasks: {
      validStatuses: ['completed', 'in_progress', 'pending', 'failed'],
      isValidStatus: (status: string) => ['completed', 'in_progress', 'pending', 'failed'].includes(status)
    },
    commands: {
      validStatuses: ['pending', 'running', 'completed', 'failed', 'cancelled'],
      isValidStatus: (status: string) => ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(status)
    },
    requirements: {
      validStatuses: ['validated', 'in-progress', 'on-review', 'done', 'backlog', 'canceled'],
      isValidStatus: (status: string) => ['validated', 'in-progress', 'on-review', 'done', 'backlog', 'canceled'].includes(status)
    }
  };
}

function getPreviousDayRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function getSupportDataByPrevDay(siteId: string) {
  try {
    const { start, end } = getPreviousDayRange();

    // New tasks created on the previous day
    const { data: newTasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .eq('site_id', siteId)
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: false })
      .limit(100);

    if (tasksError) {
      console.error('Error fetching previous day tasks:', tasksError);
      if ((tasksError as any).code === '22P02') {
        console.error('❌ Database enum error in tasks query:', tasksError.message);
        return null;
      }
    }

    // New conversations created on the previous day
    const { data: newConversations, error: conversationsError } = await supabaseAdmin
      .from('conversations')
      .select('*, messages(*)')
      .eq('site_id', siteId)
      .not('visitor_id', 'is', null)
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: false })
      .limit(50);

    if (conversationsError) {
      console.error('Error fetching previous day conversations:', conversationsError);
    }

    // Active support commands (for context only)
    const { data: supportCommands, error: commandsError } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('site_id', siteId)
      .in('task', ['customer support', 'ticket analysis', 'user assistance'])
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(20);

    if (commandsError) {
      console.error('Error fetching support commands:', commandsError);
      if ((commandsError as any).code === '22P02') {
        console.error('❌ Database enum error in commands query:', commandsError.message);
        return null;
      }
    }

    // Active support agent
    const { data: supportAgent, error: supportAgentError } = await supabaseAdmin
      .from('agents')
      .select('id, user_id, status')
      .eq('site_id', siteId)
      .eq('role', 'Customer Support')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);

    if (supportAgentError) {
      console.error('Error fetching support agent:', supportAgentError);
    }

    // Pending requirements (context)
    const { data: pendingRequirements, error: requirementsError } = await supabaseAdmin
      .from('requirements')
      .select('*')
      .eq('site_id', siteId)
      .in('status', ['validated', 'in-progress'])
      .order('created_at', { ascending: false })
      .limit(30);

    if (requirementsError) {
      console.error('Error fetching requirements:', requirementsError);
      if ((requirementsError as any).code === '22P02') {
        console.error('❌ Database enum error in requirements query:', requirementsError.message);
        return null;
      }
    }

    return {
      newTasks: newTasks || [],
      newConversations: newConversations || [],
      supportCommands: supportCommands || [],
      supportAgent: supportAgent?.[0] || null,
      pendingRequirements: pendingRequirements || [],
      newTasksCount: newTasks?.length || 0,
      newConversationsCount: newConversations?.length || 0,
      activeCommandsCount: supportCommands?.length || 0,
      pendingRequirementsCount: pendingRequirements?.length || 0,
      prevDayRange: { start, end }
    };
  } catch (error) {
    console.error('Error building previous day support data:', error);
    return null;
  }
}


