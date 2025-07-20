# WhatsApp Templates y Ventana de Respuesta

Esta nueva funcionalidad maneja automáticamente la **ventana de respuesta de 24 horas** de WhatsApp Business API, creando y usando templates de Twilio cuando es necesario.

## 🎯 Problema que Resuelve

WhatsApp Business API tiene una **ventana de respuesta de 24 horas**:
- ✅ **Dentro de 24 horas**: Puedes enviar mensajes libres después del último mensaje del usuario
- ❌ **Fuera de 24 horas**: Solo puedes enviar templates pre-aprobados por WhatsApp

## 🚀 Solución Implementada

### Detección Automática
El sistema automáticamente:
1. **Detecta conversaciones nuevas** → Fuera de ventana (requiere template)
2. **Calcula tiempo transcurrido** desde el último mensaje del usuario
3. **Decide el método de envío** basado en la ventana de respuesta

### Creación Automática de Content Templates
- 🔍 **Busca Content Templates similares** existentes para reutilizar  
- 🆕 **Crea Content Templates automáticamente** usando Twilio Content API
- 📊 **Guarda referencia** en base de datos para uso futuro
- ♻️ **Reutiliza templates** existentes para mensajes similares (80% de similitud)
- ⚡ **Funciona inmediatamente** sin necesidad de aprobación manual

### Fallback Inteligente
- Si falla la creación del template → Envía mensaje regular
- Si falla el envío con template → Intenta mensaje regular
- Siempre mantiene la funcionalidad básica

## 📋 Cómo Funciona

### 1. Verificación de Ventana
```typescript
const windowCheck = await WhatsAppTemplateService.checkResponseWindow(
  conversation_id,
  phoneNumber,
  site_id
);

// Resultado:
// {
//   withinWindow: boolean,
//   lastMessageTime?: Date,
//   hoursElapsed?: number
// }
```

### 2. Decisión de Envío
```typescript
if (!windowCheck.withinWindow) {
  // FUERA DE VENTANA → Usar Content Template automático
  - Buscar Content Template similar existente
  - Si existe: usar template existente 
  - Si no existe: crear Content Template automáticamente
  - Enviar mensaje con Content Template
} else {
  // DENTRO DE VENTANA → Mensaje regular
  - Enviar mensaje normal (siempre funciona)
}
```

### 3. Respuesta Enriquecida
```typescript
// La respuesta ahora incluye:
{
  success: true,
  message_id: "SM123...",
  template_used: boolean,           // ¿Se usó template?
  template_sid: "HT456...",         // SID del template usado
  within_response_window: boolean,   // ¿Dentro de ventana?
  hours_elapsed: 48.5               // Horas transcurridas
}
```

## 🗄️ Base de Datos

### Tabla: `whatsapp_templates`
```sql
CREATE TABLE whatsapp_templates (
    id UUID PRIMARY KEY,
    template_sid TEXT UNIQUE NOT NULL,     -- SID de Twilio
    template_name TEXT NOT NULL,           -- Nombre del template
    content TEXT NOT NULL,                 -- Contenido procesado
    original_message TEXT,                 -- Mensaje original
    site_id UUID NOT NULL,                -- Sitio asociado
    account_sid TEXT NOT NULL,             -- Account SID de Twilio
    status TEXT DEFAULT 'active',          -- Estado del template
    usage_count INTEGER DEFAULT 0,         -- Veces usado
    last_used TIMESTAMP,                   -- Última vez usado
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Funciones Auxiliares
- `increment_template_usage(template_sid)` - Incrementa contador de uso
- `update_whatsapp_templates_updated_at()` - Actualiza timestamp automáticamente

## 🛠️ Servicios

### WhatsAppTemplateService
```typescript
// Verificar ventana de respuesta
checkResponseWindow(conversationId, phoneNumber, siteId)

// Buscar template existente
findExistingTemplate(message, siteId, accountSid)

// Crear nuevo template
createTemplate(message, accountSid, authToken, siteId)

