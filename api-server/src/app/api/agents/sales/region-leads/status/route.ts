import { NextResponse } from 'next/server';
import { RegionLeadsCommandService } from '@/services/sales/RegionLeadsCommandService';

// Instancia del servicio de comandos de generación de leads regionales
const regionLeadsCommandService = new RegionLeadsCommandService();

export async function GET(request: Request) {
  try {
    // Obtener parámetros de consulta
    const url = new URL(request.url);
    const commandId = url.searchParams.get('commandId');
    
    // Validar parámetro de ID de comando
    if (!commandId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'commandId parameter is required' } },
        { status: 400 }
      );
    }
    
    // Obtener estado del comando
    const statusResult = await regionLeadsCommandService.getCommandStatus(commandId);
    
    if (!statusResult.success) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Command not found or invalid' } },
        { status: 404 }
      );
    }
    
    // Devolver estado
    return NextResponse.json({
      success: true,
      data: statusResult.data
    });
    
  } catch (error) {
    console.error('General error in region lead status route:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
} 