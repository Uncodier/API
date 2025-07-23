import { createClient } from '@supabase/supabase-js';
import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { MailboxDetectorService, MailboxInfo } from './MailboxDetectorService';

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
      console.log(`[EmailService] 🔧 Iniciando fetch de emails con configuración:`, {
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
        console.log(`[EmailService] 🔐 Usando autenticación OAuth2`);
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          accessToken: emailConfig.accessToken
        };
      } else {
        // Traditional password authentication
        console.log(`[EmailService] 🔐 Usando autenticación con contraseña`);
        imapConfig.auth = {
          user: emailConfig.user || emailConfig.email,
          pass: emailConfig.password
        };
      }

      console.log(`[EmailService] 📡 Conectando a servidor IMAP: ${imapConfig.host}:${imapConfig.port}`);
      
      // Create ImapFlow client
      client = new ImapFlow(imapConfig);
      
      // Connect to the server with timeout
      const connectionPromise = client.connect();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout de conexión IMAP (30s)')), 30000);
      });

      await Promise.race([connectionPromise, timeoutPromise]);
      console.log(`[EmailService] ✅ Conexión IMAP establecida exitosamente`);
      
      // Open INBOX with error handling
      console.log(`[EmailService] 📂 Abriendo bandeja de entrada...`);
      const lock = await client.getMailboxLock('INBOX');
      
      try {
        // Obtener información de la bandeja
        const mailboxInfo = await client.mailboxOpen('INBOX');
        console.log(`[EmailService] 📊 Información de bandeja:`, {
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
            console.log(`[EmailService] 📅 Buscando emails desde: ${sinceDateTime.toISOString()}`);
          } catch (dateError) {
            console.warn(`[EmailService] ⚠️ Fecha inválida, ignorando filtro: ${sinceDate}`);
          }
        }

        // Si no hay criterios de búsqueda, buscar todos
        if (Object.keys(searchQuery).length === 0) {
          searchQuery = { all: true };
        }

        console.log(`[EmailService] 🔍 Buscando emails con criterios:`, searchQuery);
        
        // Search for emails with better error handling
        const messages = [];
        try {
          for await (const message of client.fetch(searchQuery, {
            envelope: true,
            source: true, // Get full message source
            bodyParts: ['HEADER', 'TEXT', 'BODY[TEXT]', 'BODY[1]', 'BODY[]'], // Try multiple part specifiers
            bodyStructure: true,
            flags: true
          })) {
            messages.push(message);
            
            // Limit results
            if (messages.length >= limit) {
              break;
            }
          }
          
          console.log(`[EmailService] 📨 Encontrados ${messages.length} emails para procesar`);
        } catch (fetchError) {
          console.error(`[EmailService] ❌ Error durante fetch de emails:`, fetchError);
          throw new Error(`Error al buscar emails: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
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
            
            // Multiple strategies to get email body content
            let bodyContent: string | null = null;
            
            // Strategy 1: Try different bodyParts keys
            if (message.bodyParts) {
              console.log(`[EmailService] 🔍 DIAGNOSTICO - BodyParts disponibles:`, Array.from(message.bodyParts.keys()));
              
              // Try common bodyParts keys
              const bodyPartsToTry = ['TEXT', 'BODY[TEXT]', 'BODY[1]', '1', 'text/plain', 'text'];
              
              for (const partKey of bodyPartsToTry) {
                try {
                  const part = message.bodyParts.get(partKey);
                  if (part) {
                    bodyContent = part.toString('utf8');
                    console.log(`[EmailService] ✅ DIAGNOSTICO - Body encontrado con clave "${partKey}": ${bodyContent.length} chars`);
                    break;
                  }
                } catch (partError) {
                  console.log(`[EmailService] ⚠️ DIAGNOSTICO - Error con clave "${partKey}":`, partError);
                }
              }
              
              // If no specific part worked, try to get any text part
              if (!bodyContent) {
                console.log(`[EmailService] 🔍 DIAGNOSTICO - Intentando con todas las partes disponibles...`);
                const bodyPartsArray = Array.from(message.bodyParts.entries());
                for (const [key, part] of bodyPartsArray) {
                  try {
                    const content = part.toString('utf8');
                    console.log(`[EmailService] 🔍 DIAGNOSTICO - Parte "${key}": ${content.length} chars, preview: "${content.substring(0, 100)}..."`);
                    
                    // Skip header parts and take first substantial text content
                    if (!key.toLowerCase().includes('header') && content.length > 10) {
                      bodyContent = content;
                      console.log(`[EmailService] ✅ DIAGNOSTICO - Using parte "${key}" como body`);
                      break;
                    }
                  } catch (partError) {
                    console.log(`[EmailService] ⚠️ DIAGNOSTICO - Error procesando parte "${key}":`, partError);
                  }
                }
              }
            }
            
            // Strategy 2: Try to get full message source and parse it
            if (!bodyContent && message.source) {
              try {
                console.log(`[EmailService] 🔍 DIAGNOSTICO - Intentando extraer del source completo...`);
                const sourceContent = message.source.toString('utf8');
                console.log(`[EmailService] 🔍 DIAGNOSTICO - Source length: ${sourceContent.length}`);
                
                // Try to find content after headers (simple approach)
                const headerEndIndex = sourceContent.indexOf('\n\n');
                if (headerEndIndex !== -1) {
                  bodyContent = sourceContent.substring(headerEndIndex + 2).trim();
                  console.log(`[EmailService] ✅ DIAGNOSTICO - Body extraído del source: ${bodyContent.length} chars`);
                }
              } catch (sourceError) {
                console.log(`[EmailService] ⚠️ DIAGNOSTICO - Error procesando source:`, sourceError);
              }
            }
            
            if (bodyContent) {
              email.body = bodyContent;
              console.log(`[EmailService] ✅ Body content obtenido: ${bodyContent.length} caracteres`);
            } else {
              console.log(`[EmailService] ❌ DIAGNOSTICO - No se pudo obtener body content para email ${email.id}`);
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
              console.warn(`[EmailService] ⚠️ Error reading email headers for ID ${email.id}:`, headerError);
              email.headers = null;
            }
            
            emails.push(email);
          } catch (messageError) {
            console.error(`[EmailService] ❌ Error procesando mensaje:`, messageError);
            // Continuar con el siguiente mensaje
          }
        }
        
        console.log(`[EmailService] ✅ Procesamiento completado: ${emails.length} emails obtenidos`);
        return emails;
        
      } finally {
        // Always release the lock
        try {
          lock.release();
          console.log(`[EmailService] 🔓 Lock de bandeja liberado`);
        } catch (lockError) {
          console.warn(`[EmailService] ⚠️ Error liberando lock:`, lockError);
        }
      }
      
    } catch (error) {
      console.error(`[EmailService] 💥 Error crítico en fetchEmails:`, error);
      console.error(`[EmailService] 📋 Stack trace:`, error instanceof Error ? error.stack : 'No stack trace');
      
      // Provide more specific error messages
      let errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        errorMessage = `No se pudo conectar al servidor IMAP: ${emailConfig.imapHost || emailConfig.host || 'imap.gmail.com'}. Verifica la configuración del host.`;
      } else if (errorMessage.includes('ECONNREFUSED')) {
        errorMessage = `Conexión rechazada por el servidor IMAP en puerto ${emailConfig.imapPort || 993}. Verifica el puerto y las configuraciones de firewall.`;
      } else if (errorMessage.includes('authentication') || errorMessage.includes('login') || errorMessage.includes('credentials')) {
        errorMessage = `Error de autenticación: credenciales inválidas o problema con el acceso al servidor IMAP.`;
      } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
        errorMessage = `Timeout de conexión al servidor IMAP. El servidor puede estar lento o no responder.`;
      } else if (errorMessage.includes('TLS') || errorMessage.includes('SSL')) {
        errorMessage = `Error de certificado TLS/SSL al conectar con el servidor IMAP.`;
      }
      
      throw new Error(`Email fetch error: ${errorMessage}`);
    } finally {
      // Clean up connection
      if (client) {
        try {
          await client.logout();
          console.log(`[EmailService] 👋 Desconectado del servidor IMAP`);
        } catch (logoutError) {
          console.warn(`[EmailService] ⚠️ Error durante logout IMAP:`, logoutError);
        }
      }
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
      console.log(`[EmailService] 🗑️ Iniciando eliminación de email ID: ${emailId} ${isFromSent ? '(enviados)' : '(recibidos)'}`);

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
      // Clean up connection
      if (client) {
        try {
          await client.logout();
          console.log(`[EmailService] 👋 Desconectado del servidor IMAP (eliminación)`);
        } catch (logoutError) {
          console.warn(`[EmailService] ⚠️ Error durante logout IMAP (eliminación):`, logoutError);
        }
      }
    }
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
        
        // Search for emails with better error handling
        const messages = [];
        try {
          for await (const message of client.fetch(searchQuery, {
            envelope: true,
            source: true, // Get full message source
            bodyParts: ['HEADER', 'TEXT', 'BODY[TEXT]', 'BODY[1]', 'BODY[]'], // Try multiple part specifiers
            bodyStructure: true,
            flags: true
          })) {
            messages.push(message);
            
            // Limit results
            if (messages.length >= limit) {
              break;
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
            // Log estructura completa del mensaje para diagnóstico
            console.log(`[EmailService] 🔍 DIAGNOSTICO - Estructura completa del mensaje:`, {
              uid: message.uid,
              envelope: {
                subject: message.envelope?.subject,
                from: message.envelope?.from?.[0]?.address,
                to: message.envelope?.to?.[0]?.address,
                date: message.envelope?.date
              },
              bodyParts: message.bodyParts ? 'Present' : 'Absent',
              bodyPartsKeys: message.bodyParts ? Array.from(message.bodyParts.keys()) : [],
              bodyStructure: message.bodyStructure ? 'Present' : 'Absent',
              source: message.source ? 'Present' : 'Absent',
              flags: message.flags,
              allKeys: Object.keys(message)
            });

            const email: EmailMessage = {
              id: message.uid.toString(),
              subject: message.envelope?.subject || 'No Subject',
              from: message.envelope?.from?.[0]?.address || 'Unknown',
              to: message.envelope?.to?.[0]?.address || 'Unknown',
              date: message.envelope?.date?.toISOString() || new Date().toISOString(),
              body: null,
              headers: null
            };
            
            // Multiple strategies to get email body content
            let bodyContent: string | null = null;
            
            // Strategy 1: Try different bodyParts keys
            if (message.bodyParts) {
              console.log(`[EmailService] 🔍 DIAGNOSTICO - BodyParts disponibles:`, Array.from(message.bodyParts.keys()));
              
              // Try common bodyParts keys
              const bodyPartsToTry = ['TEXT', 'BODY[TEXT]', 'BODY[1]', '1', 'text/plain', 'text'];
              
              for (const partKey of bodyPartsToTry) {
                try {
                  const part = message.bodyParts.get(partKey);
                  if (part) {
                    bodyContent = part.toString('utf8');
                    console.log(`[EmailService] ✅ DIAGNOSTICO - Body encontrado con clave "${partKey}": ${bodyContent.length} chars`);
                    break;
                  }
                } catch (partError) {
                  console.log(`[EmailService] ⚠️ DIAGNOSTICO - Error con clave "${partKey}":`, partError);
                }
              }
              
                             // If no specific part worked, try to get any text part
               if (!bodyContent) {
                 console.log(`[EmailService] 🔍 DIAGNOSTICO - Intentando con todas las partes disponibles...`);
                 const bodyPartsArray = Array.from(message.bodyParts.entries());
                 for (const [key, part] of bodyPartsArray) {
                   try {
                     const content = part.toString('utf8');
                     console.log(`[EmailService] 🔍 DIAGNOSTICO - Parte "${key}": ${content.length} chars, preview: "${content.substring(0, 100)}..."`);
                     
                     // Skip header parts and take first substantial text content
                     if (!key.toLowerCase().includes('header') && content.length > 10) {
                       bodyContent = content;
                       console.log(`[EmailService] ✅ DIAGNOSTICO - Using parte "${key}" como body`);
                       break;
                     }
                   } catch (partError) {
                     console.log(`[EmailService] ⚠️ DIAGNOSTICO - Error procesando parte "${key}":`, partError);
                   }
                 }
               }
            }
            
            // Strategy 2: Try to get full message source and parse it
            if (!bodyContent && message.source) {
              try {
                console.log(`[EmailService] 🔍 DIAGNOSTICO - Intentando extraer del source completo...`);
                const sourceContent = message.source.toString('utf8');
                console.log(`[EmailService] 🔍 DIAGNOSTICO - Source length: ${sourceContent.length}`);
                
                // Try to find content after headers (simple approach)
                const headerEndIndex = sourceContent.indexOf('\n\n');
                if (headerEndIndex !== -1) {
                  bodyContent = sourceContent.substring(headerEndIndex + 2).trim();
                  console.log(`[EmailService] ✅ DIAGNOSTICO - Body extraído del source: ${bodyContent.length} chars`);
                }
              } catch (sourceError) {
                console.log(`[EmailService] ⚠️ DIAGNOSTICO - Error procesando source:`, sourceError);
              }
            }
            
            // Strategy 3: Try bodyStructure parsing (advanced)
            if (!bodyContent && message.bodyStructure) {
              console.log(`[EmailService] 🔍 DIAGNOSTICO - BodyStructure:`, JSON.stringify(message.bodyStructure, null, 2));
              // This would require more complex parsing based on bodyStructure
              // For now, just log it for analysis
            }
            
            if (bodyContent) {
              email.body = bodyContent;
              console.log(`[EmailService] ✅ Body content obtenido: ${bodyContent.length} caracteres`);
            } else {
              console.log(`[EmailService] ❌ DIAGNOSTICO - No se pudo obtener body content para email ${email.id}`);
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
              console.warn(`[EmailService] ⚠️ Error reading email headers for ID ${email.id}:`, headerError);
              email.headers = null;
            }
            
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
      
      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        errorMessage = `No se pudo conectar al servidor IMAP: ${emailConfig.imapHost || emailConfig.host || 'imap.gmail.com'}. Verifica la configuración del host.`;
      } else if (errorMessage.includes('ECONNREFUSED')) {
        errorMessage = `Conexión rechazada por el servidor IMAP en puerto ${emailConfig.imapPort || 993}. Verifica el puerto y las configuraciones de firewall.`;
      } else if (errorMessage.includes('authentication') || errorMessage.includes('login') || errorMessage.includes('credentials')) {
        errorMessage = `Error de autenticación: credenciales inválidas o problema con el acceso al servidor IMAP.`;
      } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
        errorMessage = `Timeout de conexión al servidor IMAP. El servidor puede estar lento o no responder.`;
      } else if (errorMessage.includes('TLS') || errorMessage.includes('SSL')) {
        errorMessage = `Error de certificado TLS/SSL al conectar con el servidor IMAP.`;
      }
      
      throw new Error(`Sent email fetch error: ${errorMessage}`);
    } finally {
      // Clean up connection
      if (client) {
        try {
          await client.logout();
          console.log(`[EmailService] 👋 Desconectado del servidor IMAP (emails enviados)`);
        } catch (logoutError) {
          console.warn(`[EmailService] ⚠️ Error durante logout IMAP (emails enviados):`, logoutError);
        }
      }
    }
  }
} 