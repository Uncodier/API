import { createClient } from '@supabase/supabase-js';
import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { MailboxDetectorService, MailboxInfo } from './MailboxDetectorService';
import * as quotedPrintable from 'quoted-printable';

export interface EmailMessage {
  id: string;
  messageId?: string; // Message-ID header del email para correlación
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  receivedAt?: string; // INTERNALDATE del servidor (fecha de llegada)
  replyTo?: string; // Reply-To extraído del ENVELOPE
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
   * Cierra de forma segura la conexión IMAP usando un timeout para evitar cuelgues.
   * Envía el comando LOGOUT para liberar la conexión en el servidor y prevenir
   * el error "Too many simultaneous connections".
   */
  private static async safeLogout(client: ImapFlow | undefined, contextName: string = ''): Promise<void> {
    if (!client) return;
    
    try {
      // 1. Intentar hacer un logout ordenado con timeout corto
      const logoutPromise = client.logout();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Logout timeout')), 2500);
      });
      
      await Promise.race([logoutPromise, timeoutPromise]);
      if (contextName) console.log(`[EmailService] 👋 Desconectado ordenadamente del servidor IMAP (${contextName})`);
    } catch (e) {
      if (contextName) console.warn(`[EmailService] ⚠️ Error/timeout durante logout IMAP (${contextName}), forzando cierre...`);
      // 2. Si falla o da timeout, forzar cierre del socket
      try {
        if (typeof (client as any).close === 'function') {
          (client as any).close();
        } else if (typeof (client as any).destroy === 'function') {
          (client as any).destroy();
        }
      } catch (closeError) {
        // Ignorar
      }
    }
  }

  /**
   * Lista todas las carpetas disponibles del servidor IMAP y las normaliza.
   */
  static async listAllMailboxes(emailConfig: EmailConfig): Promise<MailboxInfo[]> {
    let client: ImapFlow | undefined;
    try {
      if (!emailConfig.password && !emailConfig.accessToken) {
        throw new Error('No se proporcionó contraseña ni token de acceso OAuth2');
      }
      if (!emailConfig.user && !emailConfig.email) {
        throw new Error('No se proporcionó usuario o email');
      }

      let imapPort = emailConfig.imapPort || 993;
      if (typeof imapPort === 'string') imapPort = parseInt(imapPort, 10);

      const imapConfig: any = {
        host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
        port: imapPort,
        secure: emailConfig.tls !== false,
        logger: false,
        tls: { rejectUnauthorized: false },
        auth: emailConfig.useOAuth && emailConfig.accessToken
          ? { user: emailConfig.user || emailConfig.email, accessToken: emailConfig.accessToken }
          : { user: emailConfig.user || emailConfig.email, pass: emailConfig.password }
      };

      client = new ImapFlow(imapConfig);
      await client.connect();
      const list = await client.list();
      const normalized = MailboxDetectorService.normalizeMailboxInfo(list);
      console.log(`[EmailService] 📚 Mailboxes (${normalized.length}):`, normalized.map(m => ({ name: m.name, path: m.path, specialUse: m.specialUse, attributes: m.attributes })));
      return normalized;
    } catch (e) {
      console.warn(`[EmailService] ⚠️ No se pudo listar mailboxes:`, e);
      return [];
    } finally {
      await EmailService.safeLogout(client, 'listAllMailboxes');
    }
  }
  /**
   * Decodifica el contenido del email si está encoded
   */
  private static decodeEmailContent(content: string): string {
    if (!content) return content;
    
    try {
      // Detectar si está en Quoted-Printable (contiene =XX o =\r\n)
      if (content.includes('=') && (content.match(/=[0-9A-F]{2}/gi) || content.includes('=\r\n') || content.includes('=\n'))) {
        const decoded = quotedPrintable.decode(content);
        return decoded;
      }
      
      // Si no parece ser Quoted-Printable, devolver como está
      return content;
    } catch (decodeError) {
      console.warn(`[EmailService] ⚠️ Error decodificando contenido:`, decodeError);
      return content; // Devolver original si falla la decodificación
    }
  }

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


      // Validar configuración básica
      if (!emailConfig.password && !emailConfig.accessToken) {
        throw new Error('No se proporcionó contraseña ni token de acceso OAuth2');
      }

      if (!emailConfig.user && !emailConfig.email) {
        throw new Error('No se proporcionó usuario o email');
      }

      // Parse ports to ensure they are numbers
      let imapPort = emailConfig.imapPort || 993;
      if (typeof imapPort === 'string') {
        imapPort = parseInt(imapPort, 10);
      }

      if (isNaN(imapPort) || imapPort <= 0) {
        throw new Error(`Puerto IMAP inválido: ${imapPort}`);
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
      
      // Connect to the server with timeout
      const connectionPromise = client.connect();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout de conexión IMAP (30s)')), 30000);
      });

      await Promise.race([connectionPromise, timeoutPromise]);

      
      // Open INBOX with error handling
      console.log(`[EmailService] 📂 Abriendo bandeja de entrada...`);
      const lock = await client.getMailboxLock('INBOX');
      
      try {
        // Obtener información de la bandeja
        const mailboxInfo = await client.mailboxOpen('INBOX');


        const emails: EmailMessage[] = [];
        
        // Create search criteria
        let searchQuery: any = {};
        if (sinceDate) {
          try {
            const sinceDateTime = new Date(sinceDate);
            if (isNaN(sinceDateTime.getTime())) {
              throw new Error(`Fecha inválida: ${sinceDate}`);
            }
            searchQuery.since = sinceDateTime;

          } catch (dateError) {
            console.warn(`[EmailService] ⚠️ Fecha inválida, ignorando filtro: ${sinceDate}`);
          }
        }

        // Si no hay criterios de búsqueda, buscar todos
        if (Object.keys(searchQuery).length === 0) {
          searchQuery = { all: true };
        }


        
        // Search for emails and fetch ONLY the newest up to the requested limit
        const messages = [];
        try {
          // First, search to get UIDs
          const searchResults = await client.search(searchQuery);
          
          // Order by UID descending (usually correlates with newest first)
          const sortedUIDs = searchResults.sort((a, b) => b - a);
          
          // Take only the newest emails up to the limit
          const limitedUIDs = sortedUIDs.slice(0, limit);
          
          // Fetch only the selected UIDs
          if (limitedUIDs.length > 0) {
            for await (const message of client.fetch(limitedUIDs, {
              envelope: true,
              bodyStructure: true,
              flags: true,
              bodyParts: ['TEXT']
            })) {
              messages.push(message);
            }
          }
          
          // Ensure messages are ordered by INTERNALDATE (arrival) descending
          messages.sort((a: any, b: any) => {
            const aTime = (a.internalDate?.getTime?.() || a.envelope?.date?.getTime?.() || 0) as number;
            const bTime = (b.internalDate?.getTime?.() || b.envelope?.date?.getTime?.() || 0) as number;
            return bTime - aTime;
          });
        } catch (fetchError) {
          console.error(`[EmailService] ❌ Error durante fetch de emails:`, fetchError);
          throw new Error(`Error al buscar emails: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
        }
        
        // Process messages
        for (const message of messages) {
          try {
            const email: EmailMessage = {
              id: message.uid.toString(),
              messageId: (message.envelope?.messageId ? String(message.envelope.messageId) : undefined),
              subject: message.envelope?.subject || 'No Subject',
              from: message.envelope?.from?.[0]?.address || 'Unknown',
              to: message.envelope?.to?.[0]?.address || 'Unknown',
              date: message.envelope?.date?.toISOString() || new Date().toISOString(),
              receivedAt: (message.internalDate instanceof Date ? message.internalDate : undefined)?.toISOString(),
              replyTo: message.envelope?.replyTo?.[0]?.address || undefined,
              body: null,
              headers: null
            };
            
            // Multiple strategies to get email body content
            let bodyContent: string | null = null;
            
            // Strategy 1: Try different bodyParts keys
            // PRIORITY: Always prefer text/plain over text/html (cleaner for AI)
            if (message.bodyParts) {

              
              // Try common bodyParts keys - using valid IMAP part specifiers
              // TEXT and text/plain should come before any HTML variants
              const bodyPartsToTry = ['TEXT', '1', '1.1', 'text/plain', 'text'];
              
              for (const partKey of bodyPartsToTry) {
                try {
                  const part = message.bodyParts.get(partKey);
                  if (part) {
                    bodyContent = part.toString('utf8');
                    // OPTIMIZACIÓN: Truncar during bodyParts extraction
                    const MAX_EMAIL_CONTENT_LENGTH = 25000; // 25KB máximo
                    if (bodyContent.length > MAX_EMAIL_CONTENT_LENGTH) {

                      bodyContent = bodyContent.substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                    }

                    break;
                  }
                } catch (partError) {

                }
              }
              
              // If no specific part worked, try to get text/plain parts before HTML
              if (!bodyContent) {

                const bodyPartsArray = Array.from((message.bodyParts as Map<string, any>).entries());
                
                // First pass: Look for text/plain parts explicitly
                for (const [key, part] of bodyPartsArray as Array<[string, any]>) {
                  try {
                    const keyLower = key.toLowerCase();
                    if (!keyLower.includes('header') && !keyLower.includes('html')) {
                      const content = part.toString('utf8');
                      if (content.length > 10) {
                        // OPTIMIZACIÓN: Truncar durante iteración de partes
                        const MAX_EMAIL_CONTENT_LENGTH = 25000; // 25KB máximo
                        let processedContent = content;
                        if (content.length > MAX_EMAIL_CONTENT_LENGTH) {

                          processedContent = content.substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                        }
                        bodyContent = processedContent;

                        break;
                      }
                    }
                  } catch (partError) {

                  }
                }
                
                // Second pass: If still no content, accept HTML parts as fallback
                if (!bodyContent) {
                  for (const [key, part] of bodyPartsArray as Array<[string, any]>) {
                    try {
                      const keyLower = key.toLowerCase();
                      if (!keyLower.includes('header')) {
                        const content = part.toString('utf8');
                        if (content.length > 10) {
                          const MAX_EMAIL_CONTENT_LENGTH = 25000;
                          let processedContent = content;
                          if (content.length > MAX_EMAIL_CONTENT_LENGTH) {
                            processedContent = content.substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                          }
                          bodyContent = processedContent;
                          break;
                        }
                      }
                    } catch (partError) {

                    }
                  }
                }
              }
            }
            
            // Strategy 2: Try to get full message source and parse it
            if (!bodyContent && message.source) {
              try {

                const sourceContent = message.source.toString('utf8');

                
                // Try to find content after headers (simple approach)
                const headerEndIndex = sourceContent.indexOf('\n\n');
                if (headerEndIndex !== -1) {
                  bodyContent = sourceContent.substring(headerEndIndex + 2).trim();
                  // OPTIMIZACIÓN: Truncar también el contenido extraído del source
                  const MAX_EMAIL_CONTENT_LENGTH = 25000; // 25KB máximo
                  if (bodyContent.length > MAX_EMAIL_CONTENT_LENGTH) {

                    bodyContent = bodyContent.substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                  }

                }
              } catch (sourceError) {

              }
            }
            
            if (bodyContent) {
              // OPTIMIZACIÓN: Truncar emails muy largos durante la descarga para evitar timeouts
              const MAX_EMAIL_CONTENT_LENGTH = 25000; // 25KB máximo por email
              if (bodyContent.length > MAX_EMAIL_CONTENT_LENGTH) {

                bodyContent = bodyContent.substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
              }
              email.body = this.decodeEmailContent(bodyContent);

            } else {

              email.body = null;
            }
            
            // Headers no son necesarios - el sistema de envelope ID maneja la deduplicación
            email.headers = null;
            
            emails.push(email);
          } catch (messageError) {
            console.error(`[EmailService] ❌ Error procesando mensaje:`, messageError);
            // Continuar con el siguiente mensaje
          }
        }
        

        return emails;
        
      } finally {
        // Always release the lock
        try {
          lock.release();

        } catch (lockError) {
          console.warn(`[EmailService] ⚠️ Error liberando lock:`, lockError);
        }
      }
      
    } catch (error) {
      console.error(`[EmailService] 💥 Error crítico en fetchEmails:`, error);
      console.error(`[EmailService] 📋 Stack trace:`, error instanceof Error ? error.stack : 'No stack trace');
      
      // Provide more specific error messages
      let errorMessage = error instanceof Error ? error.message : String(error);

      // Extract additional fields from ImapFlow error to better classify auth errors
      const lowerMessage = (errorMessage || '').toLowerCase();
      const responseText = typeof (error as any)?.responseText === 'string' ? ((error as any).responseText as string).toLowerCase() : '';
      const response = typeof (error as any)?.response === 'string' ? ((error as any).response as string).toLowerCase() : '';
      const serverCode = typeof (error as any)?.serverResponseCode === 'string' ? ((error as any).serverResponseCode as string).toLowerCase() : '';
      const executedCommand = typeof (error as any)?.executedCommand === 'string' ? ((error as any).executedCommand as string).toLowerCase() : '';
      const authenticationFailed = Boolean((error as any)?.authenticationFailed);

      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        errorMessage = `No se pudo conectar al servidor IMAP: ${emailConfig.imapHost || emailConfig.host || 'imap.gmail.com'}. Verifica la configuración del host.`;
      } else if (errorMessage.includes('ECONNREFUSED')) {
        errorMessage = `Conexión rechazada por el servidor IMAP en puerto ${emailConfig.imapPort || 993}. Verifica el puerto y las configuraciones de firewall.`;
      } else if (
        authenticationFailed ||
        lowerMessage.includes('authentication') ||
        lowerMessage.includes('credentials') ||
        lowerMessage.includes('login') ||
        responseText.includes('authentication') ||
        responseText.includes('invalid credentials') ||
        response.includes('invalid credentials') ||
        serverCode.includes('authenticationfailed') ||
        executedCommand.includes('authenticate')
      ) {
        // Use English keyword "Authentication" to allow downstream classifiers to catch it
        errorMessage = `Authentication failed: invalid credentials or IMAP access problem.`;
      } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
        errorMessage = `Timeout de conexión al servidor IMAP. El servidor puede estar lento o no responder.`;
      } else if (errorMessage.includes('TLS') || errorMessage.includes('SSL')) {
        errorMessage = `Error de certificado TLS/SSL al conectar con el servidor IMAP.`;
      }
      
      throw new Error(`Email fetch error: ${errorMessage}`);
    } finally {
      await EmailService.safeLogout(client, 'fetchEmails');
    }
  }

  /**
   * Obtiene emails dentro de un rango de fechas [sinceDate, beforeDate)
   * Nota: Usa 'since' y 'before' del SEARCH IMAP. Limita cantidad máxima por seguridad.
   */
  static async fetchEmailsInRange(
    emailConfig: EmailConfig,
    sinceDateISO: string,
    beforeDateISO: string,
    maxFetch: number = 500
  ): Promise<EmailMessage[]> {
    // Reutilizar lógica de fetchEmails con pequeñas variaciones de búsqueda
    let client: ImapFlow | undefined;
    try {
      // Validación básica
      if (!emailConfig.password && !emailConfig.accessToken) {
        throw new Error('No se proporcionó contraseña ni token de acceso OAuth2');
      }
      if (!emailConfig.user && !emailConfig.email) {
        throw new Error('No se proporcionó usuario o email');
      }

      let imapPort = emailConfig.imapPort || 993;
      if (typeof imapPort === 'string') imapPort = parseInt(imapPort, 10);
      if (isNaN(imapPort) || imapPort <= 0) {
        throw new Error(`Puerto IMAP inválido: ${imapPort}`);
      }

      const imapConfig: any = {
        host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
        port: imapPort,
        secure: emailConfig.tls !== false,
        logger: false,
        tls: { rejectUnauthorized: false }
      };

      if (emailConfig.useOAuth && emailConfig.accessToken) {
        imapConfig.auth = { user: emailConfig.user || emailConfig.email, accessToken: emailConfig.accessToken };
      } else {
        imapConfig.auth = { user: emailConfig.user || emailConfig.email, pass: emailConfig.password };
      }

      client = new ImapFlow(imapConfig);
      const connectionPromise = client.connect();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout de conexión IMAP (30s)')), 30000));
      await Promise.race([connectionPromise, timeoutPromise]);

      console.log(`[EmailService] 📂 Abriendo bandeja de entrada...`);
      const lock = await client.getMailboxLock('INBOX');
      try {
        await client.mailboxOpen('INBOX');

        const emails: EmailMessage[] = [];
        // Construir query de rango
        const searchQuery: any = {};
        try {
          const since = new Date(sinceDateISO);
          const before = new Date(beforeDateISO);
          if (isNaN(since.getTime()) || isNaN(before.getTime())) {
            throw new Error('Fechas inválidas para rango');
          }
          searchQuery.since = since;
          searchQuery.before = before; // Exclusivo: antes de 'before'
        } catch (e) {
          throw new Error(`Fechas inválidas para búsqueda en rango: ${sinceDateISO} - ${beforeDateISO}`);
        }

        const messages: any[] = [];
        try {
          const searchResults = await client.search(searchQuery);
          // Ordenar más nuevos primero
          const sortedUIDs = searchResults.sort((a, b) => b - a);
          // Limitar por seguridad la cantidad máxima a traer
          const limitedUIDs = sortedUIDs.slice(0, Math.max(0, maxFetch));
          if (limitedUIDs.length > 0) {
            for await (const message of client.fetch(limitedUIDs, {
              envelope: true,
              bodyStructure: true,
              flags: true,
              bodyParts: ['TEXT']
            })) {
              messages.push(message);
            }
          }

          // Orden estable por INTERNALDATE (arrival) desc
          messages.sort((a: any, b: any) => {
            const aTime = (a.internalDate?.getTime?.() || a.envelope?.date?.getTime?.() || 0) as number;
            const bTime = (b.internalDate?.getTime?.() || b.envelope?.date?.getTime?.() || 0) as number;
            return bTime - aTime;
          });
        } catch (fetchError) {
          console.error(`[EmailService] ❌ Error durante fetch de emails en rango:`, fetchError);
          throw new Error(`Error al buscar emails en rango: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
        }

        // Procesar mensajes (reutilizar lógica del método principal)
        for (const message of messages) {
          try {
            const email: EmailMessage = {
              id: message.uid.toString(),
              messageId: (message.envelope?.messageId ? String(message.envelope.messageId) : undefined),
              subject: message.envelope?.subject || 'No Subject',
              from: message.envelope?.from?.[0]?.address || 'Unknown',
              to: message.envelope?.to?.[0]?.address || 'Unknown',
              date: message.envelope?.date?.toISOString() || new Date().toISOString(),
              receivedAt: (message.internalDate instanceof Date ? message.internalDate : undefined)?.toISOString(),
              replyTo: message.envelope?.replyTo?.[0]?.address || undefined,
              body: null,
              headers: null
            };

            let bodyContent: string | null = null;
            if (message.bodyParts) {
              const bodyPartsToTry = ['TEXT', '1', '1.1', '1.2', 'text/plain', 'text'];
              for (const partKey of bodyPartsToTry) {
                try {
                  const part = message.bodyParts.get(partKey);
                  if (part) {
                    bodyContent = part.toString('utf8');
                    const MAX_EMAIL_CONTENT_LENGTH = 25000;
                    if ((bodyContent || '').length > MAX_EMAIL_CONTENT_LENGTH) {
                      bodyContent = (bodyContent || '').substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                    }
                    break;
                  }
                } catch {}
              }
              // PRIORITY: Try to get text/plain parts before HTML
              if (!bodyContent) {
                const bodyPartsArray: any[] = Array.from((message.bodyParts as any).entries());
                
                // First pass: Look for text/plain parts explicitly (avoid HTML)
                for (const entry of bodyPartsArray) {
                  const key = String(entry[0]);
                  const part = entry[1];
                  try {
                    const keyLower = key.toLowerCase();
                    if (!keyLower.includes('header') && !keyLower.includes('html')) {
                      const content = part.toString('utf8');
                      if (content.length > 10) {
                        const MAX_EMAIL_CONTENT_LENGTH = 25000;
                        let processedContent = content;
                        if ((content || '').length > MAX_EMAIL_CONTENT_LENGTH) {
                          processedContent = (content || '').substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                        }
                        bodyContent = processedContent;
                        break;
                      }
                    }
                  } catch {}
                }
                
                // Second pass: If still no content, accept HTML parts as fallback
                if (!bodyContent) {
                  for (const entry of bodyPartsArray) {
                    const key = String(entry[0]);
                    const part = entry[1];
                    try {
                      const keyLower = key.toLowerCase();
                      if (!keyLower.includes('header')) {
                        const content = part.toString('utf8');
                        if (content.length > 10) {
                          const MAX_EMAIL_CONTENT_LENGTH = 25000;
                          let processedContent = content;
                          if ((content || '').length > MAX_EMAIL_CONTENT_LENGTH) {
                            processedContent = (content || '').substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                          }
                          bodyContent = processedContent;
                          break;
                        }
                      }
                    } catch {}
                  }
                }
              }
            }

            if (!bodyContent && message.source) {
              try {
                const sourceContent = message.source.toString('utf8');
                const headerEndIndex = sourceContent.indexOf('\n\n');
                if (headerEndIndex !== -1) {
                  bodyContent = sourceContent.substring(headerEndIndex + 2).trim();
                  const MAX_EMAIL_CONTENT_LENGTH = 25000;
                  if ((bodyContent || '').length > MAX_EMAIL_CONTENT_LENGTH) {
                    bodyContent = (bodyContent || '').substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                  }
                }
              } catch {}
            }

            if (bodyContent) {
              const MAX_EMAIL_CONTENT_LENGTH = 25000;
              if ((bodyContent || '').length > MAX_EMAIL_CONTENT_LENGTH) {
                bodyContent = (bodyContent || '').substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
              }
              email.body = this.decodeEmailContent(bodyContent);
            } else {
              email.body = null;
            }

            email.headers = null;
            emails.push(email);
          } catch (messageError) {
            console.error(`[EmailService] ❌ Error procesando mensaje (range):`, messageError);
          }
        }

        return emails;
      } finally {
        try { lock.release(); } catch (lockError) {
          console.warn(`[EmailService] ⚠️ Error liberando lock:`, lockError);
        }
      }
    } catch (error) {
      console.error(`[EmailService] 💥 Error crítico en fetchEmailsInRange:`, error);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      await EmailService.safeLogout(client, 'fetchEmailsInRange');
    }
  }

  /**
   * Obtiene emails dentro de un rango desde una carpeta específica (e.g., "[Gmail]/Important", "[Gmail]/All Mail").
   * Útil para casos donde Gmail etiqueta correos fuera de INBOX.
   */
  static async fetchEmailsInRangeFromMailbox(
    emailConfig: EmailConfig,
    sinceDateISO: string,
    beforeDateISO: string,
    mailboxName: string,
    maxFetch: number = 300
  ): Promise<EmailMessage[]> {
    let client: ImapFlow | undefined;
    try {
      if (!emailConfig.password && !emailConfig.accessToken) {
        throw new Error('No se proporcionó contraseña ni token de acceso OAuth2');
      }
      if (!emailConfig.user && !emailConfig.email) {
        throw new Error('No se proporcionó usuario o email');
      }

      let imapPort = emailConfig.imapPort || 993;
      if (typeof imapPort === 'string') imapPort = parseInt(imapPort, 10);
      if (isNaN(imapPort) || imapPort <= 0) throw new Error(`Puerto IMAP inválido: ${imapPort}`);

      const imapConfig: any = {
        host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
        port: imapPort,
        secure: emailConfig.tls !== false,
        logger: false,
        tls: { rejectUnauthorized: false }
      };

      if (emailConfig.useOAuth && emailConfig.accessToken) {
        imapConfig.auth = { user: emailConfig.user || emailConfig.email, accessToken: emailConfig.accessToken };
      } else {
        imapConfig.auth = { user: emailConfig.user || emailConfig.email, pass: emailConfig.password };
      }

      client = new ImapFlow(imapConfig);
      const connectionPromise = client.connect();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout de conexión IMAP (30s)')), 30000));
      await Promise.race([connectionPromise, timeoutPromise]);

      const lock = await client.getMailboxLock(mailboxName);
      try {
        await client.mailboxOpen(mailboxName);

        const emails: EmailMessage[] = [];
        const searchQuery: any = {};
        try {
          const since = new Date(sinceDateISO);
          const before = new Date(beforeDateISO);
          if (isNaN(since.getTime()) || isNaN(before.getTime())) throw new Error('Fechas inválidas para rango');
          searchQuery.since = since;
          searchQuery.before = before;
        } catch (e) {
          throw new Error(`Fechas inválidas para búsqueda en rango: ${sinceDateISO} - ${beforeDateISO}`);
        }

        const messages: any[] = [];
        try {
          const searchResults = await client.search(searchQuery);
          const sortedUIDs = searchResults.sort((a, b) => b - a);
          const limitedUIDs = sortedUIDs.slice(0, Math.max(0, maxFetch));
          if (limitedUIDs.length > 0) {
            for await (const message of client.fetch(limitedUIDs, {
              envelope: true,
              bodyStructure: true,
              flags: true,
              bodyParts: ['TEXT']
            })) {
              messages.push(message);
            }
          }
          messages.sort((a: any, b: any) => {
            const aTime = (a.internalDate?.getTime?.() || a.envelope?.date?.getTime?.() || 0) as number;
            const bTime = (b.internalDate?.getTime?.() || b.envelope?.date?.getTime?.() || 0) as number;
            return bTime - aTime;
          });
        } catch (fetchError) {
          console.error(`[EmailService] ❌ Error durante fetch de emails en rango (${mailboxName}):`, fetchError);
          throw new Error(`Error al buscar emails en rango (${mailboxName}): ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
        }

        let excludedBySentFlag = 0;
        for (const message of messages) {
          try {
            // Excluir mensajes con flag \Sent (p. ej., en [Gmail]/All Mail o Important)
            const rawFlags = (message.flags ? (Array.isArray(message.flags) ? message.flags : Array.from(message.flags)) : []) as string[];
            const hasSentFlag = rawFlags.some(f => String(f).toLowerCase().includes('\\sent') || String(f).toLowerCase() === 'sent');
            if (hasSentFlag) {
              excludedBySentFlag++;
              continue;
            }

            const email: EmailMessage = {
              id: message.uid.toString(),
              messageId: (message.envelope?.messageId ? String(message.envelope.messageId) : undefined),
              subject: message.envelope?.subject || 'No Subject',
              from: message.envelope?.from?.[0]?.address || 'Unknown',
              to: message.envelope?.to?.[0]?.address || 'Unknown',
              date: message.envelope?.date?.toISOString() || new Date().toISOString(),
              receivedAt: (message.internalDate instanceof Date ? message.internalDate : undefined)?.toISOString(),
              replyTo: message.envelope?.replyTo?.[0]?.address || undefined,
              body: null,
              headers: null
            };

            let bodyContent: string | null = null;
            if (message.bodyParts) {
              const bodyPartsToTry = ['TEXT', '1', '1.1', '1.2', 'text/plain', 'text'];
              for (const partKey of bodyPartsToTry) {
                try {
                  const part = message.bodyParts.get(partKey);
                  if (part) {
                    bodyContent = part.toString('utf8');
                    const MAX_EMAIL_CONTENT_LENGTH = 25000;
                    if ((bodyContent || '').length > MAX_EMAIL_CONTENT_LENGTH) {
                      bodyContent = (bodyContent || '').substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                    }
                    break;
                  }
                } catch {}
              }
              
              // PRIORITY: Try to get text/plain parts before HTML if no specific part worked
              if (!bodyContent) {
                const bodyPartsArray: any[] = Array.from(message.bodyParts.entries());
                
                // First pass: Look for text/plain parts explicitly (avoid HTML)
                for (const [key, part] of bodyPartsArray) {
                  try {
                    const keyLower = String(key).toLowerCase();
                    if (!keyLower.includes('header') && !keyLower.includes('html')) {
                      const content = part.toString('utf8');
                      if (content.length > 10) {
                        const MAX_EMAIL_CONTENT_LENGTH = 25000;
                        bodyContent = content;
                        if ((bodyContent || '').length > MAX_EMAIL_CONTENT_LENGTH) {
                          bodyContent = (bodyContent || '').substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                        }
                        break;
                      }
                    }
                  } catch {}
                }
                
                // Second pass: If still no content, accept HTML parts as fallback
                if (!bodyContent) {
                  for (const [key, part] of bodyPartsArray) {
                    try {
                      const keyLower = String(key).toLowerCase();
                      if (!keyLower.includes('header')) {
                        const content = part.toString('utf8');
                        if (content.length > 10) {
                          const MAX_EMAIL_CONTENT_LENGTH = 25000;
                          bodyContent = content;
                          if ((bodyContent || '').length > MAX_EMAIL_CONTENT_LENGTH) {
                            bodyContent = (bodyContent || '').substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                          }
                          break;
                        }
                      }
                    } catch {}
                  }
                }
              }
            }

            if (!bodyContent && message.source) {
              try {
                const sourceContent = message.source.toString('utf8');
                const headerEndIndex = sourceContent.indexOf('\n\n');
                if (headerEndIndex !== -1) {
                  bodyContent = sourceContent.substring(headerEndIndex + 2).trim();
                  const MAX_EMAIL_CONTENT_LENGTH = 25000;
                  if ((bodyContent || '').length > MAX_EMAIL_CONTENT_LENGTH) {
                    bodyContent = (bodyContent || '').substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[... Email truncado durante descarga para optimización ...]';
                  }
                }
              } catch {}
            }

            email.body = bodyContent ? this.decodeEmailContent(bodyContent) : null;
            email.headers = null;
            emails.push(email);
          } catch (messageError) {
            console.error(`[EmailService] ❌ Error procesando mensaje (range:${mailboxName}):`, messageError);
          }
        }

        console.log(`[EmailService] (${mailboxName}) Returned ${emails.length} emails after excluding Sent-flagged messages (excluded=${excludedBySentFlag})`);

        return emails;
      } finally {
        try { lock.release(); } catch {}
      }
    } finally {
      await EmailService.safeLogout(client, 'fetchEmailsInRangeFromMailbox');
    }
  }
  /**
   * Elimina un email del servidor IMAP
   * @param emailConfig Configuración del servidor de email
   * @param emailId ID del email a eliminar (UID)
   * @param isFromSent Si el email está en la carpeta de enviados (true) o en INBOX (false)
   */
  static async deleteEmail(
    emailConfig: EmailConfig,
    emailId: string,
    isFromSent: boolean = false
  ): Promise<boolean> {
    let client: ImapFlow | undefined;
    
    try {


      // Validar configuración básica
      if (!emailConfig.password && !emailConfig.accessToken) {
        throw new Error('No se proporcionó contraseña ni token de acceso OAuth2');
      }

      if (!emailConfig.user && !emailConfig.email) {
        throw new Error('No se proporcionó usuario o email');
      }

      // Parse ports to ensure they are numbers
      let imapPort = emailConfig.imapPort || 993;
      if (typeof imapPort === 'string') {
        imapPort = parseInt(imapPort, 10);
      }

      if (isNaN(imapPort) || imapPort <= 0) {
        throw new Error(`Puerto IMAP inválido: ${imapPort}`);
      }
      
      // Create ImapFlow connection configuration
      const imapConfig: any = {
        host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
        port: imapPort,
        secure: emailConfig.tls !== false,
        logger: false,
        tls: {
          rejectUnauthorized: false
        }
      };

      // Configure authentication
      if (emailConfig.useOAuth && emailConfig.accessToken) {
        console.log(`[EmailService] 🔐 Usando autenticación OAuth2 para eliminación`);
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          accessToken: emailConfig.accessToken
        };
      } else {
        console.log(`[EmailService] 🔐 Usando autenticación con contraseña para eliminación`);
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          pass: emailConfig.password
        };
      }

      console.log(`[EmailService] 📡 Conectando a servidor IMAP para eliminación: ${imapConfig.host}:${imapConfig.port}`);
      
      // Create ImapFlow client
      client = new ImapFlow(imapConfig);
      
      // Connect to the server with timeout
      const connectionPromise = client.connect();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout de conexión IMAP (30s)')), 30000);
      });

      await Promise.race([connectionPromise, timeoutPromise]);
      console.log(`[EmailService] ✅ Conexión IMAP establecida para eliminación`);
      
      let mailboxName = 'INBOX';
      
      // Si es de enviados, necesitamos detectar la carpeta de enviados
      if (isFromSent) {
        try {
          console.log(`[EmailService] 🔍 Detectando carpeta de enviados...`);
          const mailboxList = await client.list();
          const normalizedMailboxes: MailboxInfo[] = MailboxDetectorService.normalizeMailboxInfo(mailboxList);
          
          const detectionResult = MailboxDetectorService.detectSentFolder(
            normalizedMailboxes,
            imapConfig.host,
            imapConfig.auth?.user || emailConfig.user || emailConfig.email
          );
          
          if (detectionResult.found && detectionResult.folderName) {
            mailboxName = detectionResult.folderName;
            console.log(`[EmailService] ✅ Carpeta de enviados detectada para eliminación: "${mailboxName}"`);
          } else {
            console.warn(`[EmailService] ⚠️ No se pudo detectar carpeta de enviados, usando INBOX`);
          }
        } catch (listError) {
          console.warn(`[EmailService] ⚠️ Error detectando carpeta de enviados:`, listError);
        }
      }
      
      // Open mailbox with write permissions
      console.log(`[EmailService] 📂 Abriendo ${mailboxName} para eliminación...`);
      const lock = await client.getMailboxLock(mailboxName);
      
      try {
        await client.mailboxOpen(mailboxName);
        
        // Convert string ID to number if needed
        const uid = parseInt(emailId, 10);
        if (isNaN(uid)) {
          throw new Error(`ID de email inválido: ${emailId}`);
        }
        
        console.log(`[EmailService] 🔍 Verificando existencia del email UID: ${uid}...`);
        
                 // First, check if the email exists
         const messages = [];
         try {
           for await (const message of client.fetch(uid.toString(), { uid: true, envelope: true })) {
             messages.push(message);
           }
         } catch (fetchError) {
           console.error(`[EmailService] ❌ Error verificando email UID ${uid}:`, fetchError);
           throw new Error(`No se pudo verificar el email con UID ${uid}`);
         }
        
        if (messages.length === 0) {
          console.warn(`[EmailService] ⚠️ Email con UID ${uid} no encontrado en ${mailboxName}`);
          return false;
        }
        
        console.log(`[EmailService] ✅ Email UID ${uid} encontrado, procediendo con eliminación...`);
        
                 // Mark email as deleted using the \Deleted flag
         try {
           await client.messageFlagsAdd(uid.toString(), ['\\Deleted'], { uid: true });
           console.log(`[EmailService] 🏷️ Email UID ${uid} marcado para eliminación`);
         } catch (flagError) {
           console.error(`[EmailService] ❌ Error marcando email para eliminación:`, flagError);
           throw new Error(`No se pudo marcar el email UID ${uid} para eliminación`);
         }
        
        // Expunge to permanently delete marked emails
        try {
          await client.mailboxClose();
          console.log(`[EmailService] 🗑️ Email UID ${uid} eliminado permanentemente de ${mailboxName}`);
          return true;
        } catch (expungeError) {
          console.error(`[EmailService] ❌ Error expunging emails:`, expungeError);
          throw new Error(`Email marcado para eliminación pero no se pudo confirmar la eliminación permanente`);
        }
        
      } finally {
        // Always release the lock
        try {
          lock.release();
          console.log(`[EmailService] 🔓 Lock de ${mailboxName} liberado`);
        } catch (lockError) {
          console.warn(`[EmailService] ⚠️ Error liberando lock de ${mailboxName}:`, lockError);
        }
      }
      
    } catch (error) {
      console.error(`[EmailService] 💥 Error crítico en deleteEmail:`, error);
      
      // Provide more specific error messages
      let errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        errorMessage = `No se pudo conectar al servidor IMAP: ${emailConfig.imapHost || emailConfig.host || 'imap.gmail.com'}`;
      } else if (errorMessage.includes('ECONNREFUSED')) {
        errorMessage = `Conexión rechazada por el servidor IMAP en puerto ${emailConfig.imapPort || 993}`;
      } else if (errorMessage.includes('authentication') || errorMessage.includes('login')) {
        errorMessage = `Error de autenticación: credenciales inválidas`;
      } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
        errorMessage = `Timeout de conexión al servidor IMAP`;
      }
      
      throw new Error(`Email delete error: ${errorMessage}`);
    } finally {
      await EmailService.safeLogout(client, 'deleteEmail');
    }
  }

  /**
   * Elimina bounces específicos por UID en la misma conexión
   */
  static async deleteSpecificBounces(
    emailConfig: EmailConfig,
    uids: string[]
  ): Promise<{ success: number; failed: number; results: Array<{ uid: string; success: boolean; error?: string }> }> {
    let client: ImapFlow | undefined;
    const results: Array<{ uid: string; success: boolean; error?: string }> = [];
    let successCount = 0;
    let failedCount = 0;

    try {
      console.log(`[EmailService] 🔍 Eliminando ${uids.length} bounces específicos por UID...`);
      
      // Configurar conexión IMAP
      const imapPort = parseInt(String(emailConfig.imapPort || emailConfig.port || '993'));
      const imapConfig: any = {
        host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
        port: imapPort,
        secure: emailConfig.tls !== false,
        logger: false,
        tls: {
          rejectUnauthorized: false
        }
      };

      // Configurar autenticación
      if (emailConfig.useOAuth && emailConfig.accessToken) {
        imapConfig.auth = {
          user: emailConfig.email,
          accessToken: emailConfig.accessToken
        };
      } else {
        imapConfig.auth = {
          user: emailConfig.email,
          pass: emailConfig.password
        };
      }

      // Crear conexión IMAP
      client = new ImapFlow(imapConfig);

      await client.connect();
      console.log(`[EmailService] ✅ Conexión IMAP establecida para eliminación específica`);

      // Abrir bandeja de entrada
      await client.mailboxOpen('INBOX');

      // Eliminar cada UID específico
      for (const uid of uids) {
        try {
          // Buscar el email por UID
          const searchResult = await client.search({ uid: uid });
          
          if (searchResult.length > 0) {
            // Marcar como eliminado y expunge inmediatamente
            await client.messageFlagsAdd(searchResult, ['\\Deleted']);
            
            // Usar mailboxClose con expunge para eliminar definitivamente
            await client.mailboxClose();
            await client.mailboxOpen('INBOX'); // Reabrir para la siguiente iteración
            
            console.log(`[EmailService] ✅ Bounce ${uid} eliminado exitosamente`);
            results.push({ uid, success: true });
            successCount++;
          } else {
            console.log(`[EmailService] ⚠️ Bounce ${uid} no encontrado`);
            results.push({ uid, success: false, error: 'UID no encontrado' });
            failedCount++;
          }
        } catch (uidError) {
          console.log(`[EmailService] ❌ Error eliminando bounce ${uid}:`, uidError);
          results.push({ uid, success: false, error: uidError instanceof Error ? uidError.message : String(uidError) });
          failedCount++;
        }
      }

      console.log(`[EmailService] ✅ Eliminación específica completada: ${successCount} exitosos, ${failedCount} fallidos`);
      
      return { success: successCount, failed: failedCount, results };

    } catch (error) {
      console.error(`[EmailService] ❌ Error en eliminación específica:`, error);
      return { success: 0, failed: uids.length, results: uids.map(uid => ({ uid, success: false, error: error instanceof Error ? error.message : String(error) })) };
    } finally {
      await EmailService.safeLogout(client, 'deleteSpecificBounces');
    }
  }

  /**
   * Elimina bounces usando criterios de búsqueda IMAP (más confiable que UIDs)
   */
  static async deleteBouncesBySearch(
    emailConfig: EmailConfig
  ): Promise<{ success: number; failed: number; results: Array<{ criteria: string; success: boolean; error?: string }> }> {
    let client: ImapFlow | undefined;
    const results: Array<{ criteria: string; success: boolean; error?: string }> = [];
    let successCount = 0;
    let failedCount = 0;

    try {
      console.log(`[EmailService] 🔍 Eliminando bounces usando criterios de búsqueda...`);

      // Configuración IMAP (copiada del código existente)
      let imapPort = emailConfig.imapPort || 993;
      if (typeof imapPort === 'string') {
        imapPort = parseInt(imapPort, 10);
      }

      const imapConfig: any = {
        host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
        port: imapPort,
        secure: emailConfig.tls !== false,
        logger: false,
        tls: { rejectUnauthorized: false }
      };

      if (emailConfig.useOAuth && emailConfig.accessToken) {
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          accessToken: emailConfig.accessToken
        };
      } else {
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          pass: emailConfig.password
        };
      }

      client = new ImapFlow(imapConfig);
      await client.connect();
      console.log(`[EmailService] ✅ Conexión IMAP establecida para eliminación de bounces`);

      const lock = await client.getMailboxLock('INBOX');
      
      try {
        await client.mailboxOpen('INBOX');

        // Criterios de búsqueda para bounces específicos
        const bounceSearchCriteria = [
          { from: 'mailer-daemon@googlemail.com' },
          { 
            from: 'mailer-daemon',
            since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Últimos 7 días
          }
        ];

        for (const criteria of bounceSearchCriteria) {
          try {
            console.log(`[EmailService] 🔍 Buscando bounces con criterios:`, criteria);
            
            // Buscar emails que coincidan con los criterios
            const searchResults = await client.search(criteria);
            console.log(`[EmailService] 📊 Encontrados ${searchResults.length} bounces con criterios especificados`);

            if (searchResults.length === 0) {
              results.push({
                criteria: JSON.stringify(criteria),
                success: true,
                error: 'No se encontraron emails con estos criterios'
              });
              continue;
            }

            // Marcar todos como eliminados
            try {
              await client.messageFlagsAdd(searchResults, ['\\Deleted'], { uid: true });
              console.log(`[EmailService] 🏷️ ${searchResults.length} bounces marcados para eliminación`);
              
              // Hacer expunge para eliminar permanentemente
              await client.mailboxClose();
              await client.mailboxOpen('INBOX'); // Reabrir para continuar
              
              successCount += searchResults.length;
              results.push({
                criteria: JSON.stringify(criteria),
                success: true,
                error: `${searchResults.length} emails eliminados exitosamente`
              });
              
              console.log(`[EmailService] ✅ ${searchResults.length} bounces eliminados con criterios: ${JSON.stringify(criteria)}`);
              
            } catch (deleteError) {
              console.error(`[EmailService] ❌ Error eliminando bounces:`, deleteError);
              failedCount += searchResults.length;
              results.push({
                criteria: JSON.stringify(criteria),
                success: false,
                error: deleteError instanceof Error ? deleteError.message : String(deleteError)
              });
            }
            
          } catch (searchError) {
            console.error(`[EmailService] ❌ Error buscando con criterios:`, searchError);
            results.push({
              criteria: JSON.stringify(criteria),
              success: false,
              error: searchError instanceof Error ? searchError.message : String(searchError)
            });
          }
        }

      } finally {
        lock.release();
      }

    } catch (error) {
      console.error(`[EmailService] 💥 Error general en eliminación de bounces:`, error);
      results.push({
        criteria: 'general',
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await EmailService.safeLogout(client, 'deleteBouncesBySearch');
    }

    console.log(`[EmailService] ✅ Eliminación de bounces completada: ${successCount} exitosos, ${failedCount} fallidos`);
    return { success: successCount, failed: failedCount, results };
  }

  /**
   * Elimina múltiples emails del servidor IMAP
   * @param emailConfig Configuración del servidor de email
   * @param emailIds Array de IDs de emails a eliminar
   * @param isFromSent Si los emails están en la carpeta de enviados
   */
  static async deleteMultipleEmails(
    emailConfig: EmailConfig,
    emailIds: string[],
    isFromSent: boolean = false
  ): Promise<{ success: number; failed: number; results: Array<{ id: string; success: boolean; error?: string }> }> {
    console.log(`[EmailService] 🗑️ Iniciando eliminación múltiple de ${emailIds.length} emails ${isFromSent ? '(enviados)' : '(recibidos)'}`);
    
    const results: Array<{ id: string; success: boolean; error?: string }> = [];
    let successCount = 0;
    let failedCount = 0;
    
    // Process emails in batches to avoid overwhelming the server
    const batchSize = 10;
    for (let i = 0; i < emailIds.length; i += batchSize) {
      const batch = emailIds.slice(i, i + batchSize);
      console.log(`[EmailService] 📦 Procesando lote ${Math.floor(i / batchSize) + 1}/${Math.ceil(emailIds.length / batchSize)}`);
      
      const batchPromises = batch.map(async (emailId) => {
        try {
          const success = await this.deleteEmail(emailConfig, emailId, isFromSent);
          if (success) {
            successCount++;
            return { id: emailId, success: true };
          } else {
            failedCount++;
            return { id: emailId, success: false, error: 'Email no encontrado' };
          }
        } catch (error) {
          failedCount++;
          return { 
            id: emailId, 
            success: false, 
            error: error instanceof Error ? error.message : String(error)
          };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Small delay between batches to be gentle on the server
      if (i + batchSize < emailIds.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`[EmailService] ✅ Eliminación múltiple completada: ${successCount} exitosos, ${failedCount} fallidos`);
    
    return {
      success: successCount,
      failed: failedCount,
      results
    };
  }

  /**
   * Obtiene emails enviados desde un servidor IMAP usando ImapFlow
   * @param emailConfig Configuración del servidor de email
   * @param limit Número máximo de emails a obtener
   * @param sinceDate Fecha ISO string desde la cual obtener emails
   */
  static async fetchSentEmails(
    emailConfig: EmailConfig, 
    limit: number = 10,
    sinceDate?: string
  ): Promise<EmailMessage[]> {
    let client: ImapFlow | undefined;
    
    try {
      console.log(`[EmailService] 🔧 Iniciando fetch de emails ENVIADOS con configuración:`, {
        host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
        port: emailConfig.imapPort || 993,
        user: emailConfig.user || emailConfig.email,
        useOAuth: emailConfig.useOAuth || false,
        limit,
        sinceDate
      });

      // Validar configuración básica
      if (!emailConfig.password && !emailConfig.accessToken) {
        throw new Error('No se proporcionó contraseña ni token de acceso OAuth2');
      }

      if (!emailConfig.user && !emailConfig.email) {
        throw new Error('No se proporcionó usuario o email');
      }

      // Parse ports to ensure they are numbers
      let imapPort = emailConfig.imapPort || 993;
      if (typeof imapPort === 'string') {
        imapPort = parseInt(imapPort, 10);
      }

      if (isNaN(imapPort) || imapPort <= 0) {
        throw new Error(`Puerto IMAP inválido: ${imapPort}`);
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
        console.log(`[EmailService] 🔐 Usando autenticación OAuth2 para emails enviados`);
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          accessToken: emailConfig.accessToken
        };
      } else {
        // Traditional password authentication
        console.log(`[EmailService] 🔐 Usando autenticación con contraseña para emails enviados`);
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          pass: emailConfig.password
        };
      }

      console.log(`[EmailService] 📡 Conectando a servidor IMAP para emails enviados: ${imapConfig.host}:${imapConfig.port}`);
      
      // Create ImapFlow client
      client = new ImapFlow(imapConfig);
      
      // Connect to the server with timeout
      const connectionPromise = client.connect();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout de conexión IMAP (30s)')), 30000);
      });

      await Promise.race([connectionPromise, timeoutPromise]);
      console.log(`[EmailService] ✅ Conexión IMAP establecida exitosamente para emails enviados`);
      
      // List available mailboxes and use intelligent detection
      console.log(`[EmailService] 🔍 Listando carpetas disponibles para detección inteligente...`);
      let mailboxList;
      try {
        mailboxList = await client.list();
        console.log(`[EmailService] 📋 Carpetas disponibles:`, mailboxList.map(m => m.name));
      } catch (listError) {
        console.error(`[EmailService] ❌ Error al listar carpetas:`, listError);
        throw new Error('No se pudo acceder a las carpetas del servidor de email');
      }
      
      // Convert to MailboxInfo format for intelligent detection
      const normalizedMailboxes: MailboxInfo[] = MailboxDetectorService.normalizeMailboxInfo(mailboxList);
      
      // Use intelligent sent folder detection
      const detectionResult = MailboxDetectorService.detectSentFolder(
        normalizedMailboxes,
        imapConfig.host,
        imapConfig.auth?.user || emailConfig.user || emailConfig.email
      );
      
      if (!detectionResult.found || !detectionResult.folderName) {
        const availableNames = mailboxList.map(m => m.name).join(', ');
        throw new Error(`No se pudo encontrar la carpeta de emails enviados. Carpetas disponibles: ${availableNames}. Métodos intentados: SPECIAL-USE, proveedor específico, mapeo de idiomas, similitud, fallback.`);
      }
      
      const sentMailbox = detectionResult.folderName;
      console.log(`[EmailService] ✅ Carpeta de enviados detectada: "${sentMailbox}" (método: ${detectionResult.method}, confianza: ${detectionResult.confidence})`);
      
      // Open sent mailbox with error handling
      console.log(`[EmailService] 📂 Abriendo carpeta de enviados: ${sentMailbox}...`);
      const lock = await client.getMailboxLock(sentMailbox);
      
      try {
        // Obtener información de la bandeja
        const mailboxInfo = await client.mailboxOpen(sentMailbox);
        console.log(`[EmailService] 📊 Información de carpeta de enviados:`, {
          exists: mailboxInfo.exists,
          uidNext: mailboxInfo.uidNext,
          uidValidity: mailboxInfo.uidValidity
        });

        const emails: EmailMessage[] = [];
        
        // Create search criteria
        let searchQuery: any = {};
        if (sinceDate) {
          try {
            const sinceDateTime = new Date(sinceDate);
            if (isNaN(sinceDateTime.getTime())) {
              throw new Error(`Fecha inválida: ${sinceDate}`);
            }
            searchQuery.since = sinceDateTime;
            console.log(`[EmailService] 📅 Buscando emails enviados desde: ${sinceDateTime.toISOString()}`);
          } catch (dateError) {
            console.warn(`[EmailService] ⚠️ Fecha inválida, ignorando filtro: ${sinceDate}`);
          }
        }

        // Si no hay criterios de búsqueda, buscar todos
        if (Object.keys(searchQuery).length === 0) {
          searchQuery = { all: true };
        }

        console.log(`[EmailService] 🔍 Buscando emails enviados con criterios:`, searchQuery);
        
        // Search for emails with conservative approach to avoid server conflicts
        const messages = [];
        try {
          // First, search to get UIDs
          const searchResults = await client.search(searchQuery);
          console.log(`[EmailService] 🔍 Búsqueda de enviados encontró ${searchResults.length} emails matching criterios`);
          
          // Sort UIDs in descending order to get newest first
          const sortedUIDs = searchResults.sort((a, b) => b - a);
          console.log(`[EmailService] 📊 UIDs enviados ordenados (más recientes primero): ${sortedUIDs.slice(0, 5).join(', ')}${sortedUIDs.length > 5 ? '...' : ''}`);
          
          // Take only the newest emails up to the limit
          const limitedUIDs = sortedUIDs.slice(0, limit);
          console.log(`[EmailService] 🎯 Procesando ${limitedUIDs.length} emails enviados más recientes (límite: ${limit})`);
          
          // Fetch the selected emails
          if (limitedUIDs.length > 0) {
            for await (const message of client.fetch(limitedUIDs, {
              envelope: true,
              bodyStructure: true,
              flags: true,
              // Start with basic fetch, we'll get content separately if needed
              bodyParts: ['TEXT'] // Only request text part for now
            })) {
              messages.push(message);
            }
          }
          
          console.log(`[EmailService] 📨 Encontrados ${messages.length} emails enviados para procesar`);
        } catch (fetchError) {
          console.error(`[EmailService] ❌ Error durante fetch de emails enviados:`, fetchError);
          throw new Error(`Error al buscar emails enviados: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
        }
        
        // Process messages
        for (const message of messages) {
          try {
            const email: EmailMessage = {
              id: message.uid.toString(),
              subject: message.envelope?.subject || 'No Subject',
              from: message.envelope?.from?.[0]?.address || 'Unknown',
              to: message.envelope?.to?.[0]?.address || 'Unknown',
              date: message.envelope?.date?.toISOString() || new Date().toISOString(),
              body: null,
              headers: null
            };
            
            // Simplified approach to get email body content
            let bodyContent: string | null = null;
            
            // Log available structure for diagnosis
            console.log(`[EmailService] 🔍 DIAGNOSTICO - Email enviado ${message.uid} "${email.subject}":`, {
              hasBodyParts: !!message.bodyParts,
              bodyPartsKeys: message.bodyParts ? Array.from(message.bodyParts.keys()) : [],
              hasBodyStructure: !!message.bodyStructure
            });
            
            // Try to get TEXT part first (what we specifically requested)
            if (message.bodyParts) {
              const textPart = message.bodyParts.get('TEXT');
              if (textPart) {
                try {
                  const rawContent = textPart.toString('utf8');
                  bodyContent = this.decodeEmailContent(rawContent);
                  console.log(`[EmailService] ✅ Body content obtenido de TEXT part: ${bodyContent.length} caracteres`);
                } catch (textError) {
                  console.log(`[EmailService] ⚠️ Error procesando TEXT part:`, textError);
                }
              } else {
                console.log(`[EmailService] ⚠️ TEXT part no encontrado en bodyParts`);
                
                // PRIORITY: Try to get text/plain parts before HTML
                const bodyPartsArray = Array.from(message.bodyParts.entries());
                
                // First pass: Look for text/plain parts explicitly (avoid HTML)
                for (const [key, part] of bodyPartsArray) {
                  const keyLower = key.toLowerCase();
                  if (!keyLower.includes('header') && !keyLower.includes('html')) {
                    try {
                      const rawContent = part.toString('utf8');
                      if (rawContent && rawContent.length > 10) {
                        bodyContent = this.decodeEmailContent(rawContent);
                        console.log(`[EmailService] ✅ Body content obtenido de "${key}" part (text): ${bodyContent.length} caracteres`);
                        break;
                      }
                    } catch (partError) {
                      console.log(`[EmailService] ⚠️ Error procesando "${key}" part:`, partError);
                    }
                  }
                }
                
                // Second pass: If still no content, accept HTML parts as fallback
                if (!bodyContent) {
                  for (const [key, part] of bodyPartsArray) {
                    const keyLower = key.toLowerCase();
                    if (!keyLower.includes('header')) {
                      try {
                        const rawContent = part.toString('utf8');
                        if (rawContent && rawContent.length > 10) {
                          bodyContent = this.decodeEmailContent(rawContent);
                          console.log(`[EmailService] ✅ Body content obtenido de "${key}" part (fallback HTML): ${bodyContent.length} caracteres`);
                          break;
                        }
                      } catch (partError) {
                        console.log(`[EmailService] ⚠️ Error procesando "${key}" part:`, partError);
                      }
                    }
                  }
                }
              }
            }
            
            // Set the email body
            if (bodyContent) {
              email.body = bodyContent;
              console.log(`[EmailService] ✅ Email ${email.id} procesado con body de ${bodyContent.length} caracteres`);
            } else {
              email.body = null;
              console.log(`[EmailService] ❌ Email ${email.id} procesado SIN body content - será manejado por fallbacks posteriores`);
            }
            
            // Headers no son necesarios - el sistema de envelope ID maneja la deduplicación
            email.headers = null;
            
            emails.push(email);
          } catch (messageError) {
            console.error(`[EmailService] ❌ Error procesando mensaje enviado:`, messageError);
            // Continuar con el siguiente mensaje
          }
        }
        
        console.log(`[EmailService] ✅ Procesamiento de emails enviados completado: ${emails.length} emails obtenidos`);
        return emails;
        
      } finally {
        // Always release the lock
        try {
          lock.release();
          console.log(`[EmailService] 🔓 Lock de bandeja de enviados liberado`);
        } catch (lockError) {
          console.warn(`[EmailService] ⚠️ Error liberando lock de enviados:`, lockError);
        }
      }
      
    } catch (error: any) {
      console.error(`[EmailService] 💥 Error crítico en fetchSentEmails:`, error);
      console.error(`[EmailService] 📋 Stack trace:`, error instanceof Error ? error.stack : 'No stack trace');
      
      // Provide more specific error messages
      let errorMessage = error instanceof Error ? error.message : String(error);

      // Extract additional fields from ImapFlow error to better classify auth errors
      const lowerMessage = (errorMessage || '').toLowerCase();
      const responseText = typeof (error as any)?.responseText === 'string' ? ((error as any).responseText as string).toLowerCase() : '';
      const response = typeof (error as any)?.response === 'string' ? ((error as any).response as string).toLowerCase() : '';
      const serverCode = typeof (error as any)?.serverResponseCode === 'string' ? ((error as any).serverResponseCode as string).toLowerCase() : '';
      const executedCommand = typeof (error as any)?.executedCommand === 'string' ? ((error as any).executedCommand as string).toLowerCase() : '';
      const authenticationFailed = Boolean((error as any)?.authenticationFailed);

      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        errorMessage = `No se pudo conectar al servidor IMAP: ${emailConfig.imapHost || emailConfig.host || 'imap.gmail.com'}. Verifica la configuración del host.`;
      } else if (errorMessage.includes('ECONNREFUSED')) {
        errorMessage = `Conexión rechazada por el servidor IMAP en puerto ${emailConfig.imapPort || 993}. Verifica el puerto y las configuraciones de firewall.`;
      } else if (
        authenticationFailed ||
        lowerMessage.includes('authentication') ||
        lowerMessage.includes('credentials') ||
        lowerMessage.includes('login') ||
        responseText.includes('authentication') ||
        responseText.includes('invalid credentials') ||
        response.includes('invalid credentials') ||
        serverCode.includes('authenticationfailed') ||
        executedCommand.includes('authenticate')
      ) {
        // Use English keyword "Authentication" to allow downstream classifiers to catch it
        errorMessage = `Authentication failed: invalid credentials or IMAP access problem.`;
      } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
        errorMessage = `Timeout de conexión al servidor IMAP. El servidor puede estar lento o no responder.`;
      } else if (errorMessage.includes('TLS') || errorMessage.includes('SSL')) {
        errorMessage = `Error de certificado TLS/SSL al conectar con el servidor IMAP.`;
      }
      
      throw new Error(`Sent email fetch error: ${errorMessage}`);
    } finally {
      await EmailService.safeLogout(client, 'fetchSentEmails');
    }
  }
} 