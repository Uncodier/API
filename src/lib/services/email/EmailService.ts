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
            bodyParts: ['HEADER', 'TEXT'],
            bodyStructure: true
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
            
            // Get text body if available
            try {
              const textPart = message.bodyParts?.get('TEXT');
              if (textPart) {
                email.body = textPart.toString('utf8');
              }
            } catch (bodyError) {
              console.warn(`[EmailService] ⚠️ Error reading email body for ID ${email.id}:`, bodyError);
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
      
      // Try different possible names for sent folder
      const possibleSentFolders = ['Sent', 'SENT', '[Gmail]/Sent Mail', 'Elementos enviados', 'Enviados', 'Sent Items'];
      let sentMailbox = null;
      
      console.log(`[EmailService] 🔍 Buscando carpeta de emails enviados...`);
      
      // List available mailboxes to find the sent folder
      let mailboxList;
      try {
        mailboxList = await client.list();
        console.log(`[EmailService] 📋 Carpetas disponibles:`, mailboxList.map(m => m.name));
      } catch (listError) {
        console.warn(`[EmailService] ⚠️ No se pudo listar carpetas, usando nombres estándar`);
      }
      
      // Try to find the sent folder
      for (const folderName of possibleSentFolders) {
        try {
          await client.mailboxOpen(folderName);
          sentMailbox = folderName;
          console.log(`[EmailService] ✅ Carpeta de enviados encontrada: ${folderName}`);
          break;
        } catch (openError) {
          console.log(`[EmailService] ❌ No se pudo abrir carpeta: ${folderName}`);
        }
      }
      
      if (!sentMailbox) {
        throw new Error('No se pudo encontrar la carpeta de emails enviados. Carpetas intentadas: ' + possibleSentFolders.join(', '));
      }
      
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
            bodyParts: ['HEADER', 'TEXT'],
            bodyStructure: true
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
              console.warn(`[EmailService] ⚠️ Error reading email body for ID ${email.id}:`, bodyError);
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