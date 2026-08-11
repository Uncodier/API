import { NextRequest, NextResponse } from 'next/server';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { generateTeamInviteHtml, getTeamInviteSubject } from '@/lib/templates/team-invite-email';
import { validateApiKey } from '@/lib/api-keys';
import { resolveEmailLocale } from '@/lib/i18n/email-locale';

/**
 * Interfaz para los miembros del equipo a invitar
 */
interface TeamMemberInvite {
  email: string;
  name: string;
  role: 'view' | 'create' | 'delete' | 'admin';
  position: string;
}

/**
 * Parámetros de la solicitud de invitación
 */
interface InviteTeamMembersRequest {
  siteName: string;
  siteId?: string;
  teamMembers: TeamMemberInvite[];
}

/**
 * Resultado de la invitación por email
 */
interface InviteResult {
  email: string;
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Función para validar la autenticación de la API
 * @param request Solicitud HTTP
 * @returns Booleano indicando si la autenticación es válida
 */
const validateAuth = (request: NextRequest): boolean => {
  // En desarrollo, podemos omitir la autenticación
  if (process.env.NODE_ENV === 'development') {
    console.log('🔓 Modo desarrollo: omitiendo autenticación');
    return true;
  }
  
  // Obtener las cabeceras de autenticación
  const apiKey = request.headers.get('x-api-key');
  const apiSecret = request.headers.get('x-api-secret');
  
  // Si no hay cabeceras de autenticación, rechazar
  if (!apiKey || !apiSecret) {
    console.log('❌ Headers de autenticación faltantes');
    return false;
  }
  
  // Validar las credenciales usando la función del proyecto
  const isValid = validateApiKey(apiKey, apiSecret);
  console.log('🔐 Validación de API key:', isValid ? 'válida' : 'inválida');
  return isValid;
};

/**
 * Endpoint para invitar miembros del equipo
 * 
 * POST /api/teamMembers/invite
 * 
 * Headers (solo en producción):
 * - x-api-key: API key del cliente
 * - x-api-secret: API secret del cliente
 * - Content-Type: application/json
 * 
 * Body:
 * {
 *   "siteName": "string",
 *   "teamMembers": [
 *     {
 *       "email": "string",
 *       "name": "string", 
 *       "role": "view" | "create" | "delete" | "admin",
 *       "position": "string"
 *     }
 *   ]
 * }
 */
export async function POST(request: NextRequest) {
  try {
    // Validar autenticación (se omite en desarrollo)
    if (!validateAuth(request)) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'Missing or invalid authentication headers. x-api-key and x-api-secret are required in production.' 
        },
        { status: 401 }
      );
    }

    // Validar Content-Type
    const contentType = request.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'Content-Type must be application/json' 
        },
        { status: 400 }
      );
    }

    // Parsear el body
    const body: InviteTeamMembersRequest = await request.json();
    
    // Validar parámetros requeridos
    if (!body.siteName) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'siteName is required' 
        },
        { status: 400 }
      );
    }
    
    if (!body.teamMembers || !Array.isArray(body.teamMembers)) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'teamMembers must be an array' 
        },
        { status: 400 }
      );
    }
    
    if (body.teamMembers.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'At least one team member is required' 
        },
        { status: 400 }
      );
    }

    // Validar cada miembro del equipo
    const validRoles = ['view', 'create', 'delete', 'admin'];
    const invalidMembers: string[] = [];
    
    body.teamMembers.forEach((member, index) => {
      if (!member.email || typeof member.email !== 'string') {
        invalidMembers.push(`Member ${index + 1}: email is required and must be a string`);
      } else if (!isValidEmail(member.email)) {
        invalidMembers.push(`Member ${index + 1}: invalid email format`);
      }
      
      if (!member.name || typeof member.name !== 'string') {
        invalidMembers.push(`Member ${index + 1}: name is required and must be a string`);
      }
      
      if (!member.role || !validRoles.includes(member.role)) {
        invalidMembers.push(`Member ${index + 1}: role must be one of: ${validRoles.join(', ')}`);
      }
      
      if (!member.position || typeof member.position !== 'string') {
        invalidMembers.push(`Member ${index + 1}: position is required and must be a string`);
      }
    });
    
    if (invalidMembers.length > 0) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'Validation errors',
          errors: invalidMembers
        },
        { status: 400 }
      );
    }

    console.log(`📧 Procesando invitaciones para ${body.teamMembers.length} miembros del equipo (Site: ${body.siteName})`);

    const locale = await resolveEmailLocale({ siteId: body.siteId });

    // Enviar invitaciones por email
    const inviteResults: InviteResult[] = [];
    
    for (const member of body.teamMembers) {
      console.log(`📤 Enviando invitación a: ${member.email} (${member.name})`);
      
      try {
        const emailResult = await sendGridService.sendEmail({
          to: member.email,
          subject: getTeamInviteSubject(body.siteName, locale),
          html: generateTeamInviteHtml({
            memberName: member.name,
            memberEmail: member.email,
            role: member.role,
            position: member.position,
            siteName: body.siteName,
            locale,
          }),
          categories: ['team-invitation', 'transactional'],
          customArgs: {
            siteId: body.siteId || body.siteName,
            memberRole: member.role,
            invitationType: 'team-member',
            locale,
          }
        });

        if (emailResult.success) {
          inviteResults.push({
            email: member.email,
            success: true,
            messageId: emailResult.messageId
          });
          console.log(`✅ Invitación enviada exitosamente a ${member.email}`);
        } else {
          inviteResults.push({
            email: member.email,
            success: false,
            error: emailResult.error
          });
          console.error(`❌ Error enviando invitación a ${member.email}:`, emailResult.error);
        }
      } catch (error) {
        inviteResults.push({
          email: member.email,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        console.error(`❌ Error procesando invitación para ${member.email}:`, error);
      }
    }

    // Contar resultados
    const successfulInvites = inviteResults.filter(result => result.success).length;
    const failedInvites = inviteResults.filter(result => !result.success).length;

    console.log(`📊 Invitaciones completadas: ${successfulInvites} exitosas, ${failedInvites} fallidas`);

    // Determinar el estado general
    const allSuccessful = failedInvites === 0;
    const anySuccessful = successfulInvites > 0;

    return NextResponse.json({
      success: allSuccessful,
      message: allSuccessful 
        ? 'All invitations sent successfully'
        : anySuccessful 
          ? `${successfulInvites} invitations sent successfully, ${failedInvites} failed`
          : 'All invitations failed',
      data: {
        totalMembers: body.teamMembers.length,
        successfulInvites,
        failedInvites,
        results: inviteResults
      }
    }, { 
      status: allSuccessful ? 200 : (anySuccessful ? 207 : 500) 
    });

  } catch (error) {
    console.error('❌ Error al procesar invitaciones del equipo:', error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Internal server error while processing team invitations',
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

/**
 * Endpoint GET para proporcionar información sobre la API
 */
export async function GET(request: NextRequest) {
  const authRequired = process.env.NODE_ENV === 'production';
  
  return NextResponse.json(
    { 
      message: 'Team Members Invite API',
      usage: 'Send a POST request with JSON: { "siteName": "string", "teamMembers": [...] }',
      authentication: authRequired 
        ? 'x-api-key and x-api-secret headers required in production'
        : 'Authentication disabled in development mode',
      environment: process.env.NODE_ENV,
      endpoints: {
        '/api/teamMembers/invite': 'POST - Send email invitations to team members'
      },
      roles: ['view', 'create', 'delete', 'admin']
    },
    { status: 200 }
  );
}

/**
 * Valida el formato de un email
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
 