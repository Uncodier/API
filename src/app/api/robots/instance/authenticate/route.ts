import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ScrapybaraClient } from 'scrapybara';

// ------------------------------------------------------------------------------------
// POST /api/robots/instance/authenticate
// Authenticates a browser instance using a saved authentication session
// ------------------------------------------------------------------------------------

export const maxDuration = 120; // 2 minutes

const AuthenticateSchema = z.object({
  instance_id: z.string().uuid('instance_id inválido').optional(),
  remote_instance_id: z.string().min(1, 'remote_instance_id requerido').optional(),
  automation_auth_sessions_id: z.string().uuid('automation_auth_sessions_id debe ser un UUID válido'),
}).refine(
  (data) => data.instance_id || data.remote_instance_id,
  { message: 'Se requiere instance_id o remote_instance_id' }
);

export async function POST(request: NextRequest) {
  try {
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = await request.json();
    console.log(`[robots/instance/authenticate][${reqId}] Incoming request`, { keys: Object.keys(body || {}) });
    
    const { instance_id, remote_instance_id, automation_auth_sessions_id } = AuthenticateSchema.parse(body);
    console.log(`[robots/instance/authenticate][${reqId}] Parsed payload`, { instance_id, remote_instance_id, automation_auth_sessions_id });

    // 1. Look up authentication session ----------------------------------------------------------------
    const { data: authSession, error: authSessionError } = await supabaseAdmin
      .from('automation_auth_sessions')
      .select('*')
      .eq('id', automation_auth_sessions_id)
      .single();

    if (authSessionError || !authSession) {
      console.error(`[robots/instance/authenticate][${reqId}] Authentication session not found:`, authSessionError);
      return NextResponse.json(
        { error: 'Authentication session not found' },
        { status: 404 }
      );
    }

    if (!authSession.is_valid) {
      console.error(`[robots/instance/authenticate][${reqId}] Authentication session is invalid`);
      return NextResponse.json(
        { error: 'Authentication session is invalid' },
        { status: 400 }
      );
    }

    if (!authSession.provider_auth_state_id) {
      console.error(`[robots/instance/authenticate][${reqId}] Authentication session has no provider_auth_state_id`);
      return NextResponse.json(
        { error: 'Authentication session has no provider_auth_state_id' },
        { status: 400 }
      );
    }

    console.log(`[robots/instance/authenticate][${reqId}] Authentication session found`, {
      id: authSession.id,
      name: authSession.name,
      provider_auth_state_id: authSession.provider_auth_state_id
    });

    // 2. Look up instance ----------------------------------------------------------------------------
    let instance, instanceError;

    if (instance_id) {
      console.log(`[robots/instance/authenticate][${reqId}] Looking up instance by instance_id`, { instance_id });
      const result = await supabaseAdmin
        .from('remote_instances')
        .select('*')
        .eq('id', instance_id)
        .single();
      instance = result.data;
      instanceError = result.error;
    } else if (remote_instance_id) {
      // Determine if it's a UUID (internal ID) or provider_instance_id
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(remote_instance_id);
      console.log(`[robots/instance/authenticate][${reqId}] Looking up instance by remote_instance_id`, { remote_instance_id, isUUID });
      
      let result;
      if (isUUID) {
        // Look up by internal database ID
        result = await supabaseAdmin
          .from('remote_instances')
          .select('*')
          .eq('id', remote_instance_id)
          .single();
      } else {
        // Look up by provider_instance_id
        result = await supabaseAdmin
          .from('remote_instances')
          .select('*')
          .eq('provider_instance_id', remote_instance_id)
          .single();
      }
      
      instance = result.data;
      instanceError = result.error;
    }

    if (instanceError || !instance) {
      console.error(`[robots/instance/authenticate][${reqId}] Instance not found:`, instanceError);
      return NextResponse.json(
        { error: 'Instance not found' },
        { status: 404 }
      );
    }

    console.log(`[robots/instance/authenticate][${reqId}] Instance found`, {
      id: instance.id,
      provider_instance_id: instance.provider_instance_id
    });

    // Use provider_instance_id for Scrapybara API calls
    const effectiveRemoteInstanceId = instance.provider_instance_id || remote_instance_id;
    if (!effectiveRemoteInstanceId) {
      console.error(`[robots/instance/authenticate][${reqId}] No provider_instance_id available`);
      return NextResponse.json(
        { error: 'Instance has no provider_instance_id' },
        { status: 400 }
      );
    }

    // 3. Authenticate using Scrapybara SDK ---------------------------------------------------------
    const scrapybaraApiKey = process.env.SCRAPYBARA_API_KEY;
    if (!scrapybaraApiKey) {
      console.error(`[robots/instance/authenticate][${reqId}] SCRAPYBARA_API_KEY not configured`);
      return NextResponse.json(
        { error: 'SCRAPYBARA_API_KEY not configured' },
        { status: 500 }
      );
    }

    console.log(`[robots/instance/authenticate][${reqId}] Connecting to Scrapybara instance`, {
      provider_instance_id: effectiveRemoteInstanceId
    });

    const client = new ScrapybaraClient({ apiKey: scrapybaraApiKey });
    const remoteInstance = await client.get(effectiveRemoteInstanceId) as any;

    // Verify instance has browser property
    if (!remoteInstance.browser) {
      console.error(`[robots/instance/authenticate][${reqId}] Instance does not support browser operations`);
      return NextResponse.json(
        { error: 'Instance does not support browser operations' },
        { status: 400 }
      );
    }

    console.log(`[robots/instance/authenticate][${reqId}] Authenticating browser`, {
      auth_state_id: authSession.provider_auth_state_id
    });

    try {
      await remoteInstance.browser.authenticate({ authStateId: authSession.provider_auth_state_id });
      console.log(`[robots/instance/authenticate][${reqId}] Authentication successful`);
    } catch (authError: any) {
      console.error(`[robots/instance/authenticate][${reqId}] Authentication failed`, {
        error: authError?.message,
        stack: authError?.stack
      });
      return NextResponse.json(
        { error: 'Failed to authenticate browser', details: authError?.message || 'Unknown error' },
        { status: 500 }
      );
    }

    // 4. Update session usage statistics -------------------------------------------------------------
    try {
      await supabaseAdmin
        .from('automation_auth_sessions')
        .update({
          last_used_at: new Date().toISOString(),
          usage_count: (authSession.usage_count || 0) + 1
        })
        .eq('id', automation_auth_sessions_id);
      console.log(`[robots/instance/authenticate][${reqId}] Updated session usage statistics`);
    } catch (updateError) {
      console.warn(`[robots/instance/authenticate][${reqId}] Failed to update session usage:`, updateError);
      // Don't fail the request if usage update fails
    }

    return NextResponse.json(
      {
        success: true,
        instance_id: instance.id,
        provider_instance_id: effectiveRemoteInstanceId,
        auth_session_id: authSession.id,
        auth_session_name: authSession.name
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error(`[robots/instance/authenticate] Error in POST /robots/instance/authenticate`, {
      message: err?.message,
      stack: err?.stack
    });
    
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request parameters', details: err.errors },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

