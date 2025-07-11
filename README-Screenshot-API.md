# API de Screenshot - Solución al Error "Wrong API Key"

## 🚨 **Problema**

Si ves el error "wrong api key" al generar screenshots, es porque el sistema está tratando de usar APIs externas para capturar imágenes de sitios web, pero las API keys no están configuradas correctamente.

## 🔧 **Solución Rápida**

### **Opción 1: ScreenshotMachine (Recomendada)**

1. **Regístrate**: Ve a https://screenshotmachine.com/
2. **Obtén tu API Key**: Después del registro, copia tu API key
3. **Configura**: Añade a tu `.env.local`:
   ```bash
   SCREENSHOTMACHINE_API_KEY=tu_api_key_aqui
   ```

### **Opción 2: ScreenshotLayer (Alternativa)**

1. **Regístrate**: Ve a https://screenshotlayer.com/
2. **Plan Gratuito**: 100 screenshots/mes gratis
3. **Obtén tu API Key**: Después del registro, copia tu `access_key`
4. **Configura**: Añade a tu `.env.local`:
   ```bash
   SCREENSHOTLAYER_API_KEY=tu_api_key_aqui
   ```

### **Opción 3: ScreenshotsCloud (Más Generosa)**

1. **Regístrate**: Ve a https://screenshots.cloud/
2. **Plan Gratuito**: 8,500 screenshots/mes gratis
3. **Obtén tus credenciales**: Después del registro, copia tu `key` y `secret`
4. **Configura**: Añade a tu `.env.local`:
   ```bash
   SCREENSHOTSCLOUD_KEY=tu_key_aqui
   SCREENSHOTSCLOUD_SECRET=tu_secret_aqui
   ```

## 📋 **Comparación de Opciones**

| Servicio | Plan Gratuito | Precio Pagado | Registro |
|----------|---------------|---------------|----------|
| **ScreenshotMachine** | Limitado | Desde $39/mes | https://screenshotmachine.com/ |
| **ScreenshotLayer** | 100/mes | $19.99/mes (10k) | https://screenshotlayer.com/ |
| **ScreenshotsCloud** | 8,500/mes | $29/mes (8.5k) | https://screenshots.cloud/ |

## 🛠️ **Configuración Completa**

### **1. Variables de Entorno**

Crea/edita tu archivo `.env.local`:

```bash
# APIs de Screenshot (configurar al menos una)
SCREENSHOTMACHINE_API_KEY=tu_screenshotmachine_api_key
SCREENSHOTLAYER_API_KEY=tu_screenshotlayer_api_key
SCREENSHOTSCLOUD_KEY=tu_screenshotscloud_key
SCREENSHOTSCLOUD_SECRET=tu_screenshotscloud_secret
```

### **2. Prioridad de Uso**

El sistema intentará usar las APIs en este orden:
1. **ScreenshotMachine** (si está configurada)
2. **ScreenshotLayer** (si está configurada)
3. **ScreenshotsCloud** (si está configurada)
4. **thum.io** (gratuita como fallback)
5. **Placeholder** (imagen por defecto si todo falla)

### **3. Reiniciar el Servidor**

Después de configurar las variables de entorno:

```bash
# Detener el servidor
Ctrl + C

# Reiniciar
npm run dev
```

## 🎯 **Recomendación**

**Para desarrollo**: Usa **ScreenshotMachine** con la API key proporcionada (68f26b)
**Para producción**: Registra tu propia cuenta en ScreenshotMachine o evalúa otras opciones según tu volumen

## 🔍 **Verificar que Funciona**

1. **Revisa los logs**: Deberías ver mensajes como:
   ```
   ✅ Screenshot generado con ScreenshotMachine
   ```
   
2. **Prueba el endpoint**: Haz una solicitud al endpoint UX Analysis y verifica que no aparezca el error "wrong api key"

## 🆘 **Solución Temporal**

Si no puedes configurar una API key ahora mismo, el sistema usará un placeholder (imagen por defecto) hasta que configures una API válida.

## 📞 **Soporte**

Si sigues teniendo problemas después de configurar las API keys:
1. Verifica que las variables de entorno estén bien escritas
2. Reinicia el servidor completamente
3. Revisa los logs para ver qué servicio está intentando usar

---

**Nota**: Este error solo aparece en la funcionalidad de screenshots, no afecta al análisis de texto ni a otras funcionalidades de la aplicación. 