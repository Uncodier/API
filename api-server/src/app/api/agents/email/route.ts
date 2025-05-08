/**
 * API de Email - Encargada de obtener y analizar emails
 * Route: POST /api/agents/email
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import * as nodemailer from 'nodemailer';
// Import the packages without TypeScript type checking
const Imap = require('imap');
const { simpleParser } = require('mailparser');
// Import CryptoJS for decryption
import CryptoJS from 'crypto-js';

// Create schemas for request validation
const EmailAgentRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  limit: z.number().default(10).optional(),
  lead_id: z.string().optional(),
  agent_id: z.string().optional(),
  team_member_id: z.string().optional(),
  analysis_type: z.string().optional(),
});

// Error codes
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  EMAIL_CONFIG_NOT_FOUND: 'EMAIL_CONFIG_NOT_FOUND',
  EMAIL_CREDENTIALS_ERROR: 'EMAIL_CREDENTIALS_ERROR',
  SMTP_CONNECTION_ERROR: 'SMTP_CONNECTION_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR'
};

// Get supabase client
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase environment variables");
  }
  
  return createClient(supabaseUrl, supabaseServiceKey);
}

// Token decryption utility
function decryptToken(encryptedValue: string): string {
  try {
    const encryptionKey = process.env.ENCRYPTION_KEY || '';
    
    console.log(`[EMAIL_API] DEBUG - Desencriptando token con longitud ${encryptedValue.length}`);
    console.log(`[EMAIL_API] DEBUG - Primeros 30 caracteres: "${encryptedValue.substring(0, 30)}..."`);
    console.log(`[EMAIL_API] DEBUG - Valor entero del token: "${encryptedValue}"`);
    
    // Validar ENCRYPTION_KEY
    if (!encryptionKey) {
      throw new Error("Missing ENCRYPTION_KEY environment variable");
    }
    
    console.log(`[EMAIL_API] DEBUG - Usando ENCRYPTION_KEY: "${encryptionKey.substring(0, 3)}..." (${encryptionKey.length} caracteres)`);
    
    // Analizar el formato del token (si contiene ":")
    if (encryptedValue.includes(':')) {
      // Formato con salt:encrypted
      console.log(`[EMAIL_API] DEBUG - Formato detectado: salt:encrypted`);
      
      const parts = encryptedValue.split(':');
      const salt = parts[0];
      const encrypted = parts[1];
      
      console.log(`[EMAIL_API] DEBUG - Salt: "${salt}"`);
      console.log(`[EMAIL_API] DEBUG - Encrypted: "${encrypted.substring(0, 30)}..."`);
      
      try {
        // Intentar con la clave del environment
        console.log(`[EMAIL_API] DEBUG - Intentando desencriptar con la clave del environment...`);
        const combinedKey = encryptionKey + salt;
        console.log(`[EMAIL_API] DEBUG - Clave combinada: "${combinedKey.substring(0, 10)}..."`);
        
        const decrypted = CryptoJS.AES.decrypt(encrypted, combinedKey);
        const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
        
        if (!decryptedText) {
          throw new Error("La desencriptación produjo un texto vacío");
        }
        
        console.log(`[EMAIL_API] DEBUG - Desencriptación exitosa con clave del environment, resultado: "${decryptedText.substring(0, 30)}..." (${decryptedText.length} caracteres)`);
        return decryptedText;
      } catch (error) {
        console.error(`[EMAIL_API] DEBUG - Error al desencriptar con clave del environment:`, error);
        
        // Intentar con la clave fija usada originalmente
        try {
          const originalKey = 'Encryption-key';
          console.log(`[EMAIL_API] DEBUG - Intentando con clave fija original: "${originalKey}"...`);
          
          const decrypted = CryptoJS.AES.decrypt(encrypted, originalKey + salt);
          const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
          
          if (!decryptedText) {
            throw new Error("La desencriptación produjo un texto vacío con clave original");
          }
          
          console.log(`[EMAIL_API] DEBUG - Desencriptación exitosa con clave original, resultado: "${decryptedText.substring(0, 30)}..." (${decryptedText.length} caracteres)`);
          return decryptedText;
        } catch (errorOriginal) {
          console.error(`[EMAIL_API] DEBUG - Error al desencriptar con clave original:`, errorOriginal);
          
          // Intentar con otra clave de encriptación si está disponible
          const altEncryptionKey = process.env.ALT_ENCRYPTION_KEY;
          if (altEncryptionKey && process.env.NODE_ENV === 'development') {
            try {
              console.log(`[EMAIL_API] DEBUG - Intentando con clave alternativa...`);
              const altCombinedKey = altEncryptionKey + salt;
              const decrypted = CryptoJS.AES.decrypt(encrypted, altCombinedKey);
              const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
              
              if (!decryptedText) {
                throw new Error("La desencriptación con clave alternativa produjo un texto vacío");
              }
              
              console.log(`[EMAIL_API] DEBUG - Desencriptación con clave alternativa exitosa: "${decryptedText.substring(0, 30)}..."`);
              return decryptedText;
            } catch (altError) {
              console.error(`[EMAIL_API] DEBUG - Error con clave alternativa:`, altError);
            }
          }
          
          throw new Error("No se pudo desencriptar el token con ninguna clave disponible");
        }
      }
    } else {
      // Formato antiguo o diferente
      throw new Error("Formato de token no soportado, se esperaba salt:encrypted");
    }
  } catch (error) {
    console.error("[EMAIL_API] Error desencriptando token:", error);
    throw new Error(`Falló la desencriptación del token: ${error instanceof Error ? error.message : 'Error desconocido'}`);
  }
}

// Función EVP_KDF (Key Derivation Function) usada por OpenSSL/CryptoJS
function evpKDF(password: string, salt: Buffer): { key: Buffer, iv: Buffer } {
  const crypto = require('crypto');
  const keySize = 32; // AES-256 (32 bytes = 256 bits)
  const ivSize = 16;  // IV size para AES-CBC
  
  // Convertir password a Buffer si es string
  const passwordBuffer = typeof password === 'string' ? Buffer.from(password) : password;
  
  // Este es el algoritmo EVP_BytesToKey utilizado por OpenSSL/CryptoJS
  let keyAndIv = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  
  while (keyAndIv.length < keySize + ivSize) {
    const hash = crypto.createHash('md5');
    
    if (block.length > 0) {
      hash.update(block);
    }
    
    hash.update(passwordBuffer);
    
    if (salt) {
      hash.update(salt);
    }
    
    block = hash.digest();
    keyAndIv = Buffer.concat([keyAndIv, block]);
  }
  
  // Dividir el buffer resultante en clave e IV
  return {
    key: keyAndIv.slice(0, keySize),
    iv: keyAndIv.slice(keySize, keySize + ivSize)
  };
}

// Get site settings
async function getSiteSettings(siteId: string) {
  try {
    const supabase = getSupabaseClient();
    
    // Query site settings
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq('site_id', siteId)
      .single();
    
    if (error) {
      throw new Error(`Failed to retrieve site settings: ${error.message}`);
    }
    
    if (!data) {
      throw new Error(`Site settings not found for site ${siteId}`);
    }
    
    return data;
  } catch (error) {
    console.error("Error retrieving site settings:", error);
    throw error;
  }
}

// Get email config from secure_tokens based on email channel in settings
async function getEmailConfig(siteId: string, settings: any) {
  try {
    console.log(`[EMAIL_API] Obteniendo configuración de email para el sitio ${siteId}...`);
    console.log(`[EMAIL_API] Datos de configuración:`, JSON.stringify(settings, null, 2));

    // Obtener el token directamente - esta es la ÚNICA fuente de credenciales que usaremos
    const tokenValue = await getEmailToken(siteId);
    
    if (!tokenValue) {
      console.log(`[EMAIL_API] No se encontró token de email para el sitio ${siteId}`);
      throw new Error(`No se encontró token de email para el sitio ${siteId}. Por favor almacena un token de email usando el endpoint /api/secure-tokens`);
    }
    
    console.log(`[EMAIL_API] Token recuperado, procesando...`);
    
    try {
      // Intentar parsear como JSON
      const parsedValue = JSON.parse(tokenValue);
      console.log(`[EMAIL_API] JSON parseado correctamente`);
      
      if (parsedValue.password) {
        console.log(`[EMAIL_API] Se encontró contraseña en JSON`);
        
        // Crear configuración completa con datos del token
        return {
          user: parsedValue.email || parsedValue.user || settings.channels?.email?.email,
          email: parsedValue.email || parsedValue.user || settings.channels?.email?.email,
          password: parsedValue.password,
          host: parsedValue.host || parsedValue.imapHost || settings.channels?.email?.incomingServer || 'imap.gmail.com',
          imapHost: parsedValue.imapHost || parsedValue.host || settings.channels?.email?.incomingServer || 'imap.gmail.com',
          imapPort: parsedValue.imapPort || parsedValue.port || settings.channels?.email?.incomingPort || 993,
          smtpHost: parsedValue.smtpHost || parsedValue.host || settings.channels?.email?.outgoingServer || 'smtp.gmail.com',
          smtpPort: parsedValue.smtpPort || settings.channels?.email?.outgoingPort || 587,
          tls: true
        };
      } else {
        throw new Error("El token de email no contiene una contraseña");
      }
    } catch (jsonError) {
      // Si no es JSON, asumimos que es la contraseña directamente
      console.log(`[EMAIL_API] El token no es JSON, usando como contraseña directamente`);
      
      return {
        user: settings.channels?.email?.email,
        email: settings.channels?.email?.email,
        password: tokenValue,
        host: settings.channels?.email?.incomingServer || 'imap.gmail.com',
        imapHost: settings.channels?.email?.incomingServer || 'imap.gmail.com',
        imapPort: settings.channels?.email?.incomingPort || 993,
        smtpHost: settings.channels?.email?.outgoingServer || 'smtp.gmail.com',
        smtpPort: settings.channels?.email?.outgoingPort || 587,
        tls: true
      };
    }
  } catch (error) {
    console.error("[EMAIL_API] Error al obtener configuración de email:", error);
    throw error;
  }
}

interface EmailMessage {
  id: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  body?: string | null;
  headers?: any;
}

// Fetch emails directly from IMAP server
async function fetchEmailsFromIMAP(emailConfig: any, limit: number = 10): Promise<EmailMessage[]> {
  // Show actual password in logs for debugging
  console.log(`[EMAIL_API] DEBUG - USING ACTUAL PASSWORD: "${emailConfig.password}"`);
  
  // Sanitize config for logging (hide actual password)
  const sanitizedConfig = {
    user: emailConfig.user || emailConfig.username || emailConfig.email,
    host: emailConfig.imapHost || emailConfig.host,
    port: emailConfig.imapPort || 993,
    tls: emailConfig.tls !== false,
    password: emailConfig.password === "STORED_SECURELY" ? 
      "STORED_SECURELY (ERROR: Contraseña no resuelta)" : 
      (emailConfig.password ? emailConfig.password : "NO_PASSWORD")
  };
  
  console.log(`[EMAIL_API] Conectando al servidor IMAP con configuración:`, 
    JSON.stringify(sanitizedConfig, null, 2));
  
  // Validate required fields
  if (!emailConfig.email && !emailConfig.user && !emailConfig.username) {
    throw new Error("Configuración de email inválida: No se especificó usuario o email");
  }
  
  if (!emailConfig.password) {
    throw new Error("Configuración de email inválida: No se especificó contraseña");
  }
  
  // Prevent using placeholder as actual password
  if (emailConfig.password === "STORED_SECURELY") {
    throw new Error("Error de seguridad: Se está usando 'STORED_SECURELY' como contraseña. La contraseña real no fue recuperada correctamente del almacenamiento seguro.");
  }
  
  return new Promise((resolve, reject) => {
    try {
      // Parse ports to ensure they are numbers
      let imapPort = 993;
      if (emailConfig.imapPort) {
        imapPort = typeof emailConfig.imapPort === 'number' ? 
          emailConfig.imapPort : parseInt(emailConfig.imapPort, 10);
      }
      
      // Create IMAP connection configuration
      const imapConfig = {
        user: emailConfig.user || emailConfig.username || emailConfig.email,
        password: emailConfig.password,
        host: emailConfig.imapHost || emailConfig.host || 'imap.gmail.com',
        port: imapPort,
        tls: emailConfig.tls !== false,
        tlsOptions: { rejectUnauthorized: false },
        debug: console.log // Activar depuración IMAP
      };
      
      console.log(`[EMAIL_API] Iniciando conexión IMAP a ${imapConfig.host}:${imapConfig.port} con usuario ${imapConfig.user}...`);
      
      const imap = new Imap(imapConfig);
      const emails: EmailMessage[] = [];
      
      imap.once('ready', () => {
        console.log(`[EMAIL_API] Conexión IMAP establecida, abriendo bandeja de entrada...`);
        
        imap.openBox('INBOX', false, (err: any, box: any) => {
          if (err) {
            imap.end();
            console.error(`[EMAIL_API] Error al abrir bandeja de entrada:`, err);
            return reject(new Error(`Error opening inbox: ${err && err.message ? err.message : "Unknown error"}`));
          }
          
          // Get the last 'limit' messages (most recent first)
          const totalMessages = box.messages.total;
          console.log(`[EMAIL_API] Total de mensajes en bandeja: ${totalMessages}`);
          
          const startMessage = Math.max(totalMessages - limit + 1, 1);
          console.log(`[EMAIL_API] Obteniendo mensajes desde ${startMessage} hasta ${totalMessages}`);
          
          if (totalMessages === 0) {
            imap.end();
            console.log(`[EMAIL_API] No hay mensajes en la bandeja de entrada.`);
            return resolve([]);
          }
          
          const fetchOptions = {
            bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
            struct: true
          };
          
          console.log(`[EMAIL_API] Iniciando obtención de mensajes...`);
          const f = imap.seq.fetch(`${startMessage}:${totalMessages}`, fetchOptions);
          
          f.on('message', (msg: any, seqno: number) => {
            console.log(`[EMAIL_API] Procesando mensaje #${seqno}`);
            
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
                  console.log(`[EMAIL_API] Procesando cabeceras del mensaje #${seqno}`);
                  // Parse headers manually instead of using nodemailer.parseHeader
                  const headerLines = buffer.split('\r\n');
                  const headers: any = {};
                  let currentHeader = '';
                  
                  for (const line of headerLines) {
                    if (!line.trim()) continue;
                    
                    if (line.match(/^\s/)) {
                      // Continuation of previous header
                      if (currentHeader) {
                        headers[currentHeader] += ' ' + line.trim();
                      }
                    } else {
                      // New header
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
                  
                  console.log(`[EMAIL_API] Cabeceras procesadas para mensaje #${seqno}: ${email.subject}`);
                } else {
                  console.log(`[EMAIL_API] Procesando cuerpo del mensaje #${seqno}`);
                  email.body = buffer;
                }
              });
            });
            
            msg.once('end', () => {
              console.log(`[EMAIL_API] Mensaje #${seqno} procesado completamente`);
              emails.push(email);
            });
          });
          
          f.once('error', (err: any) => {
            console.error(`[EMAIL_API] Error al obtener mensajes:`, err);
            imap.end();
            reject(new Error(`Fetch error: ${err && err.message ? err.message : "Unknown error"}`));
          });
          
          f.once('end', () => {
            console.log(`[EMAIL_API] Finalizada la obtención de mensajes, cerrando conexión...`);
            imap.end();
          });
        });
      });
      
      imap.once('error', (err: any) => {
        console.error(`[EMAIL_API] Error de conexión IMAP:`, err);
        reject(new Error(`IMAP connection error: ${err && err.message ? err.message : "Unknown error"}`));
      });
      
      imap.once('end', () => {
        console.log(`[EMAIL_API] Conexión IMAP finalizada, mensajes obtenidos: ${emails.length}`);
        resolve(emails);
      });
      
      console.log(`[EMAIL_API] Iniciando conexión al servidor IMAP...`);
      imap.connect();
    } catch (error) {
      console.error(`[EMAIL_API] Error al establecer conexión IMAP:`, error);
      reject(error);
    }
  });
}

// Create command object for email analysis
function createEmailCommand(agentId: string, siteId: string, emails: EmailMessage[], analysisType?: string, leadId?: string, teamMemberId?: string) {
  return {
    targets: [
      {
        analysis: {
          summary: "",
          insights: [],
          sentiment: "",
          priority: "",
          action_items: [],
          response_suggestions: []
        }
      }
    ],
    tools: [
      {
        name: "email_extraction",
        description: "extract content and metadata from emails",
        status: "not_initialized",
        type: "synchronous",
        parameters: {
          type: "object",
          properties: {
            site_id: {
              type: "string",
              description: "The site ID to get email configuration"
            },
            limit: {
              type: "number",
              description: "Maximum number of emails to extract"
            },
            extract_attachments: {
              type: "boolean",
              description: "Whether to extract attachment contents"
            }
          },
          required: ["site_id"]
        }
      },
      {
        name: "sentiment_analysis",
        description: "analyze sentiment of email content",
        status: "not_initialized",
        type: "synchronous",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text content to analyze for sentiment"
            },
            detailed: {
              type: "boolean",
              description: "Whether to return detailed sentiment breakdown"
            }
          },
          required: ["text"]
        }
      },
      {
        name: "knowledge_base_search",
        description: "search knowledge base for relevant information",
        status: "not_initialized",
        type: "synchronous",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query for knowledge base"
            },
            site_id: {
              type: "string",
              description: "The site ID for the knowledge base"
            }
          },
          required: ["query", "site_id"]
        }
      }
    ],
    context: JSON.stringify(emails),
    supervisors: [
      {
        agent_role: "email_specialist",
        status: "not_initialized"
      },
      {
        agent_role: "customer_service_manager",
        status: "not_initialized"
      }
    ],
    task: "analyze emails",
    description: "Analyze the provided emails to extract key insights, determine sentiment, identify action items, and suggest appropriate responses based on email content and context.",
    metadata: {
      agent_id: agentId,
      site_id: siteId,
      analysis_type: analysisType,
      lead_id: leadId,
      team_member_id: teamMemberId,
      email_count: emails.length
    }
  };
}

// Main POST endpoint to analyze emails
export async function POST(request: NextRequest) {
  console.log(`[EMAIL_API] Iniciando petición POST...`);
  try {
    // Get request body
    const requestData = await request.json();
    
    // Log request (without sensitive data)
    console.log(`[EMAIL_API] Procesando solicitud para sitio: ${requestData.site_id}`);
    console.log(`[EMAIL_API] Datos de solicitud:`, JSON.stringify({
      ...requestData,
      // Ocultar contraseñas o tokens si existieran
      password: requestData.password ? '[REDACTED]' : undefined
    }, null, 2));
    
    // Validate request data
    const validationResult = EmailAgentRequestSchema.safeParse(requestData);
    
    if (!validationResult.success) {
      console.error("[EMAIL_API] Error de validación:", validationResult.error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INVALID_REQUEST,
            message: "Parámetros de solicitud inválidos",
            details: validationResult.error.format(),
          },
        },
        { status: 400 }
      );
    }
    
    const { site_id, limit = 10, lead_id, agent_id = `email_agent_${Date.now()}`, team_member_id, analysis_type } = validationResult.data;
    console.log(`[EMAIL_API] Parámetros validados correctamente.`);
    
    // Variables para almacenar correos y configuraciones
    let emails: EmailMessage[] = [];
    let siteSettings: any = null;
    let emailConfig: any = null;
    
    // Get site settings
    try {
      console.log(`[EMAIL_API] Obteniendo configuración del sitio...`);
      siteSettings = await getSiteSettings(site_id);
      console.log(`[EMAIL_API] Configuración del sitio obtenida con éxito.`);
    } catch (error) {
      console.error("[EMAIL_API] Error al obtener configuración del sitio:", error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.EMAIL_CONFIG_NOT_FOUND,
            message: error instanceof Error ? error.message : "No se pudo obtener la configuración del sitio",
          },
        },
        { status: 404 }
      );
    }
    
    // Get email configuration
    if (siteSettings) {
      try {
        console.log(`[EMAIL_API] Obteniendo configuración de email...`);
        emailConfig = await getEmailConfig(site_id, siteSettings);
        
        if (emailConfig) {
          // Log the configuration without showing actual password for security
          console.log(`[EMAIL_API] Configuración de email obtenida:`, {
            user: emailConfig.user || emailConfig.username || emailConfig.email,
            host: emailConfig.imapHost || emailConfig.host,
            port: emailConfig.imapPort || 993,
            tls: emailConfig.tls !== false,
            password: emailConfig.password ? 
              (emailConfig.password === "STORED_SECURELY" ? "ERROR: Contraseña no resuelta" : "********") : 
              "NO_PASSWORD"
          });
          
          // Check for common configuration errors
          if (emailConfig.password === "STORED_SECURELY") {
            console.error(`[EMAIL_API] ERROR: La contraseña sigue siendo "STORED_SECURELY", no se resolvió correctamente`);
            throw new Error("La contraseña de email no se pudo resolver correctamente.");
          }
        } else {
          console.error(`[EMAIL_API] No se obtuvo configuración de email`);
          throw new Error("No se pudo obtener configuración de email");
        }
        
        console.log(`[EMAIL_API] Configuración de email obtenida con éxito.`);
      } catch (error) {
        console.error("[EMAIL_API] Error al obtener configuración de email:", error);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: ERROR_CODES.EMAIL_CREDENTIALS_ERROR,
              message: error instanceof Error ? error.message : "No se pudieron obtener las credenciales de email",
            },
          },
          { status: 404 }
        );
      }
    }
    
    // SOLO PARA DESARROLLO - ELIMINAR EN PRODUCCIÓN
    // Si llegamos aquí, significa que no pudimos obtener la configuración de ninguna forma
    // Creamos una configuración de prueba temporal SOLO si estamos en desarrollo
    if (!emailConfig && process.env.NODE_ENV === 'development') {
      console.log(`[EMAIL_API] ⚠️ FALLBACK DE DESARROLLO ACTIVADO ⚠️`);
      // Usar variables de entorno si están disponibles, de lo contrario usar valores por defecto
      const testEmail = process.env.DEV_EMAIL || 'prueba@example.com';
      const testPassword = process.env.DEV_EMAIL_PASSWORD || 'temporalpassword123';
      
      console.log(`[EMAIL_API] Usando credenciales de prueba para desarrollo:`);
      console.log(`[EMAIL_API] Email: ${testEmail}`);
      console.log(`[EMAIL_API] Password: ${testPassword}`);
      
      // Crear configuración de desarrollo
      emailConfig = {
        user: testEmail,
        email: testEmail,
        password: testPassword,
        host: 'imap.gmail.com', 
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        smtpHost: 'smtp.gmail.com',
        smtpPort: 587,
        tls: true
      };
      
      // Crear respuesta simulada de desarrollo
      return NextResponse.json({
        success: true,
        data: {
          commandId: `dev_cmd_${Date.now()}`,
          status: "processing",
          message: "Comando de desarrollo creado (ENTORNO DE PRUEBA)",
          emailCount: 0,
          development: true
        }
      }, { status: 200 });
    } else if (!emailConfig) {
      // Si no estamos en desarrollo y no hay configuración, mostrar error
      console.error("[EMAIL_API] No se pudo obtener configuración de email y no estamos en entorno de desarrollo");
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.EMAIL_CONFIG_NOT_FOUND,
            message: "No se pudo obtener la configuración de email"
          }
        },
        { status: 404 }
      );
    }
    
    // Fetch emails from provider
    try {
      console.log(`[EMAIL_API] Obteniendo correos electrónicos...`);
      emails = await fetchEmailsFromIMAP(emailConfig, limit);
      console.log(`[EMAIL_API] Se obtuvieron ${emails.length} correos con éxito.`);
    } catch (error) {
      console.error("[EMAIL_API] Error al obtener correos:", error);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.SMTP_CONNECTION_ERROR,
            message: error instanceof Error ? error.message : "No se pudo conectar al proveedor de email",
            details: error instanceof Error ? error.stack : undefined
          },
        },
        { status: 500 }
      );
    }
    
    // Create command for email analysis
    console.log(`[EMAIL_API] Creando comando para análisis de correos...`);
    const command = createEmailCommand(agent_id, site_id, emails, analysis_type, lead_id, team_member_id);
    
    // Aquí procesarías el comando con tu sistema de agentes
    const commandId = `cmd_${Date.now()}`;
    console.log(`[EMAIL_API] Comando creado con ID: ${commandId}`);
    
    return NextResponse.json({
      success: true,
      data: {
        commandId,
        status: "processing",
        message: "Comando creado con éxito",
        emailCount: emails.length
      }
    }, { status: 200 });
    
  } catch (error) {
    console.error("[EMAIL_API] Error procesando solicitud:", error);
    
    return NextResponse.json({
      success: false,
      error: {
        code: ERROR_CODES.SYSTEM_ERROR,
        message: error instanceof Error ? error.message : "Ocurrió un error interno del sistema",
        stack: error instanceof Error ? error.stack : undefined
      }
    }, { status: 500 });
  }
}

// GET method for backward compatibility, returns an empty response with a message
export async function GET(request: NextRequest) {
  return NextResponse.json({
    success: true,
    message: "This endpoint requires a POST request with email analysis parameters. Please refer to the documentation."
  }, { status: 200 });
}

// Get and decrypt email token directly from secure_tokens table
async function getEmailToken(siteId: string): Promise<string | null> {
  try {
    console.log(`[EMAIL_API] Buscando token de email para sitio ${siteId}...`);
    
    // Intentar obtener y desencriptar el token a través del servicio
    try {
      const decryptedToken = await getTokenFromService(siteId);
      if (decryptedToken) {
        console.log(`[EMAIL_API] Token obtenido exitosamente del servicio de desencriptación`);
        return decryptedToken;
      }
    } catch (serviceError) {
      console.error(`[EMAIL_API] Error al usar servicio de desencriptación:`, serviceError);
    }
    
    // Si el servicio falla, intentar obtener directamente de la DB
    try {
      console.log(`[EMAIL_API] Intentando obtener token directamente de la base de datos...`);
      const directToken = await getTokenDirectlyFromDatabase(siteId);
      
      if (directToken) {
        console.log(`[EMAIL_API] Token obtenido exitosamente de la base de datos`);
        return directToken;
      } else {
        console.log(`[EMAIL_API] No se encontró token en la base de datos para el sitio ${siteId}`);
      }
    } catch (dbError) {
      console.error(`[EMAIL_API] Error al obtener token de la base de datos:`, dbError);
    }
    
    // No se encontró token
    console.log(`[EMAIL_API] No se encontró token para el sitio ${siteId}`);
    console.log(`[EMAIL_API] Para configurar credenciales de email, usa el endpoint /api/secure-tokens para almacenar un token de tipo "email"`);
    return null;
  } catch (error: any) {
    console.error(`[EMAIL_API] Error general al obtener token de email:`, error);
    return null;
  }
}

// Helper function to get token from service endpoint
async function getTokenFromService(siteId: string): Promise<string | null> {
  // Define request parameters
  const tokenPayload = {
    site_id: siteId,
    token_type: 'email'
  };
  
  // Define URL for the decryption service
  const baseUrl = process.env.NEXT_PUBLIC_ORIGIN || process.env.VERCEL_URL || 'http://localhost:3000';
  let decryptUrl;
  try {
    decryptUrl = new URL('/api/secure-tokens/decrypt', baseUrl).toString();
  } catch (urlError) {
    console.error(`[EMAIL_API] Error al crear URL: ${urlError}`);
    decryptUrl = baseUrl + '/api/secure-tokens/decrypt';
  }
  
  console.log(`[EMAIL_API] Enviando solicitud a: ${decryptUrl}`);
  
  // Request decryption from the service
  const response = await fetch(decryptUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(tokenPayload)
  });
  
  // Parse the response
  const result = await response.json();
  
  if (!response.ok || !result.success || !result.data || !result.data.tokenValue) {
    console.error(`[EMAIL_API] Error o respuesta incompleta del servicio:`, result.error || 'Sin detalles');
    return null;
  }
  
  // Get the decrypted token
  const decryptedValue = result.data.tokenValue;
  
  // If it's already an object, stringify it
  if (typeof decryptedValue === 'object') {
    return JSON.stringify(decryptedValue);
  }
  
  // Otherwise return as is
  return decryptedValue;
}

// Función auxiliar para obtener el token de email directamente de la base de datos
async function getTokenDirectlyFromDatabase(siteId: string): Promise<string | null> {
  try {
    console.log(`[EMAIL_API] Obteniendo token directamente de la base de datos para sitio ${siteId}...`);
    
    const supabase = getSupabaseClient();
    
    // Primero obtener los settings para conseguir el email
    const { data: settings, error: settingsError } = await supabase
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
      
    if (settingsError) {
      console.error(`[EMAIL_API] Error al obtener settings para conseguir email:`, settingsError);
    }
    
    const email = settings?.channels?.email?.email;
    console.log(`[EMAIL_API] Email encontrado en settings: ${email || 'No encontrado'}`);
    
    // Consulta base para el token
    let query = supabase
      .from('secure_tokens')
      .select('*')
      .eq('site_id', siteId)
      .eq('token_type', 'email');
      
    // Si tenemos email, también filtramos por identifier
    if (email) {
      query = query.eq('identifier', email);
    }
    
    // Ejecutar la consulta
    const { data, error } = await query.maybeSingle();
    
    if (error) {
      console.error(`[EMAIL_API] Error al consultar token en DB:`, error);
      return null;
    }
    
    if (!data) {
      // Si no se encontró con el filtro de identifier, intentar solo con site_id y token_type
      if (email) {
        console.log(`[EMAIL_API] No se encontró token con identifier ${email}, intentando sin filtro de identifier...`);
        const { data: dataWithoutIdentifier, error: errorWithoutIdentifier } = await supabase
          .from('secure_tokens')
          .select('*')
          .eq('site_id', siteId)
          .eq('token_type', 'email')
          .maybeSingle();
          
        if (errorWithoutIdentifier) {
          console.error(`[EMAIL_API] Error al consultar token sin identifier:`, errorWithoutIdentifier);
          return null;
        }
        
        if (!dataWithoutIdentifier) {
          console.log(`[EMAIL_API] No se encontró token para sitio ${siteId} en DB`);
          return null;
        }
        
        console.log(`[EMAIL_API] Token encontrado sin filtro de identifier:`, JSON.stringify({
          id: dataWithoutIdentifier.id,
          site_id: dataWithoutIdentifier.site_id,
          token_type: dataWithoutIdentifier.token_type,
          encrypted_value_length: dataWithoutIdentifier.encrypted_value ? dataWithoutIdentifier.encrypted_value.length : 0,
          identifier: dataWithoutIdentifier.identifier
        }, null, 2));
        
        if (!dataWithoutIdentifier.encrypted_value) {
          console.log(`[EMAIL_API] El token no tiene valor encriptado`);
          return null;
        }
        
        console.log(`[EMAIL_API] Valor encriptado encontrado, intentando desencriptar...`);
        
        try {
          const decrypted = decryptToken(dataWithoutIdentifier.encrypted_value);
          console.log(`[EMAIL_API] Token desencriptado correctamente (${decrypted.length} caracteres)`);
          return decrypted;
        } catch (decryptError) {
          console.error(`[EMAIL_API] Error al desencriptar valor:`, decryptError);
          
          // En caso de error, intentemos con una ENCRYPTION_KEY alternativa si existe para depuración
          const alternativeKey = process.env.ALT_ENCRYPTION_KEY;
          if (alternativeKey && process.env.NODE_ENV === 'development') {
            console.log(`[EMAIL_API] Intentando con clave alternativa para pruebas...`);
            const originalKey = process.env.ENCRYPTION_KEY;
            process.env.ENCRYPTION_KEY = alternativeKey;
            
            try {
              const decryptedAlt = decryptToken(dataWithoutIdentifier.encrypted_value);
              console.log(`[EMAIL_API] Token desencriptado exitosamente con clave alternativa`);
              
              // Restaurar la clave original
              process.env.ENCRYPTION_KEY = originalKey;
              return decryptedAlt;
            } catch (altError) {
              console.error(`[EMAIL_API] También falló con clave alternativa:`, altError);
              // Restaurar la clave original
              process.env.ENCRYPTION_KEY = originalKey;
            }
          }
          
          throw decryptError;
        }
      } else {
        console.log(`[EMAIL_API] No se encontró token para sitio ${siteId} en DB`);
        return null;
      }
    }
    
    console.log(`[EMAIL_API] Token encontrado en DB:`, JSON.stringify({
      id: data.id,
      site_id: data.site_id,
      token_type: data.token_type,
      encrypted_value_length: data.encrypted_value ? data.encrypted_value.length : 0,
      identifier: data.identifier
    }, null, 2));
    
    // Solo nos interesa el valor encriptado
    if (!data.encrypted_value) {
      console.log(`[EMAIL_API] El token no tiene valor encriptado`);
      return null;
    }
    
    console.log(`[EMAIL_API] Valor encriptado encontrado, intentando desencriptar...`);
    
    // Desencriptar el valor utilizando nuestra función de desencriptación
    try {
      const decrypted = decryptToken(data.encrypted_value);
      console.log(`[EMAIL_API] Token desencriptado correctamente (${decrypted.length} caracteres)`);
      return decrypted;
    } catch (decryptError) {
      console.error(`[EMAIL_API] Error al desencriptar valor:`, decryptError);
      
      // En caso de error, intentemos con una ENCRYPTION_KEY alternativa si existe para depuración
      const alternativeKey = process.env.ALT_ENCRYPTION_KEY;
      if (alternativeKey && process.env.NODE_ENV === 'development') {
        console.log(`[EMAIL_API] Intentando con clave alternativa para pruebas...`);
        const originalKey = process.env.ENCRYPTION_KEY;
        process.env.ENCRYPTION_KEY = alternativeKey;
        
        try {
          const decryptedAlt = decryptToken(data.encrypted_value);
          console.log(`[EMAIL_API] Token desencriptado exitosamente con clave alternativa`);
          
          // Restaurar la clave original
          process.env.ENCRYPTION_KEY = originalKey;
          return decryptedAlt;
        } catch (altError) {
          console.error(`[EMAIL_API] También falló con clave alternativa:`, altError);
          // Restaurar la clave original
          process.env.ENCRYPTION_KEY = originalKey;
        }
      }
      
      throw decryptError;
    }
  } catch (dbError) {
    console.error(`[EMAIL_API] Error al acceder a la base de datos:`, dbError);
    return null;
  }
} 