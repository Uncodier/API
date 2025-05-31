// Ejemplo de workflows de Temporal para ser ejecutados por el WorkflowService
// Nota: Estos workflows deben ser ejecutados por un Temporal Worker separado

// Definimos la interfaz localmente ya que es específica para workflows
interface WorkflowExecutionArgs {
  email: string;
  from: string;
  subject: string;
  message: string;
}

// Interfaces para customer support
interface AnalysisData {
  summary: string;
  insights: string[];
  sentiment: "positive" | "negative" | "neutral";
  priority: "high" | "medium" | "low";
  action_items: string[];
  response: string[];
  lead_extraction: {
    contact_info: {
      name: string | null;
      email: string | null;
      phone: string | null;
      company: string | null;
    };
    intent: "inquiry" | "complaint" | "purchase" | "support" | "partnership" | "demo_request";
    requirements: string[];
    budget_indication: string | null;
    timeline: string | null;
    decision_maker: "yes" | "no" | "unknown";
    source: "website" | "referral" | "social_media" | "advertising" | "cold_outreach";
  };
  commercial_opportunity: {
    requires_response: boolean;
    response_type: "commercial" | "support" | "informational" | "follow_up";
    priority_level: "high" | "medium" | "low";
    suggested_actions: string[];
    potential_value: "high" | "medium" | "low" | "unknown";
    next_steps: string[];
  };
}

interface ScheduleCustomerSupportParams {
  analysisArray: AnalysisData[];
  site_id: string;
  userId?: string;
}

/**
 * Workflow para enviar email desde un agente
 * Este es un ejemplo de cómo sería implementado en un worker de Temporal
 */
export async function sendEmailFromAgent(args: WorkflowExecutionArgs): Promise<any> {
  // En un workflow real de Temporal, aquí se definirían las actividades
  // que realizarían el envío del email
  
  // Ejemplo de estructura del workflow:
  /*
  try {
    // Validar email
    await validateEmailActivity(args.email);
    
    // Preparar contenido
    const emailContent = await prepareEmailContentActivity({
      from: args.from,
      subject: args.subject,
      message: args.message
    });
    
    // Enviar email
    const result = await sendEmailActivity({
      to: args.email,
      ...emailContent
    });
    
    // Log resultado
    await logEmailSentActivity(result);
    
    return {
      success: true,
      emailId: result.id,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    // Manejar errores y retry automático por Temporal
    await logEmailErrorActivity(error);
    throw error;
  }
  */
  
  // Por ahora retornamos un placeholder
  return {
    success: true,
    emailId: `email_${Date.now()}`,
    timestamp: new Date().toISOString(),
    args
  };
}

/**
 * Workflow para programar customer support basado en análisis de emails
 * Este es un ejemplo de cómo sería implementado en un worker de Temporal
 */
export async function scheduleCustomerSupport(params: ScheduleCustomerSupportParams): Promise<any> {
  // En un workflow real de Temporal, aquí se definirían las actividades
  // que manejarían la programación de customer support
  
  // Ejemplo de estructura del workflow:
  /*
  try {
    console.log(`Procesando ${params.analysisArray.length} análisis para site_id: ${params.site_id}`);
    
    // Procesar cada análisis
    const tasks = [];
    for (const analysis of params.analysisArray) {
      if (analysis.commercial_opportunity.requires_response) {
        // Crear tarea de seguimiento
        const task = await createFollowUpTaskActivity({
          analysis,
          site_id: params.site_id,
          userId: params.userId,
          priority: analysis.priority
        });
        tasks.push(task);
        
        // Si hay datos de contacto, crear o actualizar lead
        if (analysis.lead_extraction.contact_info.email) {
          await createOrUpdateLeadActivity({
            contactInfo: analysis.lead_extraction.contact_info,
            intent: analysis.lead_extraction.intent,
            site_id: params.site_id
          });
        }
        
        // Programar notificaciones según la prioridad
        if (analysis.priority === 'high') {
          await scheduleImmediateNotificationActivity({
            analysis,
            site_id: params.site_id,
            userId: params.userId
          });
        } else {
          await scheduleDelayedNotificationActivity({
            analysis,
            site_id: params.site_id,
            userId: params.userId,
            delay: analysis.priority === 'medium' ? '1h' : '24h'
          });
        }
      }
    }
    
    // Generar reporte resumen
    const summary = await generateSummaryReportActivity({
      analyses: params.analysisArray,
      tasks: tasks,
      site_id: params.site_id
    });
    
    return {
      success: true,
      tasksCreated: tasks.length,
      summary,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    // Manejar errores y retry automático por Temporal
    await logCustomerSupportErrorActivity(error);
    throw error;
  }
  */
  
  // Por ahora retornamos un placeholder
  return {
    success: true,
    tasksCreated: params.analysisArray.filter(a => a.commercial_opportunity.requires_response).length,
    analysisProcessed: params.analysisArray.length,
    site_id: params.site_id,
    userId: params.userId,
    timestamp: new Date().toISOString(),
    params
  };
}

/**
 * Workflow genérico para otras tareas
 */
export async function genericWorkflow(args: any): Promise<any> {
  // Implementación del workflow genérico
  return {
    success: true,
    result: args,
    timestamp: new Date().toISOString()
  };
}

// Ejemplo de cómo se registrarían estos workflows en un worker:
/*
import { Worker } from '@temporalio/worker';
import * as activities from './activities'; // Actividades implementadas por separado

async function run() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./email-workflows'),
    activitiesPath: require.resolve('./activities'),
    taskQueue: 'email-task-queue',
  });
  
  await worker.run();
}

run().catch(console.error);
*/ 