import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Valid lead status values
const VALID_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'] as const;
type LeadStatus = typeof VALID_STATUSES[number];

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Function to validate email format
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Function to validate phone number (basic validation)
function isValidPhone(phone: string): boolean {
  // Remove common formatting characters
  const cleanPhone = phone.replace(/[\s\-\(\)\+]/g, '');
  // Check if it contains only digits and has at least 10 digits
  return /^\d{10,}$/.test(cleanPhone);
}

/**
 * Endpoint to qualify/change the status of a lead
 * 
 * @param request Request with lead identifier (lead_id, email, or phone) + site_id and new status
 * @returns Response with the updated lead data
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extract parameters
    const { 
      lead_id,
      email,
      phone,
      site_id,
      status,
      notes
    } = body;
    
    // Validate that site_id is provided
    if (!site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'site_id is required'
        },
        { status: 400 }
      );
    }
    
    // Validate site_id format
    if (!isValidUUID(site_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'site_id must be a valid UUID'
        },
        { status: 400 }
      );
    }
    
    // Validate that at least one identifier is provided
    if (!lead_id && !email && !phone) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'At least one identifier is required: lead_id, email, or phone'
        },
        { status: 400 }
      );
    }
    
    // Validate status is provided
    if (!status) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'status is required'
        },
        { status: 400 }
      );
    }
    
    // Validate status value
    if (!VALID_STATUSES.includes(status as LeadStatus)) {
      return NextResponse.json(
        { 
          success: false, 
          error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`
        },
        { status: 400 }
      );
    }
    
    // Validate identifier formats if provided
    if (lead_id && !isValidUUID(lead_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'lead_id must be a valid UUID'
        },
        { status: 400 }
      );
    }
    
    if (email && !isValidEmail(email)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'email format is invalid'
        },
        { status: 400 }
      );
    }
    
    if (phone && !isValidPhone(phone)) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'phone format is invalid'
        },
        { status: 400 }
      );
    }
    
    // Build query to find the lead
    let query = supabaseAdmin
      .from('leads')
      .select('*')
      .eq('site_id', site_id);
    
    // Add identifier conditions
    if (lead_id) {
      query = query.eq('id', lead_id);
    } else if (email) {
      query = query.eq('email', email);
    } else if (phone) {
      // Clean phone for comparison
      const cleanPhone = phone.replace(/[\s\-\(\)\+]/g, '');
      query = query.ilike('phone', `%${cleanPhone}%`);
    }
    
    // Execute query
    const { data: leads, error: searchError } = await query;
    
    if (searchError) {
      console.error('Error searching for lead:', searchError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Error searching for lead'
        },
        { status: 500 }
      );
    }
    
    // Check if lead was found
    if (!leads || leads.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'Lead not found with the provided identifiers'
        },
        { status: 404 }
      );
    }
    
    // If multiple leads found (edge case with phone/email), use the first one
    const lead = leads[0];
    const leadId = lead.id;
    
    // Check if status is already the desired one
    if (lead.status === status) {
      return NextResponse.json(
        { 
          success: true, 
          message: 'Lead already has the specified status',
          lead,
          status_changed: false
        },
        { status: 200 }
      );
    }
    
    // Prepare update data
    const updateData: any = {
      status,
      updated_at: new Date().toISOString()
    };
    
    // Add notes if provided
    if (notes) {
      updateData.notes = notes;
    }
    
    // Update the lead status
    const { data: updatedLead, error: updateError } = await supabaseAdmin
      .from('leads')
      .update(updateData)
      .eq('id', leadId)
      .select()
      .single();
    
    if (updateError) {
      console.error('Error updating lead status:', updateError);
      return NextResponse.json(
        { 
          success: false, 
          error: 'Failed to update lead status'
        },
        { status: 500 }
      );
    }
    
    // Get status change metadata
    const statusChange = {
      from: lead.status,
      to: status,
      timestamp: new Date().toISOString()
    };
    
    // Success response
    return NextResponse.json(
      {
        success: true,
        message: 'Lead status updated successfully',
        lead: updatedLead,
        status_changed: true,
        status_change: statusChange,
        next_actions: generateNextActions(updatedLead, statusChange)
      },
      { status: 200 }
    );
    
  } catch (error) {
    console.error('Error processing lead qualification:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'An error occurred while processing the lead qualification'
      },
      { status: 500 }
    );
  }
}

/**
 * Generates suggested next actions based on the new status
 */
function generateNextActions(lead: any, statusChange: any) {
  const actions = [];
  const newStatus = statusChange.to;
  
  switch (newStatus) {
    case 'contacted':
      actions.push({
        action_type: 'follow_up',
        priority: 'medium',
        description: 'Schedule follow-up communication within 2-3 days'
      });
      actions.push({
        action_type: 'log_interaction',
        priority: 'high',
        description: 'Log details of the contact interaction'
      });
      break;
      
    case 'qualified':
      actions.push({
        action_type: 'demo',
        priority: 'high',
        description: 'Schedule product demo or detailed presentation'
      });
      actions.push({
        action_type: 'assessment',
        priority: 'high',
        description: 'Conduct needs assessment and budget qualification'
      });
      actions.push({
        action_type: 'assign_sales',
        priority: 'high',
        description: 'Assign to appropriate sales representative'
      });
      break;
      
    case 'converted':
      actions.push({
        action_type: 'onboarding',
        priority: 'high',
        description: 'Begin customer onboarding process'
      });
      actions.push({
        action_type: 'celebrate',
        priority: 'medium',
        description: 'Send welcome message and celebrate the conversion'
      });
      actions.push({
        action_type: 'update_crm',
        priority: 'high',
        description: 'Update CRM with conversion details and contract information'
      });
      break;
      
    case 'lost':
      actions.push({
        action_type: 'feedback',
        priority: 'medium',
        description: 'Request feedback on why the lead was lost'
      });
      actions.push({
        action_type: 'nurture',
        priority: 'low',
        description: 'Add to long-term nurture campaign for potential re-engagement'
      });
      actions.push({
        action_type: 'analyze',
        priority: 'low',
        description: 'Analyze loss reasons to improve future conversions'
      });
      break;
      
    case 'new':
      actions.push({
        action_type: 'initial_contact',
        priority: 'high',
        description: 'Initiate first contact with the lead'
      });
      actions.push({
        action_type: 'research',
        priority: 'medium',
        description: 'Research lead background and company information'
      });
      break;
  }
  
  // Add scoring-based actions
  if (lead.lead_score && lead.lead_score >= 80) {
    actions.push({
      action_type: 'priority_handling',
      priority: 'high',
      description: 'High-score lead - prioritize immediate attention'
    });
  }
  
  return actions;
}

