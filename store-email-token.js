/**
 * Script para almacenar un nuevo token de email en secure_tokens
 * 
 * Uso: node store-email-token.js <correo> <contraseña> <site_id>
 */
import { request as httpRequest } from 'http';
import { URL } from 'url';

// Procesando argumentos de línea de comandos
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Uso: node store-email-token.js <correo> <contraseña> [site_id]');
  console.error('  <correo>: Dirección de correo (p.ej. usuario@gmail.com)');
  console.error('  <contraseña>: Contraseña o contraseña de aplicación');
  console.error('  [site_id]: (Opcional) ID del sitio (si no se proporciona, se usa el valor por defecto)');
  process.exit(1);
}

// Extraer argumentos
const email = args[0];
const password = args[1];
const siteId = args[2] || 'f87bdc7f-0efe-4aa5-b499-49d85be4b154'; // Usar el ID por defecto si no se proporciona

// Validaciones básicas
if (!email.includes('@')) {
  console.error('Error: El correo electrónico debe contener @');
  process.exit(1);
}

if (password.length < 6) {
  console.error('Advertencia: La contraseña es muy corta, asegúrate de que sea correcta');
}

// Crear el token
const tokenValue = JSON.stringify({
  email,
  password,
  host: 'imap.gmail.com',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  tls: true
});

console.log(`Almacenando token para email: ${email}`);
console.log(`Site ID: ${siteId}`);
console.log(`Datos del token (la contraseña está oculta por seguridad):`);
const safeToken = { ...JSON.parse(tokenValue), password: '******' };
console.log(JSON.stringify(safeToken, null, 2));

// Confirmar antes de continuar
console.log('\n¿Estás seguro de que deseas almacenar este token? (s/n)');
process.stdin.once('data', async (data) => {
  const input = data.toString().trim().toLowerCase();
  
  if (input !== 's' && input !== 'y' && input !== 'yes' && input !== 'si') {
    console.log('Operación cancelada');
    process.exit(0);
  }
  
  // Solicitud para almacenar el token
  const apiHost = 'localhost';
  const apiPort = 3000;
  const apiPath = '/api/secure-tokens';
  
  // Payload para la solicitud
  const payload = JSON.stringify({
    operation: 'store',
    siteId,
    tokenType: 'email',
    tokenValue,
    identifier: email
  });
  
  // Realizar la solicitud utilizando el módulo http nativo
  console.log(`Enviando solicitud a http://${apiHost}:${apiPort}${apiPath}...`);
  
  const options = {
    hostname: apiHost,
    port: apiPort,
    path: apiPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  
  const req = httpRequest(options, (res) => {
    let responseData = '';
    
    // A chunks of data has been received
    res.on('data', (chunk) => {
      responseData += chunk;
    });
    
    // The whole response has been received
    res.on('end', () => {
      try {
        const result = JSON.parse(responseData);
        
        if (result.success) {
          console.log('\n✅ Token almacenado exitosamente');
          console.log(`ID del token: ${result.tokenId || 'No disponible'}`);
          console.log('\n¡Completado! Ya puedes probar el API de email con el token guardado.');
        } else {
          console.error('\n❌ Error al almacenar el token:');
          console.error(result.error || 'Error desconocido');
          process.exit(1);
        }
      } catch (error) {
        console.error('\n❌ Error al procesar la respuesta:');
        console.error('Respuesta recibida:', responseData);
        console.error('Error:', error);
        process.exit(1);
      }
    });
  });
  
  req.on('error', (error) => {
    console.error('\n❌ Error al comunicarse con el API:', error);
    process.exit(1);
  });
  
  // Write data to request body
  req.write(payload);
  req.end();
}); 