import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Endpoint para gestión manual de templates de WhatsApp pre-aprobados
 * 
 * Los templates de WhatsApp deben crearse y aprobarse manualmente en Meta Business Manager.
 * Este endpoint permite agregar referencias a templates ya aprobados para que el sistema
 * pueda utilizarlos automáticamente cuando sea necesario.
 * 
 * GET: Lista templates existentes para un sitio
 * POST: Agrega referencia a un template pre-aprobado
 * DELETE: Elimina/desactiva referencia a un template
 */

/**
 * GET - Lista templates existentes
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const siteId = searchParams.get('site_id');
    
    if (!siteId) {
      return NextResponse.json({
        success: false,
        error: 'site_id is required'
      }, { status: 400 });
    }
    
    const { data: templates, error } = await supabaseAdmin
      .from('whatsapp_templates')
      .select('*')
      .eq('site_id', siteId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error al obtener templates:', error);
      return NextResponse.json({
        success: false,
        error: 'Failed to retrieve templates'
      }, { status: 500 });
    }
    
    return NextResponse.json({
      success: true,
      templates: templates || [],
      count: templates?.length || 0
    });
    
  } catch (error) {
    console.error('Error en GET de templates:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error'
    }, { status: 500 });
  }
}

/**
 * POST - Agrega referencia a template pre-aprobado
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      template_sid,
      template_name,
      content,
      original_message,
      site_id,
      account_sid,
      language = 'es'
    } = body;
    
    // Validar campos requeridos
    const requiredFields = [
      { field: 'template_sid', value: template_sid },
      { field: 'template_name', value: template_name },
      { field: 'content', value: content },
      { field: 'site_id', value: site_id },
      { field: 'account_sid', value: account_sid }
    ];
    
    for (const { field, value } of requiredFields) {
      if (!value) {
        return NextResponse.json({
          success: false,
          error: `${field} is required`
        }, { status: 400 });
      }
    }
    
    console.log('📝 [WhatsAppTemplates] Agregando referencia de template pre-aprobado:', {
      template_sid,
      template_name,
      site_id,
      account_sid
    });
    
    // Insertar referencia del template
    const { data: template, error } = await supabaseAdmin
      .from('whatsapp_templates')
      .insert([{
        template_sid,
        template_name,
        content,
        original_message: original_message || content,
        site_id,
        account_sid,
        language,
        status: 'active',
        usage_count: 0
      }])
      .select()
      .single();
    
    if (error) {
      console.error('Error al insertar template:', error);
      
      if (error.code === '23505') {
        return NextResponse.json({
          success: false,
          error: 'Template SID already exists'
        }, { status: 409 });
      }
      
      return NextResponse.json({
        success: false,
        error: 'Failed to create template reference'
      }, { status: 500 });
    }
    
    console.log('✅ [WhatsAppTemplates] Referencia de template creada exitosamente:', template.id);
    
    return NextResponse.json({
      success: true,
      template,
      message: 'Template reference created successfully'
    }, { status: 201 });
    
  } catch (error) {
    console.error('Error en POST de templates:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error'
    }, { status: 500 });
  }
}

/**
 * DELETE - Desactiva referencia de template
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const templateId = searchParams.get('id');
    const templateSid = searchParams.get('template_sid');
    
    if (!templateId && !templateSid) {
      return NextResponse.json({
        success: false,
        error: 'Either id or template_sid is required'
      }, { status: 400 });
    }
    
    let query = supabaseAdmin
      .from('whatsapp_templates')
      .update({ status: 'inactive' });
    
    if (templateId) {
      query = query.eq('id', templateId);
    } else {
      query = query.eq('template_sid', templateSid);
    }
    
    const { data, error } = await query.select().single();
    
    if (error) {
      console.error('Error al desactivar template:', error);
      return NextResponse.json({
        success: false,
        error: 'Failed to deactivate template'
      }, { status: 500 });
    }
    
    if (!data) {
      return NextResponse.json({
        success: false,
        error: 'Template not found'
      }, { status: 404 });
    }
    
    console.log('🗑️ [WhatsAppTemplates] Template desactivado exitosamente:', data.id);
    
    return NextResponse.json({
      success: true,
      template: data,
      message: 'Template deactivated successfully'
    });
    
  } catch (error) {
    console.error('Error en DELETE de templates:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error'
    }, { status: 500 });
  }
} 