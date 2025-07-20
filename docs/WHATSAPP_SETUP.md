# Configuración de WhatsApp Content Templates

## 🚨 Problema Común: Error 63016

Si ves este error:
```
Failed to send freeform message because you are outside the allowed window. If you are using WhatsApp, please use a Message Template.
```

**Causa**: Los Content Templates para WhatsApp **requieren un Messaging Service** configurado.

## ✅ Solución

### Paso 1: Crear Messaging Service en Twilio

1. **Ir a Twilio Console** → **Messaging** → **Services**
2. **Create Messaging Service** 
3. **Nombre**: "WhatsApp Content Templates"
4. **Use Case**: "Notify my users"

### Paso 2: Agregar Sender al Messaging Service

1. **Add Senders** → **WhatsApp sender**
2. **Seleccionar tu número de WhatsApp**
3. **Save Configuration**

### Paso 3: Configurar en tu Aplicación

Agregar a tu archivo `.env`:

```bash
# REQUERIDO para Content Templates de WhatsApp
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**¿Dónde encontrar el SID?**
- Twilio Console → Messaging → Services → Tu servicio → **Service SID**

### Paso 4: Verificar Configuración

Una vez configurado, los logs mostrarán:

```
✅ [WhatsAppTemplateService] Messaging Service desde env: MGxxxxxxxxx
📋 [WhatsAppTemplateService] Usando Messaging Service: MGxxxxxxxxx
✅ [WhatsAppTemplateService] Mensaje enviado con Content Template
```

## 🔧 Solución Alternativa (Sin Messaging Service)

Si no puedes configurar Messaging Service inmediatamente:

1. **Opción A**: Crear templates manualmente en Meta Business Manager
2. **Opción B**: Mantener conversaciones dentro de ventana de 24h
3. **Opción C**: Usar mensajes regulares y aceptar fallos fuera de ventana

## 📊 Verificación

### ✅ Configuración Correcta:
```
templateUsed: true
templateSid: "HXxxxxxxxxx"
withinWindow: false
status: "sent" ← El mensaje se envía exitosamente
```

### ❌ Configuración Incorrecta:
```
templateUsed: true  
templateSid: "HXxxxxxxxxx"
withinWindow: false
ERROR: "Failed to send freeform message because you are outside the allowed window"
```

## 🎯 Beneficios del Messaging Service

1. **Cumplimiento automático** con políticas de WhatsApp
2. **Content Templates funcionan** correctamente
3. **Fallback automático** entre canales
4. **Mejor deliverability** de mensajes
5. **Métricas centralizadas** en Twilio

## 🆘 Troubleshooting

### Error: "MessagingServiceSid is required"
- Verificar que `TWILIO_MESSAGING_SERVICE_SID` esté en `.env`
- Reiniciar el servidor después de agregar la variable

### Error: "Invalid MessagingServiceSid"  
- Verificar que el SID empiece con `MG`
- Verificar que el Messaging Service exista en tu cuenta

### Content Template se crea pero no se usa
- Verificar Messaging Service configurado
- Verificar que el número de WhatsApp esté agregado al service

## 📝 Documentación Adicional

- [Twilio Messaging Services](https://www.twilio.com/docs/messaging/services)
- [WhatsApp Content Templates](https://www.twilio.com/docs/content)
- [Error Codes de WhatsApp](https://www.twilio.com/docs/api/errors) 