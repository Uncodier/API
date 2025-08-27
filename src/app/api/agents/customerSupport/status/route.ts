import { NextResponse } from 'next/server';
import { ProcessorInitializer } from '@/lib/agentbase';

export const dynamic = 'force-dynamic';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para validar IDs en formato antiguo
function isLegacyId(id: string): boolean {
  return id.startsWith('cmd_');
}

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

export async function GET(request: Request) {
  try {
    // Get the commandId from the URL parameters
    const url = new URL(request.url);
    const commandId = url.searchParams.get('commandId');
    
    if (!commandId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'commandId is required' } },
        { status: 400 }
      );
    }
    
    // Validar que el commandId sea un UUID válido o un ID en formato antiguo
    if (!isValidUUID(commandId) && !isLegacyId(commandId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'commandId must be a valid UUID or legacy ID' } },
        { status: 400 }
      );
    }
    
    // Get the command from the service
    const command = await commandService.getCommandById(commandId);
    
    if (!command) {
      return NextResponse.json(
        { success: false, error: { code: 'COMMAND_NOT_FOUND', message: 'Command not found' } },
        { status: 404 }
      );
    }
    
    // Return the command status and results if available
    return NextResponse.json({
      success: true,
      data: {
        commandId: command.id,
        status: command.status,
        results: command.results || [],
        created_at: command.created_at,
        updated_at: command.updated_at
      }
    });
    
  } catch (error: any) {
    console.error('Error checking command status:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: error.message || 'An unexpected error occurred' 
        } 
      },
      { status: 500 }
    );
  }
} 