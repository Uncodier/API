// Este script prueba la API manualmente

async function testWebSocketAPI() {
  console.log('Iniciando prueba de la API WebSocket...');
  
  // Probar la respuesta HTTP (fallback)
  try {
    const response = await fetch('http://localhost:3001/api/agents/chat/websocket', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        visitor_id: 'b905bb87-e1fd-49d4-981d-4206015386ef',
        site_id: '9be0a6a2-5567-41bf-ad06-cb4014f0faf2'
      }),
    });
    
    const data = await response.json();
    console.log('Respuesta HTTP recibida:', data);
    
    if (data.success) {
      console.log('✅ API HTTP funciona correctamente');
    } else {
      console.log('❌ Error en la API HTTP:', data.error);
    }
  } catch (error) {
    console.error('Error al probar la API HTTP:', error);
  }
  
  // No podemos probar WebSocket real desde Node.js fácilmente, pero podemos verificar que la ruta existe
  console.log('\nPrueba completada. Para probar WebSocket real, abre un navegador y usa:');
  console.log(`
  const socket = new WebSocket('ws://localhost:3001/api/agents/chat/websocket?visitor_id=b905bb87-e1fd-49d4-981d-4206015386ef&site_id=9be0a6a2-5567-41bf-ad06-cb4014f0faf2');
  
  socket.addEventListener('open', (event) => {
    console.log('Conexión establecida');
  });
  
  socket.addEventListener('message', (event) => {
    console.log('Mensaje recibido:', JSON.parse(event.data));
  });
  
  socket.addEventListener('close', (event) => {
    console.log('Conexión cerrada:', event);
  });
  
  socket.addEventListener('error', (event) => {
    console.error('Error en la conexión:', event);
  });
  `);
}

testWebSocketAPI(); 