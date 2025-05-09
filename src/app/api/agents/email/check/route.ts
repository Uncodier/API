import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
// Import the packages without TypeScript type checking
const Imap = require('imap');
const nodemailer = require('nodemailer');

// Create schema for request validation
const EmailCheckRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required").optional(),
  host: z.string().optional(),
  port: z.number().or(z.string()).optional(),
  user: z.string().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  tls: z.boolean().default(true).optional(),
  skip_smtp: z.boolean().default(false).optional()
});

// Error codes
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  CREDENTIALS_ERROR: 'CREDENTIALS_ERROR',
  IMAP_CONNECTION_ERROR: 'IMAP_CONNECTION_ERROR',
  SMTP_CONNECTION_ERROR: 'SMTP_CONNECTION_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR'
};

// Validate IMAP connection
async function checkIMAPConnection(config: {
  user?: string;
  email?: string;
  password: string;
  host?: string;
  port?: number | string;
  tls?: boolean;
}): Promise<{
  success: boolean;
  messages?: {
    total: number;
    recent: number;
    unseen: number;
  };
  error?: string;
}> {
  return new Promise((resolve, reject) => {
    try {
      console.log(`[EMAIL_CHECK] Probando conexión IMAP con configuración:`, {
        ...config,
        password: config.password ? '******' : 'NO_PASSWORD'
      });

      // Parse ports to ensure they are numbers
      let imapPort = 993;
      if (config.port) {
        imapPort = typeof config.port === 'number' ? config.port : parseInt(config.port, 10);
      }
      
      // Create IMAP connection
      const imapConfig = {
        user: config.user || config.email,
        password: config.password,
        host: config.host || 'imap.gmail.com',
        port: imapPort,
        tls: config.tls !== false,
        tlsOptions: { rejectUnauthorized: false },
        debug: console.log
      };
      
      const imap = new Imap(imapConfig);
      
      imap.once('ready', () => {
        console.log(`[EMAIL_CHECK] Conexión IMAP establecida correctamente`);
        
        // Try to open inbox to verify permissions
        imap.openBox('INBOX', false, (err: Error | null, box: any) => {
          imap.end();
          if (err) {
            console.error(`[EMAIL_CHECK] Error al abrir bandeja de entrada:`, err);
            reject({
              success: false,
              error: `Failed to open INBOX: ${err.message}`
            });
          } else {
            const totalMessages = box.messages.total;
            resolve({
              success: true,
              messages: {
                total: totalMessages,
                recent: box.messages.recent,
                unseen: box.messages.unseen
              }
            });
          }
        });
      });
      
      imap.once('error', (err: Error) => {
        console.error(`[EMAIL_CHECK] Error de conexión IMAP:`, err);
        reject({
          success: false,
          error: `IMAP connection error: ${err.message}`
        });
      });
      
      imap.once('end', () => {
        console.log(`[EMAIL_CHECK] Conexión IMAP finalizada`);
      });
      
      // Connect to the server
      imap.connect();
      
    } catch (error: unknown) {
      console.error(`[EMAIL_CHECK] Error al establecer conexión IMAP:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      reject({
        success: false,
        error: `Failed to establish IMAP connection: ${errorMessage}`
      });
    }
  });
}

// Validate SMTP connection
async function checkSMTPConnection(config: {
  user?: string;
  email?: string;
  password: string;
  host?: string;
  smtpHost?: string;
  port?: number | string;
  smtpPort?: number | string;
  tls?: boolean;
}): Promise<{
  success: boolean;
  skipped: boolean;
  error?: string;
}> {
  try {
    console.log(`[EMAIL_CHECK] Probando conexión SMTP con configuración:`, {
      ...config,
      password: config.password ? '******' : 'NO_PASSWORD'
    });
    
    // Parse ports to ensure they are numbers
    let smtpPort = 587;
    if (config.smtpPort) {
      smtpPort = typeof config.smtpPort === 'number' ? config.smtpPort : parseInt(config.smtpPort, 10);
    }
    
    // Create transporter
    const transporterConfig = {
      host: config.smtpHost || config.host || 'smtp.gmail.com',
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: config.user || config.email,
        pass: config.password
      },
      tls: {
        rejectUnauthorized: false
      }
    };
    
    const transporter = nodemailer.createTransport(transporterConfig);
    
    // Verify connection configuration
    console.log(`[EMAIL_CHECK] Verificando configuración SMTP...`);
    await transporter.verify();
    
    console.log(`[EMAIL_CHECK] Conexión SMTP establecida correctamente`);
    return {
      success: true,
      skipped: false
    };
  } catch (error: unknown) {
    console.error(`[EMAIL_CHECK] Error al establecer conexión SMTP:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      skipped: false,
      error: `SMTP connection error: ${errorMessage}`
    };
  }
}

// Main handler for email checking
export async function POST(request: NextRequest) {
  console.log(`[EMAIL_CHECK] Iniciando verificación de credenciales de email...`);
  try {
    // Get request body
    const requestData = await request.json();
    
    // Log request (without sensitive data)
    console.log(`[EMAIL_CHECK] Procesando solicitud:`, {
      ...requestData,
      password: requestData.password ? '[REDACTED]' : undefined
    });
    
    // Validate request data
    const validationResult = EmailCheckRequestSchema.safeParse(requestData);
    
    if (!validationResult.success) {
      console.error("[EMAIL_CHECK] Error de validación:", validationResult.error);
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
    
    const {
      site_id,
      host = 'imap.gmail.com',
      port = 993,
      user,
      email,
      password,
      tls = true,
      skip_smtp = false
    } = validationResult.data;
    
    // If site_id is provided, try to get credentials from token service
    let emailConfig: any = {
      host,
      port,
      user: user || email,
      email: email || user,
      password,
      tls
    };
    
    if (site_id && (!password || !emailConfig.user)) {
      console.log(`[EMAIL_CHECK] Obteniendo credenciales desde servicio de tokens para sitio ${site_id}...`);
      
      try {
        // Define URL for the decryption service
        const baseUrl = process.env.NEXT_PUBLIC_ORIGIN || process.env.VERCEL_URL || 'http://localhost:3000';
        const decryptUrl = new URL('/api/secure-tokens/decrypt', baseUrl).toString();
        
        // Request decryption from the service
        const response = await fetch(decryptUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            site_id,
            token_type: 'email'
          })
        });
        
        // Parse the response
        const result = await response.json();
        
        if (!response.ok || !result.success) {
          console.error(`[EMAIL_CHECK] Error al obtener credenciales de token:`, result.error);
          return NextResponse.json(
            {
              success: false,
              error: {
                code: ERROR_CODES.CREDENTIALS_ERROR,
                message: `Failed to get email credentials: ${result.error?.message || 'Unknown error'}`
              }
            },
            { status: 500 }
          );
        }
        
        if (!result.data || !result.data.tokenValue) {
          console.error(`[EMAIL_CHECK] No se encontraron credenciales en el token`);
          return NextResponse.json(
            {
              success: false,
              error: {
                code: ERROR_CODES.CREDENTIALS_ERROR,
                message: `No credentials found in token for site ${site_id}`
              }
            },
            { status: 404 }
          );
        }
        
        // Get credentials from token
        const tokenValue = result.data.tokenValue;
        console.log(`[EMAIL_CHECK] Credenciales obtenidas desde token`);
        
        // If token value is an object
        if (typeof tokenValue === 'object') {
          emailConfig = {
            ...emailConfig,
            ...tokenValue
          };
        } 
        // If token value is a string, try to parse as JSON
        else if (typeof tokenValue === 'string') {
          try {
            const parsedValue = JSON.parse(tokenValue);
            emailConfig = {
              ...emailConfig,
              ...parsedValue
            };
          } catch (parseError) {
            // If not JSON, assume it's just the password
            emailConfig.password = tokenValue;
          }
        }
      } catch (tokenError: any) {
        console.error(`[EMAIL_CHECK] Error al obtener credenciales desde token:`, tokenError);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: ERROR_CODES.SYSTEM_ERROR,
              message: `Error fetching credentials: ${tokenError.message}`
            }
          },
          { status: 500 }
        );
      }
    }
    
    // Validate that we have the minimum required fields
    if (!emailConfig.password) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.CREDENTIALS_ERROR,
            message: "Password is required"
          }
        },
        { status: 400 }
      );
    }
    
    if (!emailConfig.user && !emailConfig.email) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.CREDENTIALS_ERROR,
            message: "User or email is required"
          }
        },
        { status: 400 }
      );
    }
    
    // Test IMAP connection
    let imapResult: {
      success: boolean;
      messages?: {
        total: number;
        recent: number;
        unseen: number;
      };
      error?: string;
    };
    
    try {
      imapResult = await checkIMAPConnection(emailConfig);
    } catch (imapError: any) {
      console.error(`[EMAIL_CHECK] Error en verificación IMAP:`, imapError);
      imapResult = {
        success: false,
        error: imapError.error || imapError.message || "IMAP connection failed"
      };
    }
    
    // Test SMTP connection if IMAP successful and not skipped
    let smtpResult: { 
      success: boolean; 
      skipped: boolean;
      error?: string;
    } = { 
      success: skip_smtp, 
      skipped: skip_smtp 
    };
    if (imapResult.success && !skip_smtp) {
      try {
        smtpResult = await checkSMTPConnection(emailConfig);
      } catch (smtpError: any) {
        console.error(`[EMAIL_CHECK] Error en verificación SMTP:`, smtpError);
        smtpResult = {
          success: false,
          skipped: false,
          error: smtpError.error || smtpError.message || "SMTP connection failed"
        };
      }
    }
    
    // Prepare the response
    const response = {
      success: imapResult.success && (smtpResult.success || skip_smtp),
      imap: imapResult,
      smtp: smtpResult,
      config: {
        host: emailConfig.host,
        port: emailConfig.port,
        user: emailConfig.user || emailConfig.email,
        tls: emailConfig.tls,
        // Don't return the password
      }
    };
    
    return NextResponse.json(response);
    
  } catch (error: any) {
    console.error(`[EMAIL_CHECK] Error en procesamiento:`, error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: ERROR_CODES.SYSTEM_ERROR,
          message: error.message || "System error"
        }
      },
      { status: 500 }
    );
  }
}

// Get method returns information about the endpoint
export async function GET() {
  return NextResponse.json({
    success: true,
    message: "Email credential checking service. Send a POST request with email credentials to validate them."
  });
} 