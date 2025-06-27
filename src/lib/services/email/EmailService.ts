import { createClient } from '@supabase/supabase-js';
import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

export interface EmailMessage {
  id: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  body?: string | null;
  headers?: any;
}

export interface EmailConfig {
  user?: string;
  email?: string;
  password: string;
  host?: string;
  imapHost?: string;
  port?: number;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  tls?: boolean;
  // OAuth2 support
  accessToken?: string;
  useOAuth?: boolean;
}

export class EmailService {
  /**
   * Obtiene emails desde un servidor IMAP usando ImapFlow
   * @param emailConfig Configuración del servidor de email
   * @param limit Número máximo de emails a obtener
   * @param sinceDate Fecha ISO string desde la cual obtener emails
   */
  static async fetchEmails(
    emailConfig: EmailConfig, 
    limit: number = 10,
    sinceDate?: string
  ): Promise<EmailMessage[]> {
    let client: ImapFlow | undefined;
    
    try {
      // Parse ports to ensure they are numbers
      let imapPort = emailConfig.imapPort || 993;
      if (typeof imapPort === 'string') {
        imapPort = parseInt(imapPort, 10);
      }
      
      // Create ImapFlow connection configuration
      const imapConfig: any = {
        host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
        port: imapPort,
        secure: emailConfig.tls !== false,
        logger: false, // Disable logging for production
        tls: {
          rejectUnauthorized: false
        }
      };

      // Configure authentication
      if (emailConfig.useOAuth && emailConfig.accessToken) {
        // OAuth2 authentication
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          accessToken: emailConfig.accessToken
        };
      } else {
        // Traditional password authentication
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          pass: emailConfig.password
        };
      }
      
      // Create ImapFlow client
      client = new ImapFlow(imapConfig);
      
      // Connect to the server
      await client.connect();
      
      // Open INBOX
      const lock = await client.getMailboxLock('INBOX');
      
      try {
        const emails: EmailMessage[] = [];
        
        // Create search criteria
        let searchQuery: any = {};
        if (sinceDate) {
          searchQuery.since = new Date(sinceDate);
        }
        
        // Search for emails
        const messages = [];
        for await (const message of client.fetch(searchQuery, {
          envelope: true,
          bodyParts: ['HEADER', 'TEXT'],
          bodyStructure: true
        })) {
          messages.push(message);
          
          // Limit results
          if (messages.length >= limit) {
            break;
          }
        }
        
        // Process messages
        for (const message of messages) {
          const email: EmailMessage = {
            id: message.uid.toString(),
            subject: message.envelope?.subject || 'No Subject',
            from: message.envelope?.from?.[0]?.address || 'Unknown',
            to: message.envelope?.to?.[0]?.address || 'Unknown',
            date: message.envelope?.date?.toISOString() || new Date().toISOString(),
            body: null,
            headers: null
          };
          
          // Get text body if available
          try {
            const textPart = message.bodyParts?.get('TEXT');
            if (textPart) {
              email.body = textPart.toString('utf8');
            }
          } catch (bodyError) {
            console.warn('Error reading email body:', bodyError);
            email.body = null;
          }
          
          // Get headers if available
          try {
            const headerPart = message.bodyParts?.get('HEADER');
            if (headerPart) {
              const headerStr = headerPart.toString('utf8');
              const headers: any = {};
              const headerLines = headerStr.split('\r\n');
              let currentHeader = '';
              
              for (const line of headerLines) {
                if (!line.trim()) continue;
                
                if (line.match(/^\s/)) {
                  if (currentHeader) {
                    headers[currentHeader] += ' ' + line.trim();
                  }
                } else {
                  const match = line.match(/^([^:]+):\s*(.*)$/);
                  if (match) {
                    currentHeader = match[1].toLowerCase();
                    headers[currentHeader] = match[2];
                  }
                }
              }
              email.headers = headers;
            }
          } catch (headerError) {
            console.warn('Error reading email headers:', headerError);
            email.headers = null;
          }
          
          emails.push(email);
        }
        
        return emails;
        
      } finally {
        // Always release the lock
        lock.release();
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Email fetch error: ${errorMessage}`);
    } finally {
      // Clean up connection
      if (client) {
        try {
          await client.logout();
        } catch (logoutError) {
          console.warn('Error during IMAP logout:', logoutError);
        }
      }
    }
  }
} 