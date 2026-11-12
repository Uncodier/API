import { NextRequest, NextResponse } from 'next/server';
import { SupervisorService, SupervisorResult } from '@/lib/agentbase';
import { ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';

/**
 * POST /api/agents/supervisor
 * Analyzes a command to detect missing tool calls and suggest improvements
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await resolveToolRequestPrincipal(request);
    if (!principal) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const body = z.object({ command_id: z.string().uuid(), conversation_id: z.string().uuid().optional() })
      .safeParse(await request.json());
    if (!body.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { command_id } = body.data;
    let { conversation_id } = body.data;

    // Read only the authorization envelope before loading command contents or its payer.
    const { data: envelope, error: envelopeError } = await supabaseAdmin.from('commands')
      .select('site_id').eq('id', command_id).maybeSingle();
    if (envelopeError) return NextResponse.json({ error: 'Authorization unavailable' }, { status: 503 });
    if (!envelope?.site_id || !await canToolPrincipalAccessSite(principal, envelope.site_id)) {
      return NextResponse.json({ error: 'Command access denied' }, { status: 403 });
    }

    console.log(`[Supervisor] Analyzing command: ${command_id}${conversation_id ? `, conversation: ${conversation_id}` : ''}`);

    // Fetch command from database
    const processorInitializer = ProcessorInitializer.getInstance();
    processorInitializer.initialize();
    const commandService = processorInitializer.getCommandService();
    const command = await commandService.getCommandById(command_id);

    if (!command) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'COMMAND_NOT_FOUND',
            message: `Command with ID ${command_id} not found`
          }
        },
        { status: 404 }
      );
    }

    if (command.site_id !== envelope.site_id) {
      return NextResponse.json({ error: 'Command access denied' }, { status: 403 });
    }
    // Validate the fallback too: command context/results are not authorization.
    conversation_id = conversation_id || extractConversationId(command) || undefined;
    if (conversation_id) {
      if (!z.string().uuid().safeParse(conversation_id).success) {
        return NextResponse.json({ error: 'Invalid conversation' }, { status: 400 });
      }
      const { data: conversation, error } = await supabaseAdmin.from('conversations')
        .select('site_id').eq('id', conversation_id).maybeSingle();
      if (error) return NextResponse.json({ error: 'Authorization unavailable' }, { status: 503 });
      if (!conversation || conversation.site_id !== envelope.site_id) {
        return NextResponse.json({ error: 'Conversation access denied' }, { status: 403 });
      }
    }

    console.log(`[Supervisor] Command found: ${command.id}, Status: ${command.status}`);

    // Analyze command with GPT-6.1 Sol
    const supervisorService = new SupervisorService();
    const analysisResult: SupervisorResult = await supervisorService.analyzeCommand(command, conversation_id);

    if (!analysisResult.success) {
      // If analysis fails, send error message to conversation
      await handleSupervisorError(command, analysisResult.error || 'Unknown error during analysis', conversation_id);

      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'ANALYSIS_FAILED',
            message: analysisResult.error || 'Failed to analyze command'
          },
          partial_result: analysisResult
        },
        { status: 500 }
      );
    }

    // Return structured response
    // Only include command_id if it exists (was successfully created and verified)
    const response: any = {
      success: true,
      analyzed_command_id: analysisResult.analyzed_command_id || command.id, // The command that was analyzed (input)
      analysis: analysisResult.analysis,
      errata_applied: analysisResult.errata_applied || 0,
      emails_sent: analysisResult.emails_sent || 0,
      summary: {
        errors_detected: analysisResult.analysis?.analysis.errors_detected.length || 0,
        errata_count: analysisResult.analysis?.errata.length || 0,
        system_suggested_tools_for_development: analysisResult.analysis?.system_suggested_tools_for_development.length || 0,
        prompt_suggestions: analysisResult.analysis?.prompt_suggestions.length || 0
      }
    };

    // Only include command_id if it was successfully created and verified to exist
    if (analysisResult.command_id) {
      response.command_id = analysisResult.command_id; // The supervisor command created for this analysis
    } else {
      console.warn(`[Supervisor] Analysis completed but no command_id was created or verified`);
    }

    console.log(`[Supervisor] Analysis complete:`, response.summary);

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    console.error('[Supervisor] Error in endpoint:', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Supervisor request failed'
        }
      },
      { status: error instanceof SyntaxError ? 400 : 500 }
    );
  }
}

/**
 * Handle supervisor errors by sending system message to conversation
 */
async function handleSupervisorError(command: any, errorMessage: string, conversationId?: string): Promise<void> {
  try {
    // Use provided conversation_id or try to extract from command
    let effectiveConversationId = conversationId || extractConversationId(command);

    if (!effectiveConversationId) {
      console.warn('[Supervisor] No conversation ID found, cannot send error message');
      return;
    }

    // Create system message for error
    const errorSystemMessage = `[Supervisor Error]: The supervisor analysis failed with the following error: ${errorMessage}. Please review the command manually.`;

    // Add system message to conversation requiring confirmation
    const { error } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: effectiveConversationId,
        content: errorSystemMessage,
        role: 'system',
        user_id: command.user_id,
        custom_data: {
          supervisor_error: true,
          requires_confirmation: true,
          confirmation_required_from: ['user', 'team_member'],
          command_id: command.id,
          error_message: errorMessage
        }
      });

    if (error) {
      console.error('[Supervisor] Error adding error message to conversation:', error);
    } else {
      console.log(`[Supervisor] Error message sent to conversation ${effectiveConversationId}`);
    }
  } catch (error: any) {
    console.error('[Supervisor] Error handling supervisor error:', error);
  }
}

/**
 * Extract conversation ID from command
 */
function extractConversationId(command: any): string | null {
  // Try to extract from context
  if (command.context) {
    const contextMatch = command.context.match(/conversation[_-]?id["\s:]+([a-f0-9-]{36})/i);
    if (contextMatch) {
      return contextMatch[1];
    }
  }

  // Try to extract from results
  const results = command.results || [];
  for (const result of results) {
    if (result.conversation_id) {
      return result.conversation_id;
    }
    if (result.custom_data?.conversation_id) {
      return result.custom_data.conversation_id;
    }
  }

  return null;
}

