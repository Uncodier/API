import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';

export const dynamic = 'force-dynamic';

// Initialize the command service
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

/**
 * Validates if a string is a valid UUID
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * GET handler to check the status of a lead generation command
 */
export async function GET(request: NextRequest) {
  try {
    // Extract command_id from URL path
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    const command_id = pathSegments[pathSegments.length - 1];
    
    // Validate the command_id
    if (!command_id || !isValidUUID(command_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'Invalid command_id format' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Query the command from the database
    const { data: commandData, error: commandError } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('id', command_id)
      .single();
    
    if (commandError) {
      console.error('Error fetching command:', commandError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_ERROR', 
            message: 'Error retrieving command information' 
          } 
        },
        { status: 500 }
      );
    }
    
    if (!commandData) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_NOT_FOUND', 
            message: 'Command not found' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Get the internal command details if available
    let progress = { percentage: 0, stage: 'initializing' };
    let leads_found = 0;
    let leads_verified = 0;
    let estimated_time_remaining = '00:00:00';
    
    if (commandData.internal_id) {
      try {
        const internalCommand = await commandService.getCommandById(commandData.internal_id);
        
        if (internalCommand) {
          // Extract progress information
          if (internalCommand.progress) {
            progress.percentage = internalCommand.progress.percentage || 0;
            progress.stage = internalCommand.progress.stage || 'processing';
          }
          
          // Extract lead counts if available
          if (internalCommand.results && internalCommand.results.length > 0) {
            const leadsResult = internalCommand.results.find((r: any) => 
              r.leads || (r.content && r.content.leads)
            );
            
            if (leadsResult) {
              const leadsArray = leadsResult.leads || 
                                (leadsResult.content ? leadsResult.content.leads : null);
              
              if (leadsArray && Array.isArray(leadsArray)) {
                leads_found = leadsArray.length;
                leads_verified = leadsArray.filter((l: any) => l.verified).length;
              }
            }
          }
          
          // Calculate estimated time remaining
          if (progress.percentage > 0 && progress.percentage < 100) {
            const elapsedTime = new Date().getTime() - new Date(commandData.created_at).getTime();
            const totalEstimatedTime = elapsedTime / (progress.percentage / 100);
            const remainingMs = totalEstimatedTime - elapsedTime;
            
            // Format remaining time as HH:MM:SS
            const remainingSec = Math.floor(remainingMs / 1000);
            const hours = Math.floor(remainingSec / 3600);
            const minutes = Math.floor((remainingSec % 3600) / 60);
            const seconds = remainingSec % 60;
            
            estimated_time_remaining = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
          }
        }
      } catch (cmdError) {
        console.error('Error retrieving internal command:', cmdError);
        // Continue without internal command details
      }
    }
    
    // Return the command status
    return NextResponse.json({
      success: true,
      data: {
        command_id: commandData.id,
        site_id: commandData.site_id,
        status: commandData.status,
        progress: {
          percentage: progress.percentage,
          stage: progress.stage,
          leads_found,
          leads_verified,
          estimated_time_remaining
        },
        created_at: commandData.created_at,
        updated_at: commandData.updated_at
      }
    });
    
  } catch (error) {
    console.error('Error in lead generation status endpoint:', error);
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