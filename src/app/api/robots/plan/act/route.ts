import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { OpenAIAgentExecutor } from '@/lib/custom-automation';
import { anthropic } from 'scrapybara/anthropic';
import { autoAuthenticateInstance } from '@/lib/helpers/automation-auth';
import {
  ActSchema,
  AgentResponseSchema,
  updatePlanWithStepResult,
  markPlanAsStarted,
  getCurrentStep,
  isPlanFullyCompleted,
  detectRequiredSessions,
  analyzeSessionsAvailability,
  formatSessionsContext,
  formatSessionRequirementsContext,
  connectToInstance,
  validateInstanceStatus,
  verifyBrowserResponsive,
  checkIfSubsequentPlan,
  setupTools,
  validateTools,
  createOnStepHandler,
  buildSystemPrompt,
  buildUserPrompt,
  formatHistoricalLogs,
  estimateTokens,
  verifyInstanceRunning,
  findPlanForExecution,
  detectStepStatus,
  buildSuccessResponse,
  handlePlanExecutionError,
  handleSpecialStates,
  saveExecutionSummary,
} from '@/lib/services/robot-plan-execution';

export const maxDuration = 300;

/**
 * Verifies that both the plan and instance remain active and in progress
 * Returns an error response if either has changed state
 */
async function verifyActiveStatus(
  instance_id: string,
  plan_id: string
): Promise<NextResponse | null> {
  // Check instance status
  const { data: instance, error: instanceError } = await supabaseAdmin
    .from('remote_instances')
    .select('status')
    .eq('id', instance_id)
    .single();

  if (instanceError || !instance) {
    return NextResponse.json(
      { error: 'Instance not found during status check', instance_id },
      { status: 404 }
    );
  }

  if (instance.status !== 'running') {
    return NextResponse.json(
      { 
        data: {
          waiting_for_instructions: true,
          instance_stopped: instance.status !== 'paused',
          instance_paused: instance.status === 'paused',
          message: `Instance is ${instance.status}`,
          instance_id,
          current_status: instance.status,
          can_resume: instance.status === 'paused'
        }
      },
      { status: 200 }
    );
  }

  // Check plan status
  const { data: planData, error: planError } = await supabaseAdmin
    .from('instance_plans')
    .select('status')
    .eq('id', plan_id)
    .single();

  if (planError || !planData) {
    return NextResponse.json(
      { error: 'Plan not found during status check', plan_id },
      { status: 404 }
    );
  }

  // Handle paused status gracefully with 200 response
  if (planData.status === 'paused') {
    return NextResponse.json(
      { 
        data: {
          waiting_for_instructions: true,
          plan_paused: true,
          message: 'Plan execution has been paused',
          plan_id,
          current_status: 'paused',
          can_resume: true
        }
      },
      { status: 200 }
    );
  }

  // Only return error for truly inactive states (completed, failed, canceled)
  if (planData.status !== 'in_progress' && planData.status !== 'pending') {
    return NextResponse.json(
      { 
        data: {
          waiting_for_instructions: true,
          plan_completed: planData.status === 'completed',
          plan_failed: planData.status === 'failed',
          message: `Plan is ${planData.status}`,
          plan_id,
          current_status: planData.status
        }
      },
      { status: 200 }
    );
  }

  return null; // All good, continue execution
}

