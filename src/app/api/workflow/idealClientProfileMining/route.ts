import { NextRequest, NextResponse } from 'next/server';
import { WorkflowService } from '@/lib/services/workflow-service';

interface IdealClientProfileMiningWorkflowArgs {
	site_id: string;
}

interface WorkflowExecutionOptions {
	priority?: 'low' | 'medium' | 'high';
	async?: boolean;
	retryAttempts?: number;
	taskQueue?: string;
	workflowId?: string;
}

/**
 * API endpoint para ejecutar el workflow idealClientProfileMiningWorkflow en Temporal
 * POST /api/workflow/idealClientProfileMining
 */
export async function POST(request: NextRequest) {
	try {
		console.log('🚀 Iniciando ejecución del workflow idealClientProfileMiningWorkflow');

		// Validar y extraer site_id del cuerpo de la petición
		const body = await request.json();
		const { site_id } = body;

		// Validación del site_id
		if (!site_id || typeof site_id !== 'string') {
			console.error('❌ site_id requerido y debe ser una cadena');
			return NextResponse.json(
				{ 
					success: false, 
					error: { 
						code: 'INVALID_SITE_ID', 
						message: 'site_id es requerido y debe ser una cadena válida' 
					} 
				},
				{ status: 400 }
			);
		}

		console.log(`🧭 Ejecutando workflow ICP Mining para site_id: ${site_id}`);

		// Obtener instancia del servicio de workflows
		const workflowService = WorkflowService.getInstance();

		// Preparar argumentos para el workflow
		const workflowArgs: IdealClientProfileMiningWorkflowArgs = {
			site_id
		};

		// Opciones de ejecución del workflow (asíncrono para retornar inmediatamente)
		const workflowOptions: WorkflowExecutionOptions = {
			priority: 'medium',
			async: true,
			retryAttempts: 3,
			taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default',
			workflowId: `icp-mining-${site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
		};

		console.log(`🔄 Iniciando workflow ICP Mining con ID: ${workflowOptions.workflowId}`);

		// Ejecutar el workflow específico para ICP Mining
		const result = await workflowService.idealClientProfileMining(
			workflowArgs,
			workflowOptions
		);

		if (!result.success) {
			console.error('❌ Error en la ejecución del workflow ICP Mining:', result.error);
			return NextResponse.json(
				{ 
					success: false, 
					error: { 
						code: result.error?.code || 'WORKFLOW_EXECUTION_ERROR',
						message: result.error?.message || 'Error al ejecutar el workflow ICP Mining'
					}
				},
				{ status: 500 }
			);
		}

		console.log('✅ Workflow ICP Mining iniciado exitosamente');
		console.log('📊 Información del workflow iniciado:', result);

		// Respuesta exitosa - workflow aceptado y en ejecución
		return NextResponse.json(
			{ 
				success: true, 
				message: 'Workflow de minería de ICP iniciado correctamente',
				data: {
					site_id,
					workflowId: result.workflowId,
					executionId: result.executionId,
					runId: result.runId,
					status: result.status || 'running'
				}
			},
			{ status: 200 }
		);

	} catch (error) {
		console.error('❌ Error en el endpoint del workflow idealClientProfileMining:', error);
		
		return NextResponse.json(
			{ 
				success: false, 
				error: { 
					code: 'INTERNAL_SERVER_ERROR', 
					message: 'Error interno del servidor al ejecutar el workflow de minería de ICP'
				} 
			},
			{ status: 500 }
		);
	}
}

/**
 * Método GET para obtener información sobre el endpoint
 */
export async function GET() {
	return NextResponse.json({
		name: 'idealClientProfileMiningWorkflow API',
		description: 'Ejecuta el workflow idealClientProfileMiningWorkflow en Temporal para minería del ICP por sitio',
		methods: ['POST'],
		requiredParams: {
			site_id: 'string - ID del sitio'
		},
		example: {
			site_id: 'site_12345'
		},
		note: 'Retorna 200 tan pronto como el workflow es aceptado por Temporal, no espera a que termine'
	});
}






