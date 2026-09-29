import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getWrapUpInputs } from '@/lib/services/wrapUpData';
import { buildWrapUpContext, WRAP_UP_SCOPED_BACKGROUND } from '@/lib/prompts/dailyStandupWrapUpContext';
import { constrainReportSections, getLatestReportSections, reportSectionsSchema } from '@/lib/services/dailyStandupReportSections';
import { renderReportResults } from '@/lib/services/dailyStandupReportOutput';

export const maxDuration = 200;

const requestSchema = z.object({
  site_id: z.string().uuid(),
  // Kept for wire compatibility; legacy commands/memories are intentionally never read.
  command_id: z.string().uuid().optional(),
  command_ids: z.array(z.string().uuid()).max(100).optional(),
  report_sections: reportSectionsSchema.optional(),
});

function failure(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

async function waitForCommandCompletion(commandService: any, commandId: string) {
  for (let attempt = 0; attempt < 190; attempt++) {
    const command = await commandService.getCommandById(commandId);
    if (!command || command.status === 'failed') return null;
    if (command.status === 'completed') return command;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return null;
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return failure('INVALID_REQUEST', 'Request body must be valid JSON', 400);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return failure('INVALID_REQUEST', 'Invalid site_id, command IDs or report_sections', 400);
  const { site_id, report_sections } = parsed.data;

  try {
    // Resolve latest preferences before collecting ANY business data or initializing a processor.
    const persisted = await getLatestReportSections(site_id);
    const selected = constrainReportSections(persisted, report_sections);
    if (!selected.length) return failure('NO_REPORT_SECTIONS', 'No report sections are enabled', 409);

    const { data: agents, error } = await supabaseAdmin.from('agents').select('id,user_id')
      .eq('site_id', site_id).eq('role', 'Growth Lead/Manager').eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1);
    if (error) throw new Error('Could not retrieve report agent');
    const agent = agents?.[0];
    if (!agent) return failure('AGENT_NOT_FOUND', 'No active CMO agent found for this site', 404);

    const wrapUpInputs = await getWrapUpInputs(site_id, selected);
    const context = buildWrapUpContext({ siteId: site_id, wrapUpInputs });
    const command = CommandFactory.createCommand({
      task: 'daily standup executive summary',
      userId: agent.user_id,
      agentId: agent.id,
      agentRole: 'Growth Lead/Manager',
      site_id,
      description: `Summarize only the selected Daily Standup sections: ${selected.join(', ')}`,
      modelType: 'openai',
      modelId: 'gpt-5-mini',
      targets: [{ sections: Object.fromEntries(selected.map(section => [
        section, `Concise plain text summary of ONLY ${section}, based ONLY on its supplied dataset.`,
      ])) }],
      tools: [],
      context,
      metadata: { report_sections: selected },
    });
    // initializeAgentCommand respects an explicit background. Without this, it fetches generic
    // site/agent context that can contain disabled sections, regardless of our scoped context.
    command.agent_background = WRAP_UP_SCOPED_BACKGROUND;

    const initializer = ProcessorInitializer.getInstance();
    initializer.initialize();
    const commandService = initializer.getCommandService();
    const commandId = await commandService.submitCommand(command);
    const completed = await waitForCommandCompletion(commandService, commandId);
    if (!completed) return failure('COMMAND_EXECUTION_FAILED', 'The report command did not complete successfully', 500);

    // Drop reports whose selection was revoked while the model was running.
    const latest = await getLatestReportSections(site_id);
    if (selected.some(section => !latest.includes(section))) {
      return failure('REPORT_SELECTION_CHANGED', 'Report settings changed during generation', 409);
    }
    try {
      const data = renderReportResults(completed.results, selected);
      return NextResponse.json({ success: true, data: {
        ...data, command_id: completed.id || commandId, summary: data.message,
      } }, { status: 200 });
    } catch {
      return failure('INVALID_REPORT_OUTPUT', 'Report did not match the selected sections', 502);
    }
  } catch (error) {
    console.error('Daily Standup report failed:', error);
    return failure('DATA_ERROR', 'Could not generate the selected Daily Standup report', 500);
  }
}