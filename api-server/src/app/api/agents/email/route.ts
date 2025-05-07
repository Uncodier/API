import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import * as nodemailer from 'nodemailer';
// Import the packages without TypeScript type checking
const Imap = require('imap');
const { simpleParser } = require('mailparser');

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
    const crypto = require('crypto');
    const encryptionKey = process.env.ENCRYPTION_KEY || '';
    
    if (!encryptionKey) {
      throw new Error("Missing ENCRIPTION_KEY environment variable");
    }
    
    // Extract the iv and encrypted content (assuming format: iv:encryptedContent)
    const parts = encryptedValue.split(':');
    if (parts.length !== 2) {
      throw new Error("Invalid encrypted token format");
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    
    // Create key from the encryption key
    // Use SHA-256 to ensure key is the right length for AES-256
    const key = crypto.createHash('sha256').update(String(encryptionKey)).digest();
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    // Decrypt
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString();
  } catch (error) {
    console.error("Error decrypting token:", error);
    throw new Error(`Failed to decrypt token: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
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

    // Si no hay configuración de canales, intentar obtener un token predeterminado
    if (!settings.channels || !Array.isArray(settings.channels) || !settings.channels.length) {
      console.log(`[EMAIL_API] No se encontraron canales configurados para el sitio: ${siteId}, buscando token por defecto`);
      
      const supabase = getSupabaseClient();
      
      // Intentar obtener un token con el identificador predeterminado
      const { data, error } = await supabase
        .from('secure_tokens')
        .select('token_value')
        .eq('site_id', siteId)
        .eq('token_type', 'email')
        .eq('identifier', 'default')
        .single();
      
      if (error) {
        console.log(`[EMAIL_API] Error al buscar token por defecto:`, error);
        throw new Error(`No se pudo obtener el token de email: ${error.message}`);
      }
      
      if (!data) {
        console.log(`[EMAIL_API] No se encontró ningún token para el sitio: ${siteId}`);
        throw new Error(`No se encontraron credenciales de email para el sitio ${siteId}`);
      }
      
      console.log(`[EMAIL_API] Token por defecto encontrado, descifrando...`);
      // Descifrar y devolver el token
      const decryptedToken = decryptToken(data.token_value);
      try {
        const config = JSON.parse(decryptedToken);
        console.log(`[EMAIL_API] Configuración de email obtenida con éxito.`);
        return config;
      } catch (jsonError) {
        console.log(`[EMAIL_API] Error al parsear el token, usando formato simple:`, jsonError);
        return { token: decryptedToken };
      }
    }
    
    // Si hay canales configurados, continuar con la lógica existente
    console.log(`[EMAIL_API] Canales encontrados: ${settings.channels.length}, buscando canal de email...`);
    
    // Find the email channel
    const emailChannel = settings.channels.find((channel: any) => 
      channel.type === 'email' && channel.enabled === true
    );
    
    if (!emailChannel) {
      console.log(`[EMAIL_API] No se encontró canal de email activo para el sitio: ${siteId}, buscando token por defecto`);
      
      const supabase = getSupabaseClient();
      
      // Intentar obtener un token con el identificador predeterminado
      const { data, error } = await supabase
        .from('secure_tokens')
        .select('token_value')
        .eq('site_id', siteId)
        .eq('token_type', 'email')
        .eq('identifier', 'default')
        .single();
      
      if (error) {
        console.log(`[EMAIL_API] Error al buscar token por defecto:`, error);
        throw new Error(`No se pudo obtener el token de email: ${error.message}`);
      }
      
      if (!data) {
        console.log(`[EMAIL_API] No se encontró ningún token para el sitio: ${siteId}`);
        throw new Error(`No se encontraron credenciales de email para el sitio ${siteId}`);
      }
      
      console.log(`[EMAIL_API] Token por defecto encontrado, descifrando...`);
      // Descifrar y devolver el token
      const decryptedToken = decryptToken(data.token_value);
      try {
        const config = JSON.parse(decryptedToken);
        console.log(`[EMAIL_API] Configuración de email obtenida con éxito.`);
        return config;
      } catch (jsonError) {
        console.log(`[EMAIL_API] Error al parsear el token, usando formato simple:`, jsonError);
        return { token: decryptedToken };
      }
    }
    
    // Get the token identifier from the email channel
    const tokenIdentifier = emailChannel.identifier || 'default';
    console.log(`[EMAIL_API] Canal de email encontrado con identificador: ${tokenIdentifier}, obteniendo token...`);
    
    const supabase = getSupabaseClient();
    
    // Query the secure_tokens table
    const { data, error } = await supabase
      .from('secure_tokens')
      .select('token_value')
      .eq('site_id', siteId)
      .eq('token_type', 'email')
      .eq('identifier', tokenIdentifier)
      .single();
    
    if (error) {
      console.log(`[EMAIL_API] Error al obtener token de email:`, error);
      throw new Error(`Failed to retrieve token: ${error.message}`);
    }
    
    if (!data) {
      console.log(`[EMAIL_API] No se encontró ningún token con identificador: ${tokenIdentifier}`);
      throw new Error(`Email credentials not found for site ${siteId} with identifier ${tokenIdentifier}`);
    }
    
    console.log(`[EMAIL_API] Token encontrado, descifrando...`);
    // Decrypt the token value
    const decryptedToken = decryptToken(data.token_value);
    
    // Parse as JSON if possible, otherwise treat as plain token
    try {
      const config = JSON.parse(decryptedToken);
      console.log(`[EMAIL_API] Configuración de email obtenida con éxito.`);
      return config;
    } catch (jsonError) {
      console.log(`[EMAIL_API] Error al parsear el token, usando formato simple:`, jsonError);
      return { token: decryptedToken };
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
  console.log(`[EMAIL_API] Conectando al servidor IMAP con configuración:`, 
    JSON.stringify({
      user: emailConfig.user || emailConfig.username || emailConfig.email,
      host: emailConfig.imapHost || emailConfig.host,
      port: emailConfig.imapPort || 993,
      tls: emailConfig.tls !== false
    }, null, 2));
  
  return new Promise((resolve, reject) => {
    try {
      // Create IMAP connection configuration
      const imapConfig = {
        user: emailConfig.user || emailConfig.username || emailConfig.email,
        password: emailConfig.password,
        host: emailConfig.imapHost || emailConfig.host,
        port: emailConfig.imapPort || 993,
        tls: emailConfig.tls !== false,
        tlsOptions: { rejectUnauthorized: false },
        debug: console.log // Activar depuración IMAP
      };
      
      console.log(`[EMAIL_API] Iniciando conexión IMAP...`);
      
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