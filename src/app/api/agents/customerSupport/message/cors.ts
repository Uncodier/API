
// Función auxiliar para manejar CORS
export function corsHeaders(request: Request) {
  // Obtener el origen de la solicitud
  const origin = request.headers.get('origin') || '*';
  
  // Debug para identificar el origen exacto
  console.log(`[CORS-HEADERS] Setting Access-Control-Allow-Origin to: ${origin}`);
  
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}
