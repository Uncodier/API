import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';
import { autoAuthenticateInstance } from '@/lib/helpers/automation-auth';
import { completeInProgressPlans } from '@/lib/helpers/plan-lifecycle';

// ------------------------------------------------------------------------------------
// POST /api/robots/plan/initiate
// Inicia una instancia remota basada en Scrapybara para el plan indicado
// ------------------------------------------------------------------------------------

export const maxDuration = 120; // 2 minutos

const InitiateSchema = z.object({
  instance_plan_id: z.string().uuid('instance_plan_id inválido'),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    const { instance_plan_id } = InitiateSchema.parse(rawBody);

    // 1. Buscar el plan --------------------------------------------------------------
    const { data: plan, error: planError } = await supabaseAdmin
      .from('instance_plans')
      .select('*')
      .eq('id', instance_plan_id)
      .single();

    if (planError || !plan) {
      return NextResponse.json({ error: 'Plan no encontrado' }, { status: 404 });
    }

    // 1.5. Complete any existing active plans for this instance before starting a new one
    if (plan.instance_id) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ Completing any existing active plans for instance before initiating new plan`);
      await completeInProgressPlans(plan.instance_id, 'New plan initiated - previous plan auto-completed');
    }

    // 2. Crear instancia en Scrapybara ----------------------------------------------
    const client = new ScrapybaraClient({
      apiKey: process.env.SCRAPYBARA_API_KEY || '',
    });

    // Por defecto iniciamos un entorno Ubuntu completo
    const remoteInstance = await client.startUbuntu({ timeoutHours: 1 });

    // Asegurarse de que el navegador esté iniciado
    const browserStartResult = await remoteInstance.browser.start();
    const cdpUrl = browserStartResult.cdpUrl;

    // 2.1. Buscar y aplicar autenticación automáticamente ---------------------------
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ Attempting auto-authentication for site_id: ${plan.site_id}`);
    const authResult = await autoAuthenticateInstance(remoteInstance.id, plan.site_id);
    
    if (authResult.success) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ✅ Browser authenticated successfully using session: ${authResult.session?.name}`);
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ ⚠️ Auto-authentication not available: ${authResult.error}`);
      // Continuar sin bloquear - el agente manejará la autenticación cuando sea necesaria
    }

    // 3. Registrar instancia en la base de datos ------------------------------------
    const { data: instanceRecord, error: instanceError } = await supabaseAdmin
      .from('remote_instances')
      .insert({
        name: `Automation for ${plan.title}`,
        instance_type: 'ubuntu',
        status: 'running',
        provider_instance_id: remoteInstance.id,
        cdp_url: cdpUrl,
        timeout_hours: 1,
        site_id: plan.site_id,
        user_id: plan.user_id,
        agent_id: plan.agent_id,
        command_id: plan.command_id,
        created_by: plan.user_id,
      })
      .select()
      .single();

    if (instanceError) {
      console.error('Error guardando la instancia:', instanceError);
      return NextResponse.json({ error: 'Error al guardar la instancia' }, { status: 500 });
    }

    // 4. Asociar la instancia al plan ------------------------------------------------
    await supabaseAdmin
      .from('instance_plans')
      .update({ instance_id: instanceRecord.id, status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', instance_plan_id);

    return NextResponse.json(
      {
        instance_id: instanceRecord.id,
        provider_instance_id: remoteInstance.id,
        cdp_url: cdpUrl,
        message: 'Instancia iniciada satisfactoriamente',
        authentication: {
          applied: authResult.success,
          session_name: authResult.session?.name,
          auth_state_id: authResult.auth_state_id,
          error: authResult.error
        }
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error('Error en POST /robots/plan/initiate:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}