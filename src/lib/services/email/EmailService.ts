import { createClient } from '@supabase/supabase-js';
import * as nodemailer from 'nodemailer';
const Imap = require('imap');

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
}

export class EmailService {
  /**
   * Obtiene emails desde un servidor IMAP
   * @param emailConfig Configuración del servidor de email
   * @param limit Número máximo de emails a obtener
   * @param sinceDate Fecha ISO string desde la cual obtener emails
   */
  static async fetchEmails(
    emailConfig: EmailConfig, 
    limit: number = 10,
    sinceDate?: string
  ): Promise<EmailMessage[]> {
    return new Promise((resolve, reject) => {
      try {
        // Parse ports to ensure they are numbers
        let imapPort = emailConfig.imapPort || 993;
        if (typeof imapPort === 'string') {
          imapPort = parseInt(imapPort, 10);
        }
        
        // Create IMAP connection configuration
        const imapConfig = {
          user: emailConfig.user || emailConfig.email,
          password: emailConfig.password,
          host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
          port: imapPort,
          tls: emailConfig.tls !== false,
          tlsOptions: { rejectUnauthorized: false }
        };
        
        const imap = new Imap(imapConfig);
        const emails: EmailMessage[] = [];
        
        imap.once('ready', () => {
          imap.openBox('INBOX', false, (err: any, box: any) => {
            if (err) {
              imap.end();
              return reject(new Error(`Error opening inbox: ${err.message}`));
            }

            // Crear criterios de búsqueda si hay fecha
            const searchCriteria = sinceDate 
              ? [['SINCE', new Date(sinceDate)]]
              : [['ALL']];

            imap.search(searchCriteria, (searchErr: any, results: number[]) => {
              if (searchErr) {
                imap.end();
                return reject(new Error(`Search error: ${searchErr.message}`));
              }

              if (results.length === 0) {
                imap.end();
                return resolve([]);
              }

              // Ordenar resultados de más reciente a más antiguo y limitar
              results.sort((a, b) => b - a);
              const messagesToFetch = results.slice(0, limit);
              
              const f = imap.fetch(messagesToFetch, {
                bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
                struct: true
              });
            
              f.on('message', (msg: any, seqno: number) => {
                const email: EmailMessage = {
                  id: `${seqno}`,
                  headers: null,
                  body: null
                };
                
                msg.on('body', (stream: any, info: any) => {
                  let buffer = '';
                  
                  stream.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString('utf8');
                  });
                  
                  stream.once('end', () => {
                    if (info.which.includes('HEADER')) {
                      const headerLines = buffer.split('\r\n');
                      const headers: any = {};
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
                      
                      email.subject = headers.subject || 'No Subject';
                      email.from = headers.from || 'Unknown';
                      email.to = headers.to || 'Unknown';
                      email.date = headers.date || new Date().toISOString();
                    } else {
                      email.body = buffer;
                    }
                  });
                });
                
                msg.once('end', () => {
                  emails.push(email);
                });
              });
              
              f.once('error', (err: any) => {
                imap.end();
                reject(new Error(`Fetch error: ${err.message}`));
              });
              
              f.once('end', () => {
                imap.end();
              });
            });
          });
        });
        
        imap.once('error', (err: any) => {
          reject(new Error(`IMAP connection error: ${err.message}`));
        });
        
        imap.once('end', () => {
          resolve(emails);
        });
        
        imap.connect();
      } catch (error) {
        reject(error);
      }
    });
  }
} 