export async function POST(request: NextRequest) {
  let instance_id: string | undefined;
  let currentStep: any = null;
  let effective_plan_id: string | undefined;
  let plan: any = null;
  
  try {
    const rawBody = await request.json();
    const { instance_id: parsedInstanceId, instance_plan_id, user_instruction } = ActSchema.parse(rawBody);
    instance_id = parsedInstanceId;

    // 1. Get and validate instance
    const { data: instance, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return NextResponse.json({ error: 'Instance not found' }, { status: 404 });
    }

    // 2. Verify instance is running
    const instanceValidation = await verifyInstanceRunning(instance, instance_id, instance_plan_id);
    if (instanceValidation) return instanceValidation;

    // 3. Find plan for execution
    const planResult = await findPlanForExecution(instance_id, instance_plan_id);
    if (planResult.error) return planResult.error;
    plan = planResult.plan;
    effective_plan_id = plan.id;

    if (!effective_plan_id) {
      throw new Error('Plan ID is required for execution');
    }

    // 3.1 If plan is paused, don't execute it automatically
    if (plan.status === 'paused') {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ⏸️ Plan is paused, cannot execute automatically`);
      return NextResponse.json({
        data: {
          waiting_for_instructions: true,
          plan_paused: true,
          message: 'Plan is paused. It will be marked as failed when instance is stopped.',
          plan_id: effective_plan_id,
          current_status: 'paused',
          can_resume: true
        }
      }, { status: 200 });
    }

    // ✓ Check status after finding plan
    const statusCheck1 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck1) return statusCheck1;

    // 4. Prepare plan steps
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Working directly with plan: "${plan.title}"`);
    
    let planSteps = [];
    if (plan.steps && Array.isArray(plan.steps)) {
      planSteps = plan.steps.sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
    }
    
    if (planSteps.length === 0) {
      planSteps = [{
        id: 'plan-execution',
        title: plan.title || 'Execute Plan',
        description: plan.description || plan.instructions || 'Execute plan according to instructions',
        status: 'pending',
        order: 1
      }];
    }
    
    currentStep = getCurrentStep(planSteps);
    
    if (!currentStep) {
      if (isPlanFullyCompleted(planSteps)) {
        await supabaseAdmin
          .from('instance_plans')
          .update({ 
            status: 'completed', 
            completed_at: new Date().toISOString(),
            progress_percentage: 100,
            updated_at: new Date().toISOString()
          })
          .eq('id', effective_plan_id);
          
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Plan ${effective_plan_id} marked as completed - all steps finished`);
        
        try {
          const { executeRobotWorkflowOnCompletion } = await import('@/lib/services/robot-instance/robot-plan-service');
          await executeRobotWorkflowOnCompletion(
            plan.site_id,
            'plan_execution',
            plan.user_id || null,
            instance_id,
            instance,
            { isPlanCompleted: true, planId: effective_plan_id || null }
          );
        } catch (workflowError) {
          console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error executing robot workflow:`, workflowError);
        }
        
        return NextResponse.json({ 
          data: {
            waiting_for_instructions: true,
            plan_completed: true,
            message: 'Plan has been completed - all steps finished',
            plan_progress: {
              completed_steps: planSteps.length,
              total_steps: planSteps.length,
              percentage: 100
            }
          }
        }, { status: 200 });
      }
      currentStep = planSteps[0];
    }
    
    currentStep.instance_plan_id = effective_plan_id;
    currentStep.step_type = 'plan_execution';
    currentStep.created_at = new Date().toISOString();
    currentStep.updated_at = new Date().toISOString();
    
    const allSteps = planSteps;

    // 5. Handle user instruction
    if (user_instruction && user_instruction.trim()) {
      const updatedDescription = plan.description 
        ? `${plan.description}\n\nADDITIONAL USER INSTRUCTION: ${user_instruction}`
        : `ADDITIONAL USER INSTRUCTION: ${user_instruction}`;
      
      await supabaseAdmin
        .from('instance_plans')
        .update({ 
          description: updatedDescription,
          updated_at: new Date().toISOString()
        })
        .eq('id', effective_plan_id);
      
      currentStep.description = updatedDescription;
    }

    // 6. Mark plan as started
    if (!effective_plan_id) {
      throw new Error('No plan ID available for execution');
    }
    await markPlanAsStarted(effective_plan_id, planSteps, currentStep);

    // ✓ Check status after marking plan as started
    const statusCheck2 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck2) return statusCheck2;

    // 7. Get historical logs
    const { data: historicalLogs } = await supabaseAdmin
      .from('instance_logs')
      .select('log_type, message, created_at, step_id')
      .eq('instance_id', instance_id)
      .in('log_type', ['agent_action', 'user_action'])
      .order('created_at', { ascending: true })
      .limit(5);

    const logContext = formatHistoricalLogs(historicalLogs || []);

    // 8. Get and prepare sessions
    const { data: existingSessions } = await supabaseAdmin
      .from('automation_auth_sessions')
      .select('*')
      .eq('site_id', plan.site_id)
      .eq('is_valid', true)
      .order('last_used_at', { ascending: false });

    let sessionsContext = formatSessionsContext(existingSessions || []);

    const requiredSessions = detectRequiredSessions(allSteps, plan);
    const sessionsAnalysis = analyzeSessionsAvailability(existingSessions || [], requiredSessions);
    const sessionsRequirementContext = formatSessionRequirementsContext(sessionsAnalysis);

    // ✓ Check status after preparing sessions
    const statusCheck3 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck3) return statusCheck3;

    // 9. Connect to instance
    const { client, remoteInstance } = await connectToInstance(instance.provider_instance_id);
    
    const validation = validateInstanceStatus(remoteInstance);
    if (!validation.valid) {
      return NextResponse.json({ 
        error: validation.error,
        instance_id: instance_id,
        provider_instance_id: instance.provider_instance_id,
        status: validation.status
      }, { status: 503 });
    }
    
    await verifyBrowserResponsive(remoteInstance);

    // ✓ Check status after connecting to instance
    const statusCheck4 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck4) return statusCheck4;

    // 10. Handle authentication
    const { isSubsequentPlan, completedPlansCount } = await checkIfSubsequentPlan(instance_id);
    
    if (existingSessions && existingSessions.length > 0 && !isSubsequentPlan) {
      const authResult = await autoAuthenticateInstance(instance.provider_instance_id, plan.site_id);
      if (authResult.success) {
        sessionsContext += `\n🔐 AUTHENTICATION APPLIED: Successfully authenticated using "${authResult.session?.name}" (${authResult.session?.domain})\n`;
      }
    } else if (isSubsequentPlan) {
      sessionsContext += `\n🔐 AUTHENTICATION SKIPPED: Reusing existing browser session from previous plan\n`;
    }

    // ✓ Check status after authentication
    const statusCheck5 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck5) return statusCheck5;

    // 11. Setup and validate tools
    const ubuntuInstance = remoteInstance as any;
    let tools = setupTools(ubuntuInstance);
    
    const toolsValidation = await validateTools(tools, client, instance.provider_instance_id);
    if (!toolsValidation.valid) {
      return NextResponse.json({ 
        error: 'Failed to establish connection with remote instance tools',
        details: 'Tools test failed after multiple attempts',
        instance_id: instance_id,
        provider_instance_id: instance.provider_instance_id
      }, { status: 500 });
    }
    const validatedTools = toolsValidation.tools;

    // ✓ Check status after setting up tools
    const statusCheck6 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck6) return statusCheck6;

    // 12. Build prompts
    const systemPromptWithContext = buildSystemPrompt(logContext, sessionsContext, sessionsRequirementContext);
    const planPrompt = buildUserPrompt(plan, currentStep, allSteps);
    
    estimateTokens(systemPromptWithContext, planPrompt);
    
    // ✓ Check status before executing plan
    const statusCheck7 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck7) return statusCheck7;
    
    // 13. Execute plan
    let stepStatus = 'in_progress';
    let stepResult = '';
    let executionStartTime = Date.now();
    let executionResult: any;
    
    const USE_SCRAPYBARA_SDK = true;
    
    const stepStatusRef = { value: stepStatus };
    const stepResultRef = { value: stepResult };
    
    try {
      if (USE_SCRAPYBARA_SDK) {
        executionResult = await client.act({
          model: anthropic(),
          tools: validatedTools,
          schema: AgentResponseSchema,
          system: systemPromptWithContext,
          prompt: planPrompt,
          onStep: createOnStepHandler(
            remoteInstance,
            currentStep,
            effective_plan_id!,
            plan,
            instance_id,
            stepStatusRef,
            stepResultRef
          )
        });
      } else {
        const executor = new OpenAIAgentExecutor();
        executionResult = await executor.act({
          tools: validatedTools,
          schema: AgentResponseSchema,
          system: systemPromptWithContext,
          prompt: planPrompt,
          onStep: createOnStepHandler(
            remoteInstance,
            currentStep,
            effective_plan_id!,
            plan,
            instance_id,
            stepStatusRef,
            stepResultRef
          )
        });
      }

      stepStatus = stepStatusRef.value;
      stepResult = stepResultRef.value;
    } catch (error: any) {
      console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error during step execution:`, error);
      
      // Handle pause/stop errors gracefully
      if (error.message?.includes('PLAN_PAUSED') || error.message?.includes('INSTANCE_STOPPED')) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ Execution paused by user, returning graceful response`);
        stepStatus = 'paused';
        stepResult = stepResultRef.value || 'Execution paused by user';
        
        // Return early with pause response
        return NextResponse.json({
          data: {
            waiting_for_instructions: true,
            plan_paused: true,
            message: stepResult,
            plan_progress: {
              completed_steps: (plan.steps_completed || 0),
              total_steps: (plan.steps_total || allSteps.length),
              percentage: (plan.progress_percentage || 0)
            },
            plan_id: effective_plan_id,
            instance_status: 'paused'
          }
        }, { status: 200 });
      }
      
      stepStatus = 'failed';
      stepResult = `Execution error: ${error.message}`;
      executionResult = {
        steps: [],
        text: stepResult,
        output: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      };
    }

    const { text, output } = executionResult;

    // ✓ Check status after executing plan
    const statusCheck8 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck8) return statusCheck8;

    // 14. Detect final status
    const statusDetection = detectStepStatus(executionResult, currentStep.order, stepStatus);
    stepStatus = statusDetection.stepStatus;
    stepResult = statusDetection.stepResult;

    const finalResult = stepResult || text || 'Step execution completed';
    
    // ✓ Check status before updating plan
    const statusCheck9 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck9) return statusCheck9;
    
    // 15. Update plan
    if (!effective_plan_id) {
      throw new Error('No plan ID available for update');
    }
    const planUpdateData = await updatePlanWithStepResult(
      effective_plan_id,
      currentStep,
      stepStatus,
      finalResult,
      executionStartTime,
      allSteps
    );

    // ✓ Check status before handling special states
    const statusCheck10 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck10) return statusCheck10;

    // 16. Handle special states
    await handleSpecialStates(
      stepStatus,
      finalResult,
      currentStep,
      instance_id,
      effective_plan_id,
      plan
    );

    // ✓ Check status before saving execution summary
    const statusCheck11 = await verifyActiveStatus(instance_id, effective_plan_id);
    if (statusCheck11) return statusCheck11;

    // 17. Save execution summary
    await saveExecutionSummary(
      currentStep,
      finalResult,
      executionResult,
      executionStartTime,
      stepResult,
      stepStatus,
      remoteInstance,
      effective_plan_id,
      plan,
      instance_id
    );

    // 18. Execute workflow if plan completed
    if (planUpdateData.status === 'completed') {
      try {
        const { executeRobotWorkflowOnCompletion } = await import('@/lib/services/robot-instance/robot-plan-service');
        await executeRobotWorkflowOnCompletion(
          plan.site_id,
          'plan_execution',
          plan.user_id || null,
          instance_id,
          instance,
          { isPlanCompleted: true, planId: effective_plan_id || null }
        );
      } catch (workflowError) {
        console.error(`₍ᐢ•(ܫ)•ᐢ₎ ❌ Error executing robot workflow:`, workflowError);
      }
    }

    // 19. Build and return response
    const response = buildSuccessResponse(
      stepStatus,
      currentStep,
      finalResult,
      executionStartTime,
      planUpdateData,
      existingSessions || [],
      executionResult,
      remoteInstance,
      user_instruction
    );

    return NextResponse.json(response, { status: 200 });
  } catch (err: any) {
    return handlePlanExecutionError(err, currentStep, effective_plan_id, instance_id, plan);
  }
}