// Enviar con template
sendMessageWithTemplate(phoneNumber, templateSid, ...)
```

### WhatsAppSendService (Modificado)
- ✅ Mantiene funcionalidad original
- ➕ Agrega detección de ventana automática
- ➕ Usa templates cuando es necesario
- ➕ Incluye información adicional en respuesta

## 📈 Monitoreo y Logs

### Logs Detallados
```
🕐 [WhatsAppTemplateService] Verificando ventana de respuesta...
⏰ [WhatsAppSendService] Resultado de ventana: {withinWindow: false, hoursElapsed: 48.2}
📝 [WhatsAppSendService] Fuera de ventana de respuesta, usando template...
♻️ [WhatsAppSendService] Usando template existente: HT123...
✅ [WhatsAppSendService] Mensaje enviado con template exitosamente
```

### Endpoint Response
```json
{
  "success": true,
  "message_id": "SM1234567890",
  "recipient": "+1234567890",
  "template_used": true,
  "template_sid": "HT0987654321",
  "within_response_window": false,
  "hours_elapsed": 48.2,
  "status": "sent"
}
```

## 🔧 Configuración

### Variables de Entorno
```bash
# Configuración existente de WhatsApp/Twilio
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_API_TOKEN=your_whatsapp_api_token

# Configuración de encriptación (para secure_tokens)
ENCRYPTION_KEY=your_encryption_key
```

### Settings en Base de Datos
```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "account_sid": "AC123...",
      "existingNumber": "+1234567890"
    }
  }
}
```

## 📊 Beneficios

### 1. Cumplimiento Automático
- ✅ Nunca viola las políticas de WhatsApp
- ✅ Maneja automáticamente la ventana de respuesta
- ✅ No requiere intervención manual

### 2. Eficiencia
- ♻️ Reutiliza templates existentes
- 📈 Mejora con el tiempo (más templates = mejor cobertura)
- 🔄 Fallback automático si algo falla

### 3. Transparencia
- 📊 Logs detallados de cada decisión
- 📈 Métricas de uso de templates
- 🔍 Información completa en respuestas

### 4. Flexibilidad
- 🎛️ Funciona con configuración existente
- 🔧 No requiere cambios en código cliente
- 📱 Compatible con números temporales de prueba

## 🚨 Consideraciones

### Content Templates de Twilio (Solución Implementada)
- ✅ **SÍ se pueden crear automáticamente** via Content API
- ⚡ **Funcionan inmediatamente** sin aprobación manual
- 🔄 **Reutilización inteligente** de templates similares
- 📊 **Sin límites prácticos** de templates por cuenta
- 🎯 **Ideal para mensajes fuera de ventana de respuesta**

### Diferencias con WhatsApp Business API Templates
- **Content Templates**: Creación automática, uso inmediato
- **WhatsApp Templates**: Requieren aprobación manual de Meta
- **Recomendación**: Usar Content Templates para automatización

### Rendimiento
- La verificación de ventana agrega ~100ms al tiempo de respuesta
- Los templates se almacenan localmente para velocidad
- La creación de templates puede tomar 1-2 segundos

### Costos
- Templates pueden tener costos diferentes a mensajes regulares
- Consultar pricing de Twilio para templates de WhatsApp

## 🧪 Testing

### Casos de Prueba

1. **Conversación Nueva** → Debe usar template
2. **Mensaje Reciente (< 24h)** → Mensaje regular
3. **Mensaje Antiguo (> 24h)** → Debe usar template
4. **Template Existente** → Debe reutilizar
5. **Error de Template** → Fallback a mensaje regular

### Números de Prueba
```typescript
// Estos números no envían mensajes reales
const testNumbers = [
  'no-phone-example',
  '+00000000000'
];
```

## 🔮 Futuras Mejoras

1. **Machine Learning**: Mejorar detección de similitud de mensajes
2. **Cache**: Cache de templates frecuentes
3. **Analytics**: Dashboard de uso de templates
4. **Optimización**: Reducir latencia de verificación
5. **Templates Personalizados**: Interface para crear templates manualmente 