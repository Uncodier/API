/**
 * Email Sync Error Service
 * Handles email sync failures including channel status updates and notifications
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface EmailSyncErrorDetails {
  siteId: string;
  errorMessage: string;
  errorType: 'connection' | 'configuration' | 'fetch';
  errorCode: string;
}

export class EmailSyncErrorService {
  /**
   * Handle email sync failure by updating channel status and sending notification
   */
  static async handleEmailSyncFailure(details: EmailSyncErrorDetails): Promise<void> {
    const { siteId, errorMessage, errorType } = details;
    
    console.error(`[EmailSyncErrorService] 🔌 ${errorType} failure detected, updating channel status and sending notification`);
    
    try {
      // Update settings.channels to mark email as failed and disabled
      const didChange = await this.updateChannelStatus(siteId, errorMessage);
      
      // Send notification about the failure ONLY if we actually changed the channel status
      if (didChange) {
        await this.sendFailureNotification(siteId, errorMessage);
      } else {
        console.log(`[EmailSyncErrorService] ℹ️ Channel already disabled with error status; skipping duplicate notification`);
      }
      
      console.log(`[EmailSyncErrorService] ✅ Email sync failure handled: channel disabled and notification sent`);
    } catch (failureHandlingError) {
      console.error(`[EmailSyncErrorService] ❌ Error handling sync failure:`, failureHandlingError);
      throw failureHandlingError;
    }
  }

  /**
   * Update email channel status to failed and disabled
   */
  private static async updateChannelStatus(siteId: string, errorMessage: string): Promise<boolean> {
    try {
      console.log(`[EmailSyncErrorService] 🔧 Updating settings.channels for email sync failure`);
      
      // Get current settings
      const { data: settings, error: getError } = await supabaseAdmin
        .from('settings')
        .select('channels')
        .eq('site_id', siteId)
        .single();
      
      if (getError) {
        console.error('[EmailSyncErrorService] Error getting settings:', getError);
        return false;
      }
      
      const currentChannels = settings?.channels || {};
      
      // If already disabled and marked as error, avoid duplicate updates/notifications
      const alreadyFailed = Boolean(
        currentChannels?.email &&
        currentChannels.email.enabled === false &&
        (currentChannels.email.sync_status === 'error' || currentChannels.email.synced === 'failed')
      );
      if (alreadyFailed) {
        console.log(`[EmailSyncErrorService] ℹ️ Email channel already disabled and in error state; skipping update`);
        return false;
      }

      // Update email channel status
      const updatedChannels = {
        ...currentChannels,
        email: {
          ...currentChannels.email,
          synced: 'failed',
          enabled: false,
          last_sync_error: errorMessage,
          last_sync_attempt: new Date().toISOString(),
          sync_status: 'error'
        }
      };
      
      // Update the settings
      const { error: updateError } = await supabaseAdmin
        .from('settings')
        .update({ channels: updatedChannels })
        .eq('site_id', siteId);
      
      if (updateError) {
        console.error('[EmailSyncErrorService] Error updating settings:', updateError);
        return false;
      }
      
      console.log(`[EmailSyncErrorService] ✅ Settings.channels updated: email marked as failed and disabled`);
      return true;
    } catch (error) {
      console.error('[EmailSyncErrorService] Error in updateChannelStatus:', error);
      throw error;
    }
  }

  /**
   * Send email sync failure notification
   */
  private static async sendFailureNotification(siteId: string, errorMessage: string): Promise<void> {
    try {
      console.log(`[EmailSyncErrorService] 📧 Sending email sync failure notification`);
      
      const notificationPayload = {
        site_id: siteId,
        error_message: errorMessage,
        failure_timestamp: new Date().toISOString(),
        priority: 'high'
      };
      
      // Call the notification endpoint
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const notificationUrl = `${baseUrl}/api/notifications/emailSyncFailure`;
      
      const response = await fetch(notificationUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(notificationPayload),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[EmailSyncErrorService] Failed to send notification:`, {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });
        return;
      }
      
      const result = await response.json();
      console.log(`[EmailSyncErrorService] ✅ Email sync failure notification sent successfully:`, {
        success: result.success,
        notificationId: result.notification_id
      });
    } catch (error) {
      console.error('[EmailSyncErrorService] Error sending failure notification:', error);
      throw error;
    }
  }

  /**
   * Determine error type based on error message
   */
  static determineErrorType(error: Error): 'connection' | 'configuration' | 'fetch' {
    // Aggregate as much context as possible to correctly classify auth errors
    const message = (error.message || '').toLowerCase();
    const responseText = typeof (error as any)?.responseText === 'string' ? ((error as any).responseText as string).toLowerCase() : '';
    const response = typeof (error as any)?.response === 'string' ? ((error as any).response as string).toLowerCase() : '';
    const serverCode = typeof (error as any)?.serverResponseCode === 'string' ? ((error as any).serverResponseCode as string).toLowerCase() : '';
    const executedCommand = typeof (error as any)?.executedCommand === 'string' ? ((error as any).executedCommand as string).toLowerCase() : '';
    const authenticationFailed = Boolean((error as any)?.authenticationFailed);

    const combined = [message, responseText, response, serverCode, executedCommand]
      .filter(Boolean)
      .join(' | ');
    
    // Configuration errors
    if (
      combined.includes('settings') ||
      combined.includes('token') ||
      combined.includes('oauth') ||
      combined.includes('config')
    ) {
      return 'configuration';
    }
    
    // Connection/authentication errors
    if (
      combined.includes('connect') ||
      combined.includes('timeout') ||
      combined.includes('econnrefused') ||
      combined.includes('enotfound') ||
      authenticationFailed ||
      combined.includes('authentication') || // English
      combined.includes('autenticación') || // Spanish
      combined.includes('invalid credentials') ||
      combined.includes('credentials') ||
      combined.includes('authenticate') ||
      combined.includes('authenticationfailed') ||
      combined.includes('login')
    ) {
      return 'connection';
    }
    
    // Default to fetch error
    return 'fetch';
  }

  /**
   * Check if error should trigger failure handling (channel update + notification)
   */
  static shouldHandleAsFailure(errorType: 'connection' | 'configuration' | 'fetch'): boolean {
    // Handle both connection and configuration errors
    return errorType === 'connection' || errorType === 'configuration';
  }
}
