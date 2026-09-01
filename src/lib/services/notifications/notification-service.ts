import { sendGridService } from '../sendgrid-service';
import { supabaseAdmin } from '../../database/supabase-client';

export interface NotificationData {
  id: string;
  type: string;
  recipients: string[];
  subject: string;
  data: Record<string, any>;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  channel: 'email' | 'whatsapp' | 'phone' | 'chat' | 'form' | 'other';
  site_id: string;
  created_at: Date;
}

export interface NotificationResult {
  success: boolean;
  error?: string;
  data?: {
    notification_id: string;
    recipients_sent: string[];
    sent_at: string;
  };
}

export abstract class BaseNotification {
  protected data: NotificationData;
  
  constructor(data: NotificationData) {
    this.data = data;
  }
  
  abstract generateEmailHtml(): string;
  abstract generateEmailSubject(): string;
  
  async send(): Promise<NotificationResult> {
    try {
      const subject = this.generateEmailSubject();
      const html = this.generateEmailHtml();
      
      const emailPromises = this.data.recipients.map(async (recipient) => {
        const result = await sendGridService.sendEmail({
          to: recipient,
          subject,
          html,
          categories: [this.data.type, `priority-${this.data.priority}`],
          customArgs: {
            notification_id: this.data.id,
            site_id: this.data.site_id,
            type: this.data.type,
            priority: this.data.priority
          }
        });
        
        return { recipient, success: result.success, error: result.error };
      });
      
      const results = await Promise.all(emailPromises);
      const successfulSends = results.filter(r => r.success);
      
      if (successfulSends.length > 0) {
        return {
          success: true,
          data: {
            notification_id: this.data.id,
            recipients_sent: successfulSends.map(r => r.recipient),
            sent_at: new Date().toISOString()
          }
        };
      } else {
        return {
          success: false,
          error: 'Failed to send to any recipients'
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

export class NotificationService {
  static async createNotification(type: string, data: any): Promise<BaseNotification | null> {
    switch (type) {
      case 'lead-attention':
        return new LeadAttentionNotification(data);
      default:
        return null;
    }
  }
}

// Funciones de branding
function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Makinari, your AI Sales Team';
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
}

export class LeadAttentionNotification extends BaseNotification {
  generateEmailSubject(): string {
    const channelNames = {
      email: 'Email',
      whatsapp: 'WhatsApp', 
      phone: 'Phone',
      chat: 'Chat',
      form: 'Form',
      other: 'Other'
    };
    
    const leadName = this.data.data.lead_info?.name || 'New Lead';
    const channel = channelNames[this.data.channel as keyof typeof channelNames] || 'Other';
    
    return `🔔 Lead Attention Required: ${leadName} contacted you via ${channel}`;
  }
  
  generateEmailHtml(): string {
    const data = this.data.data;
    
    const channelIcons = {
      email: '📧',
      whatsapp: '📱',
      phone: '☎️',
      chat: '💬',
      form: '📝',
      other: '🔔'
    };
    
    const channelNames = {
      email: 'Email',
      whatsapp: 'WhatsApp',
      phone: 'Phone',
      chat: 'Chat',
      form: 'Form',
      other: 'Other'
    };
    
    const priorityColors = {
      low: { bg: '#f0f9ff', color: '#0369a1', badge: '#e0f2fe' },
      normal: { bg: '#f8fafc', color: '#334155', badge: '#e2e8f0' },
      high: { bg: '#fff7ed', color: '#c2410c', badge: '#fed7aa' },
      urgent: { bg: '#fef2f2', color: '#dc2626', badge: '#fecaca' }
    };
    
    const priorityColor = priorityColors[this.data.priority] || priorityColors.normal;
    
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
<style type="text/css">
        :root { color-scheme: light only; }

    .email-header {
      background-color: #1e1e2d !important;
      background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
    }
    .email-header-title,
    .email-header h1 {
      color: #f0f0f5 !important;
      -webkit-text-fill-color: #f0f0f5 !important;
    }
    .email-header-sub,
    .email-header p {
      color: #a1a1aa !important;
      -webkit-text-fill-color: #a1a1aa !important;
    }

    .email-card {
      background-color: #ffffff !important;
      background-image: linear-gradient(#ffffff, #ffffff) !important;
      color: #111111 !important;
    }

    .email-heading {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }
    .email-text {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }
    .email-muted,
    .email-subtle {
      color: #52525b !important;
      -webkit-text-fill-color: #52525b !important;
    }

    .email-panel {
      background-color: #f0f0f5 !important;
      background-image: linear-gradient(#f0f0f5, #f0f0f5) !important;
      border: 1px solid #e4e4e7 !important;
      color: #111111 !important;
    }
    .email-panel,
    .email-panel .email-text,
    .email-panel .email-heading,
    .email-panel div,
    .email-panel p,
    .email-panel span:not(.email-badge):not(.email-cta-label),
    .email-panel strong {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }

    .email-code-box {
      background-color: #f4ffe5 !important;
      background-image: linear-gradient(#f4ffe5, #f4ffe5) !important;
      border: 1px solid #c6f08a !important;
    }
    .email-code-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
    }
    .email-code-value {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }

    .email-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
      font-weight: 600 !important;
    }

    .email-badge {
      display: inline-block !important;
      background-color: #90ff17 !important;
      background-image: linear-gradient(#90ff17, #90ff17) !important;
      box-shadow: inset 0 0 0 999px #90ff17 !important;
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
      border: 0 !important;
    }

    .email-link {
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
    }

    .email-cta-td {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
    }
    .email-cta {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
      border: 0 !important;
    }
    .email-cta-label,
    .email-cta span {
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
    }
        
</style>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Lead Attention Required - ${data.site_info?.name}</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
        
        <!-- Main Container -->
        <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
          
          <!-- Header -->
          <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
            ${data.site_info?.logo_url ? `
            <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
              <img src="${data.site_info.logo_url}" alt="${data.site_info.name} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #f0f0f5; display: block;" />
            </div>
            ` : `
            <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
              <div style="width: 48px; height: 48px; background-color: #f0f0f5; border-radius: 50%; position: relative; margin: 0 auto;">
                <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 24px;">🔔</div>
              </div>
            </div>
            `}
            <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">Lead Attention Required</h1>
            <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">Your assigned lead needs attention</p>
          </div>
          
          <!-- Content -->
          <div style="padding: 40px;">
            
            <!-- Greeting -->
            <div style="margin-bottom: 32px;">
              <h2 class="email-heading" style="margin: 0 0 16px; font-size: 20px; color: #111111; font-weight: 600;">
                Hello ${data.team_member_info?.name || 'Team Member'}
              </h2>
              <p class="email-text" style="margin: 0; font-size: 16px; color: #111111; line-height: 1.7;">
                Your assigned lead <strong>${data.lead_info?.name || 'Unknown Lead'}</strong> has contacted you through <strong>${channelNames[this.data.channel as keyof typeof channelNames]}</strong> and requires your attention.
              </p>
            </div>
            
            <!-- Priority Badge -->
            <div style="margin-bottom: 32px; text-align: center;">
              <div class="email-badge" style="display: inline-block; background-color: ${priorityColor.badge}; color: ${priorityColor.color}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
                ${this.data.priority} Priority
              </div>
            </div>
            
            <!-- Channel Information -->
            <div style="margin-bottom: 32px;">
              <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Contact Information</h3>
              <div class="email-panel" style="background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
                <div style="margin-bottom: 12px;">
                  <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 80px;">Channel:</span>
                  <span class="email-text" style="color: #111111; font-size: 15px;">
                    ${channelIcons[this.data.channel as keyof typeof channelIcons]} ${channelNames[this.data.channel as keyof typeof channelNames]}
                  </span>
                </div>
                <div style="margin-bottom: 12px;">
                  <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 80px;">Name:</span>
                  <span class="email-text" style="color: #111111; font-size: 15px;">${data.lead_info?.name || 'Unknown Lead'}</span>
                </div>
                <div style="margin-bottom: 12px;">
                  <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 80px;">Email:</span>
                  <a href="mailto:${data.lead_info?.email || ''}" style="color: #000000; font-weight: 600; text-decoration: none; font-size: 15px;">
                    ${data.lead_info?.email || 'No email'}
                  </a>
                </div>
                ${data.contact_info?.phone ? `
                <div style="margin-bottom: 12px;">
                  <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 80px;">Phone:</span>
                  <a href="tel:${data.contact_info.phone}" style="color: #000000; font-weight: 600; text-decoration: none; font-size: 15px;">
                    ${data.contact_info.phone}
                  </a>
                </div>
                ` : ''}
                ${data.contact_info?.contact_method ? `
                <div>
                  <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 80px;">Method:</span>
                  <span class="email-text" style="color: #111111; font-size: 15px;">${data.contact_info.contact_method}</span>
                </div>
                ` : ''}
              </div>
            </div>
            
            <!-- Messages -->
            ${data.user_message || data.system_message ? `
            <div style="margin-bottom: 32px;">
              <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Messages</h3>
              ${data.user_message ? `
              <div style="margin-bottom: 16px;">
                <h4 style="margin: 0 0 8px; font-size: 16px; color: #000000; font-weight: 600; font-weight: 600;">User Message</h4>
                <div class="email-panel" style="background-color: #f0f0f5; padding: 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
                  <div class="email-text" style="color: #111111; font-size: 16px; line-height: 1.7;">
                    ${data.user_message}
                  </div>
                </div>
              </div>
              ` : ''}
              ${data.system_message ? `
              <div style="margin-bottom: 16px;">
                <h4 style="margin: 0 0 8px; font-size: 16px; color: #000000; font-weight: 600; font-weight: 600;">System Message</h4>
                <div style="background-color: #fff7ed; padding: 24px; border-radius: 8px; border: 1px solid #fed7aa;">
                  <div class="email-text" style="color: #111111; font-size: 16px; line-height: 1.7;">
                    ${data.system_message}
                  </div>
                </div>
              </div>
              ` : ''}
            </div>
            ` : ''}
            
            <!-- Additional Data -->
            ${data.additional_data && Object.keys(data.additional_data).length > 0 ? `
            <div style="margin-bottom: 32px;">
              <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Additional Information</h3>
              <div style="background-color: #fefce8; padding: 20px 24px; border-radius: 8px; border: 1px solid #fde047;">
                ${Object.entries(data.additional_data).map(([key, value]) => `
                  <div style="margin-bottom: 8px;">
                    <span style="display: inline-block; font-weight: 600; color: #a16207; min-width: 100px; text-transform: capitalize;">${key.replace('_', ' ')}:</span>
                    <span class="email-text" style="color: #111111; font-size: 14px;">${typeof value === 'object' ? JSON.stringify(value) : value}</span>
                  </div>
                `).join('')}
              </div>
            </div>
            ` : ''}
            
            <!-- Action Buttons -->
            <div style="text-align: center; margin: 40px 0 32px;">
              ${data.urls?.lead_url ? `
              <a href="${data.urls.lead_url}" 
                 class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; margin: 0 6px 12px; vertical-align: top;">
                View Lead →
              </a>
              ` : ''}
              ${data.urls?.chat_url ? `
              <a href="${data.urls.chat_url}" 
                 style="display: inline-block; background: #ffffff; color: #000000; border: 2px solid #000000; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s; margin: 0 6px 12px; vertical-align: top;">
                Reply to Lead →
              </a>
              ` : ''}
            </div>
            
            <!-- Urgency Notice -->
            ${this.data.priority === 'urgent' || this.data.priority === 'high' ? `
            <div style="margin-top: 32px; padding: 16px 24px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; text-align: center;">
              <p style="margin: 0; color: #dc2626; font-size: 14px; font-weight: 600;">
                ⚠️ This lead requires ${this.data.priority === 'urgent' ? 'URGENT' : 'HIGH PRIORITY'} attention
              </p>
            </div>
            ` : ''}
            
            <!-- Explanation -->
            <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
              <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; line-height: 1.5;">
                This lead has been assigned to you and contacted through <strong class="email-text" style="color: #111111;">${channelNames[this.data.channel as keyof typeof channelNames]}</strong>.<br>
                Please respond as soon as possible to maintain engagement.
              </p>
            </div>
            
          </div>
          
          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
            <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; text-align: center; line-height: 1.5;">
              This notification was automatically generated by ${getCompanyName()}.<br>
              Manage your notification preferences in your account settings.
            </p>
          </div>
          
        </div>
        
        <!-- Powered by -->
        <div style="text-align: center; margin: 24px 0;">
          <p class="email-subtle" style="margin: 0; color: #71717a; font-size: 12px;">
            Powered by <strong style="color: #000000;">${getBrandingText()}</strong>
          </p>
        </div>
        
      </body>
      </html>
    `;
  }
} 