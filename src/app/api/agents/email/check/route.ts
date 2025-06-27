import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';
// Import the packages without TypeScript type checking
import { ImapFlow } from 'imapflow';
const nodemailer = require('nodemailer');

// Create schema for request validation (aligned with parent route)
const EmailCheckRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required").optional(),
  email: z.string().email().optional(),
  password: z.string().optional(),
  use_saved_credentials: z.boolean().default(true).optional(),
  incoming_server: z.string().optional(),
  incoming_port: z.number().or(z.string()).optional(),
  outgoing_server: z.string().optional(),
  outgoing_port: z.number().or(z.string()).optional(),
  tls: z.boolean().default(true).optional(),
  skip_smtp: z.boolean().default(false).optional()
});

// Error codes
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  EMAIL_CONFIG_NOT_FOUND: 'EMAIL_CONFIG_NOT_FOUND',
  EMAIL_FETCH_ERROR: 'EMAIL_FETCH_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR'
};

// Validate IMAP connection using ImapFlow
async function checkIMAPConnection(config: {
  user?: string;
  email?: string;
  password: string;
  host?: string;
  imapHost?: string;
  port?: number | string;
  imapPort?: number | string;
  tls?: boolean;
  // OAuth2 support
  accessToken?: string;
  useOAuth?: boolean;
}): Promise<{
  success: boolean;
  messages?: {
    total: number;
    recent: number;
    unseen: number;
  };
  error?: string;
}> {
  let client: ImapFlow | undefined;
  
  try {
    console.log(`[EMAIL_CHECK] Probando conexión IMAP con configuración:`, {
      ...config,
      password: config.password ? '******' : 'NO_PASSWORD',
      accessToken: config.accessToken ? '******' : undefined
    });

    // Parse ports to ensure they are numbers
    let imapPort = 993;
    if (config.port || config.imapPort) {
      const portValue = config.imapPort || config.port;
      imapPort = typeof portValue === 'number' ? portValue : parseInt(String(portValue), 10);
    }
    
    // Create ImapFlow connection configuration
    const imapConfig: any = {
      host: config.imapHost || config.host || 'imap.gmail.com',
      port: imapPort,
      secure: config.tls !== false,
      logger: false, // Disable logging for production
      tls: {
        rejectUnauthorized: false
      }
    };

    // Configure authentication
    if (config.useOAuth && config.accessToken) {
      // OAuth2 authentication
      imapConfig.auth = {
        user: config.user || config.email,
        accessToken: config.accessToken
      };
    } else {
      // Traditional password authentication
      imapConfig.auth = {
        user: config.user || config.email,
        pass: config.password
      };
    }
    
    // Create ImapFlow client
    client = new ImapFlow(imapConfig);
    
    // Connect to the server
    await client.connect();
    console.log(`[EMAIL_CHECK] Conexión IMAP establecida correctamente`);
    
    // Get mailbox lock for INBOX to verify permissions
    const lock = await client.getMailboxLock('INBOX');
    
    try {
      const mailboxInfo = client.mailbox;
      
      // Type guard to check if mailboxInfo is a MailboxObject
      const isMailboxObject = typeof mailboxInfo === 'object' && mailboxInfo !== null;
      
      console.log(`[EMAIL_CHECK] Información del buzón:`, {
        exists: isMailboxObject ? (mailboxInfo as any).exists : 0,
        recent: isMailboxObject ? (mailboxInfo as any).recent : 0,
        unseen: isMailboxObject ? (mailboxInfo as any).unseen : 0
      });
      
      return {
        success: true,
        messages: {
          total: isMailboxObject ? (mailboxInfo as any).exists || 0 : 0,
          recent: isMailboxObject ? (mailboxInfo as any).recent || 0 : 0,
          unseen: isMailboxObject ? (mailboxInfo as any).unseen || 0 : 0
        }
      };
      
    } finally {
      // Always release the lock
      lock.release();
    }
    
  } catch (error: unknown) {
    console.error(`[EMAIL_CHECK] Error de conexión IMAP:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `IMAP connection error: ${errorMessage}`
    };
  } finally {
    // Clean up connection
    if (client) {
      try {
        await client.logout();
        console.log(`[EMAIL_CHECK] Conexión IMAP finalizada`);
      } catch (logoutError) {
        console.warn('[EMAIL_CHECK] Error during IMAP logout:', logoutError);
      }
    }
  }
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
      smtpPort = typeof config.smtpPort === 'number' ? config.smtpPort : parseInt(String(config.smtpPort), 10);
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
    console.log('[EMAIL_CHECK] Request data received:', JSON.stringify(requestData, null, 2));
    
    // Normalizar datos del request para aceptar tanto camelCase como snake_case (igual que la ruta principal)
    const normalizedData = CaseConverterService.normalizeRequestData(requestData, 'snake');
    console.log('[EMAIL_CHECK] Normalized data:', JSON.stringify(normalizedData, null, 2));
    
    const validationResult = EmailCheckRequestSchema.safeParse(normalizedData);
    
    if (!validationResult.success) {
      console.error("[EMAIL_CHECK] Validation error details:", JSON.stringify({
        error: validationResult.error.format(),
        issues: validationResult.error.issues,
      }, null, 2));
      
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
    
    console.log('[EMAIL_CHECK] Validation successful, parsed data:', JSON.stringify(validationResult.data, null, 2));
    
    // Extraer parámetros usando getFlexibleProperty para máxima compatibilidad (igual que la ruta principal)
    const siteId = getFlexibleProperty(requestData, 'site_id') || getFlexibleProperty(requestData, 'siteId') || validationResult.data.site_id;
    const emailAddress = getFlexibleProperty(requestData, 'email') || validationResult.data.email;
    const password = getFlexibleProperty(requestData, 'password') || validationResult.data.password;
    const useSavedCredentials = getFlexibleProperty(requestData, 'use_saved_credentials') || getFlexibleProperty(requestData, 'useSavedCredentials') || validationResult.data.use_saved_credentials;
    const incomingServer = getFlexibleProperty(requestData, 'incoming_server') || getFlexibleProperty(requestData, 'incomingServer') || validationResult.data.incoming_server;
    const incomingPort = getFlexibleProperty(requestData, 'incoming_port') || getFlexibleProperty(requestData, 'incomingPort') || validationResult.data.incoming_port;
    const outgoingServer = getFlexibleProperty(requestData, 'outgoing_server') || getFlexibleProperty(requestData, 'outgoingServer') || validationResult.data.outgoing_server;
    const outgoingPort = getFlexibleProperty(requestData, 'outgoing_port') || getFlexibleProperty(requestData, 'outgoingPort') || validationResult.data.outgoing_port;
    const tls = getFlexibleProperty(requestData, 'tls') !== undefined ? getFlexibleProperty(requestData, 'tls') : validationResult.data.tls;
    const skipSmtp = getFlexibleProperty(requestData, 'skip_smtp') || getFlexibleProperty(requestData, 'skipSmtp') || validationResult.data.skip_smtp;
    
    console.log('[EMAIL_CHECK] Extracted parameters:', {
      siteId, emailAddress, useSavedCredentials, incomingServer, incomingPort, outgoingServer, outgoingPort, tls, skipSmtp,
      hasPassword: !!password
    });
    
    let emailConfig: any;
    
    // Usar la misma lógica que la ruta padre para obtener configuración
    if (siteId && useSavedCredentials !== false) {
      console.log(`[EMAIL_CHECK] Obteniendo credenciales guardadas para sitio ${siteId}...`);
      
      try {
        // Usar EmailConfigService exactamente igual que la ruta principal
        emailConfig = await EmailConfigService.getEmailConfig(siteId);
        console.log(`[EMAIL_CHECK] Credenciales obtenidas desde EmailConfigService`);
        
        // Override with manual values if provided (mantener la flexibilidad)
        if (incomingServer) emailConfig.host = emailConfig.imapHost = incomingServer;
        if (incomingPort) emailConfig.port = emailConfig.imapPort = typeof incomingPort === 'number' ? incomingPort : parseInt(incomingPort, 10);
        if (outgoingServer) emailConfig.smtpHost = outgoingServer;
        if (outgoingPort) emailConfig.smtpPort = typeof outgoingPort === 'number' ? outgoingPort : parseInt(outgoingPort, 10);
        if (emailAddress) emailConfig.email = emailConfig.user = emailAddress;
        if (password) emailConfig.password = password;
        if (tls !== undefined) emailConfig.tls = tls;
        
      } catch (error: unknown) {
        console.error(`[EMAIL_CHECK] Error al obtener credenciales guardadas:`, error);
        
        // Usar los mismos códigos de error que la ruta principal
        const isConfigError = error instanceof Error && (
          error.message.includes('settings') || 
          error.message.includes('token')
        );
        
        return NextResponse.json(
          {
            success: false,
            error: {
              code: isConfigError ? ERROR_CODES.EMAIL_CONFIG_NOT_FOUND : ERROR_CODES.EMAIL_FETCH_ERROR,
              message: error instanceof Error ? error.message : "Error obteniendo credenciales guardadas"
            }
          },
          { status: isConfigError ? 404 : 500 }
        );
      }
    } else {
      // Usar credenciales manuales
      console.log(`[EMAIL_CHECK] Usando credenciales manuales`);
      emailConfig = {
        user: emailAddress,
        email: emailAddress,
        password: password,
        host: incomingServer || 'imap.gmail.com',
        imapHost: incomingServer || 'imap.gmail.com',
        port: typeof incomingPort === 'number' ? incomingPort : (incomingPort ? parseInt(incomingPort, 10) : 993),
        imapPort: typeof incomingPort === 'number' ? incomingPort : (incomingPort ? parseInt(incomingPort, 10) : 993),
        smtpHost: outgoingServer || 'smtp.gmail.com',
        smtpPort: typeof outgoingPort === 'number' ? outgoingPort : (outgoingPort ? parseInt(outgoingPort, 10) : 587),
        tls: tls !== false
      };
    }
    
    // Validate that we have the minimum required fields
    if (!emailConfig.password) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.EMAIL_CONFIG_NOT_FOUND,
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
            code: ERROR_CODES.EMAIL_CONFIG_NOT_FOUND,
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
      success: skipSmtp, 
      skipped: skipSmtp 
    };
    if (imapResult.success && !skipSmtp) {
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
      success: imapResult.success && (smtpResult.success || skipSmtp),
      imap: imapResult,
      smtp: smtpResult,
      config: {
        host: emailConfig.host,
        port: emailConfig.port,
        user: emailConfig.user || emailConfig.email,
        tls: emailConfig.tls,
        // Don't return the password for security
      }
    };
    
    return NextResponse.json(response);
    
  } catch (error: unknown) {
    console.error(`[EMAIL_CHECK] Error en procesamiento:`, error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: ERROR_CODES.SYSTEM_ERROR,
          message: error instanceof Error ? error.message : "System error"
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