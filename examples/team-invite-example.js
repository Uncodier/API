/**
 * Ejemplos de uso del endpoint /api/teamMembers/invite
 * 
 * Este endpoint permite enviar invitaciones por email a miembros del equipo
 * para que se unan a un proyecto específico en Uncodie.
 */

// Configuración
const API_BASE_URL = 'http://localhost:3000'; // Cambiar por tu URL de producción
const API_KEY = 'your-api-key';
const API_SECRET = 'your-api-secret';

/**
 * Ejemplo básico: Invitar un solo miembro
 */
async function inviteSingleMember() {
  const response = await fetch(`${API_BASE_URL}/api/teamMembers/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'x-api-secret': API_SECRET
    },
    body: JSON.stringify({
      siteName: 'Mi Proyecto Awesome',
      teamMembers: [
        {
          email: 'developer@company.com',
          name: 'Juan Pérez',
          role: 'create',
          position: 'Frontend Developer'
        }
      ]
    })
  });

  const result = await response.json();
  
  if (response.ok) {
    console.log('✅ Invitación enviada exitosamente:', result);
  } else {
    console.error('❌ Error enviando invitación:', result);
  }
}

/**
 * Ejemplo avanzado: Invitar múltiples miembros con diferentes roles
 */
async function inviteMultipleMembers() {
  const teamMembers = [
    {
      email: 'admin@company.com',
      name: 'María González',
      role: 'admin',
      position: 'Project Manager'
    },
    {
      email: 'developer1@company.com',
      name: 'Carlos Rodríguez',
      role: 'create',
      position: 'Full Stack Developer'
    },
    {
      email: 'developer2@company.com',
      name: 'Ana Martínez',
      role: 'create',
      position: 'Frontend Developer'
    },
    {
      email: 'designer@company.com',
      name: 'Luis Hernández',
      role: 'view',
      position: 'UI/UX Designer'
    },
    {
      email: 'qa@company.com',
      name: 'Patricia Silva',
      role: 'delete',
      position: 'QA Engineer'
    }
  ];

  const response = await fetch(`${API_BASE_URL}/api/teamMembers/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'x-api-secret': API_SECRET
    },
    body: JSON.stringify({
      siteName: 'Plataforma E-commerce',
      teamMembers: teamMembers
    })
  });

  const result = await response.json();
  
  console.log(`📊 Resultado de invitaciones múltiples:`);
  console.log(`   Total: ${result.data?.totalMembers || 0}`);
  console.log(`   Exitosas: ${result.data?.successfulInvites || 0}`);
  console.log(`   Fallidas: ${result.data?.failedInvites || 0}`);
  
  if (result.data?.results) {
    result.data.results.forEach(result => {
      const status = result.success ? '✅' : '❌';
      console.log(`   ${status} ${result.email}`);
    });
  }
}

/**
 * Ejemplo con manejo de errores
 */
async function inviteWithErrorHandling() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/teamMembers/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'x-api-secret': API_SECRET
      },
      body: JSON.stringify({
        siteName: 'Proyecto Beta',
        teamMembers: [
          {
            email: 'test@example.com',
            name: 'Usuario Test',
            role: 'view',
            position: 'Tester'
          }
        ]
      })
    });

    const result = await response.json();

    switch (response.status) {
      case 200:
        console.log('🎉 Todas las invitaciones enviadas exitosamente');
        break;
      case 207:
        console.log('⚠️ Algunas invitaciones fallaron');
        console.log('Exitosas:', result.data?.successfulInvites);
        console.log('Fallidas:', result.data?.failedInvites);
        break;
      case 400:
        console.log('❌ Error de validación:');
        if (result.errors) {
          result.errors.forEach(error => console.log(`   - ${error}`));
        }
        break;
      case 401:
        console.log('🔐 Error de autenticación:', result.message);
        break;
      case 500:
        console.log('💥 Error del servidor:', result.message);
        break;
      default:
        console.log('🤔 Respuesta inesperada:', response.status, result);
    }

  } catch (error) {
    console.error('💣 Error de red o parsing:', error);
  }
}

/**
 * Función utilitaria para validar emails antes de enviar
 */
function validateEmailFormat(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Función utilitaria para validar roles
 */
function validateRole(role) {
  const validRoles = ['view', 'create', 'delete', 'admin'];
  return validRoles.includes(role);
}

/**
 * Ejemplo con validación previa
 */
async function inviteWithValidation() {
  const teamMembers = [
    {
      email: 'valid@example.com',
      name: 'Usuario Válido',
      role: 'create',
      position: 'Developer'
    },
    {
      email: 'invalid-email', // Email inválido para demostración
      name: 'Usuario Inválido',
      role: 'invalid-role', // Rol inválido para demostración
      position: 'Tester'
    }
  ];

  // Validar antes de enviar
  const validationErrors = [];
  
  teamMembers.forEach((member, index) => {
    if (!validateEmailFormat(member.email)) {
      validationErrors.push(`Member ${index + 1}: Invalid email format`);
    }
    
    if (!validateRole(member.role)) {
      validationErrors.push(`Member ${index + 1}: Invalid role`);
    }
    
    if (!member.name || member.name.trim() === '') {
      validationErrors.push(`Member ${index + 1}: Name is required`);
    }
    
    if (!member.position || member.position.trim() === '') {
      validationErrors.push(`Member ${index + 1}: Position is required`);
    }
  });

  if (validationErrors.length > 0) {
    console.log('❌ Errores de validación detectados:');
    validationErrors.forEach(error => console.log(`   - ${error}`));
    return;
  }

  // Si las validaciones pasan, proceder con el envío
  console.log('✅ Validaciones pasadas, enviando invitaciones...');
  await inviteMultipleMembers();
}

/**
 * Obtener información sobre la API
 */
async function getApiInfo() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/teamMembers/invite`, {
      method: 'GET'
    });

    const info = await response.json();
    console.log('📋 Información de la API:', info);
    
  } catch (error) {
    console.error('Error obteniendo información de la API:', error);
  }
}

// Ejemplos de ejecución
console.log('🚀 Ejemplos del API de Invitaciones de Equipo\n');

// Descomentar las funciones que quieras probar:

// getApiInfo();
// inviteSingleMember();
// inviteMultipleMembers();
// inviteWithErrorHandling();
// inviteWithValidation();

/**
 * Notas sobre el diseño del email:
 * 
 * - Asunto: "You're invited to join {siteName} on {COMPANY_NAME}" (configurable)
 * - Diseño profesional con gradiente púrpura
 * - Call-to-action: "Join Team" que redirige a {APP_URL}/signup (configurable)
 * - Información del equipo: nombre del proyecto, rol, posición
 * - Colores distintivos por rol:
 *   - view: Verde
 *   - create: Azul  
 *   - delete: Naranja
 *   - admin: Púrpura
 * 
 * Variables de entorno configurables:
 * - UNCODIE_COMPANY_NAME: Nombre de la compañía (default: "Uncodie")
 * - UNCODIE_BRANDING_TEXT: Texto de branding (default: "Uncodie, your AI Sales Team")
 * - UNCODIE_COMPANY_TAGLINE: Tagline de la compañía (default: "AI-powered team collaboration")
 * - UNCODIE_SUPPORT_EMAIL: Email de soporte (default: "support@uncodie.com")
 * - NEXT_PUBLIC_APP_URL: URL base de la aplicación (default: "https://app.uncodie.com")
 */ 