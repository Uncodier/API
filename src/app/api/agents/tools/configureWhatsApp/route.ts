import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export type ConfigureWhatsAppAction = 'get_config' | 'set_credentials';

export interface ConfigureWhatsAppBody {
  site_id: string;
  action: ConfigureWhatsAppAction;
  /** For set_credentials: Twilio Account SID (used as phone number ID for WhatsApp API) */
  account_sid?: string;
  /** For set_credentials: Twilio Auth Token / WhatsApp API token (stored encrypted in secure_tokens) */
  access_token?: string;
  /** For set_credentials: WhatsApp Business phone number (e.g. +1234567890) */
  from_number?: string;
}

export interface ConfigureWhatsAppResult {
  success: boolean;
  action: ConfigureWhatsAppAction;
  data?: unknown;
  error?: string;
}

const TOKEN_TYPE_WHATSAPP = 'twilio_whatsapp';

/**
 * Core logic: get WhatsApp config status or set credentials (settings + secure_tokens).
 * Callable directly (assistant) or via HTTP.
 */
export async function configureWhatsAppCore(
  params: ConfigureWhatsAppBody
): Promise<ConfigureWhatsAppResult> {
  const { action, site_id } = params;

  try {
    switch (action) {
      case 'get_config': {
        const { data: siteSettings, error: settingsError } = await supabaseAdmin
          .from('settings')
          .select('channels')
          .eq('site_id', site_id)
          .single();

        if (settingsError || !siteSettings?.channels?.whatsapp) {
          return {
            success: true,
            action: 'get_config',
            data: {
              configured: false,
              message: 'WhatsApp is not configured for this site.',
            },
          };
        }

        const wa = siteSettings.channels.whatsapp as Record<string, unknown>;
        const { data: tokenRow } = await supabaseAdmin
          .from('secure_tokens')
          .select('id')
          .eq('site_id', site_id)
          .eq('token_type', TOKEN_TYPE_WHATSAPP)
          .maybeSingle();

        const configured = !!(wa?.account_sid && tokenRow);
        return {
          success: true,
          action: 'get_config',
          data: {
            configured,
            from_number: wa?.existingNumber ?? wa?.from_number ?? null,
            account_sid_set: !!wa?.account_sid,
            token_stored: !!tokenRow,
            enabled: wa?.enabled === true,
          },
        };
      }

      case 'set_credentials': {
        const account_sid = params.account_sid?.trim();
        const access_token = params.access_token?.trim();
        const from_number = params.from_number?.trim();

        if (!account_sid || !access_token) {
          return {
            success: false,
            action: 'set_credentials',
            error: 'account_sid and access_token are required for set_credentials',
          };
        }

        const { data: existingSettings, error: fetchError } = await supabaseAdmin
          .from('settings')
          .select('id, channels')
          .eq('site_id', site_id)
          .single();

        if (fetchError && fetchError.code !== 'PGRST116') {
          return {
            success: false,
            action: 'set_credentials',
            error: `Failed to fetch settings: ${fetchError.message}`,
          };
        }

        const existingChannels = (existingSettings?.channels as Record<string, unknown>) ?? {};
        const updatedChannels = {
          ...existingChannels,
          whatsapp: {
            ...(typeof existingChannels.whatsapp === 'object' && existingChannels.whatsapp !== null
              ? (existingChannels.whatsapp as Record<string, unknown>)
              : {}),
            account_sid,
            existingNumber: from_number || (existingChannels.whatsapp as any)?.existingNumber,
            enabled: true,
          },
        };

        if (!existingSettings) {
          const { error: insertError } = await supabaseAdmin
            .from('settings')
            .insert({ site_id, channels: updatedChannels });
          if (insertError) {
            return {
              success: false,
              action: 'set_credentials',
              error: `Failed to create settings: ${insertError.message}`,
            };
          }
        } else {
          const { error: updateError } = await supabaseAdmin
            .from('settings')
            .update({ channels: updatedChannels })
            .eq('site_id', site_id);
          if (updateError) {
            return {
              success: false,
              action: 'set_credentials',
              error: `Failed to update settings: ${updateError.message}`,
            };
          }
        }

        const baseUrl =
          process.env.NEXT_PUBLIC_ORIGIN ||
          (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
          'http://localhost:3000';
        const encryptUrl = new URL('/api/secure-tokens/encrypt', baseUrl).toString();

        const encryptRes = await fetch(encryptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            value: access_token,
            site_id,
            token_type: TOKEN_TYPE_WHATSAPP,
            identifier: from_number || account_sid,
            store_in_db: true,
          }),
        });

        const encryptResult = await encryptRes.json();
        if (!encryptRes.ok || !encryptResult.success) {
          return {
            success: false,
            action: 'set_credentials',
            error:
              encryptResult?.error?.message ||
              `Failed to store token: ${encryptRes.status}`,
          };
        }

        return {
          success: true,
          action: 'set_credentials',
          data: {
            message: 'WhatsApp credentials saved. Settings and encrypted token updated.',
            from_number: from_number || null,
          },
        };
      }

      default: {
        const unknown = action as string;
        return {
          success: false,
          action: unknown as ConfigureWhatsAppAction,
          error: `Unknown action: ${unknown}. Use one of: get_config, set_credentials`,
        };
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[configureWhatsApp] ${action} error:`, err);
    return { success: false, action, error: message };
  }
}

/**
 * POST /api/agents/tools/configureWhatsApp
 * Body: { site_id, action, ...params }
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ConfigureWhatsAppBody;
    const { site_id, action } = body;

    if (!site_id) {
      return NextResponse.json(
        { success: false, error: 'site_id is required' },
        { status: 400 }
      );
    }
    if (!action) {
      return NextResponse.json(
        { success: false, error: 'action is required' },
        { status: 400 }
      );
    }

    const result = await configureWhatsAppCore(body);
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: unknown) {
    console.error('[configureWhatsApp] Request error:', error);
    return NextResponse.json(
      {
        success: false,
        action: undefined,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
