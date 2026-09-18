# ScreenshotMachine API - Guía Completa

## 📸 **¿Qué es ScreenshotMachine?**

[ScreenshotMachine](https://screenshotmachine.com/) es una API robusta para capturar screenshots de sitios web con múltiples opciones de configuración avanzadas.

## 🚀 **Configuración Rápida**

### **1. Obtener API Key**
1. Ve a https://screenshotmachine.com/
2. Regístrate o inicia sesión
3. Obtén tu API key del dashboard

### **2. Configurar en tu proyecto**
Añade a tu `.env.local`:
```bash
SCREENSHOTMACHINE_API_KEY=tu_api_key_aqui
```

### **3. Desarrollo**
Usa una API key propia y guárdala únicamente en el entorno local o en el
gestor de secretos del deployment. No publiques credenciales compartidas en
la documentación.

## 🛠️ **Configuración Actual en el Código**

El sistema usa una estrategia de dos intentos para obtener screenshots óptimos:

### **Intento 1: Full-Page Screenshot (Recomendado)**
```typescript
const apiUrl = `https://api.screenshotmachine.com/?key=${process.env.SCREENSHOTMACHINE_API_KEY}&url=${encodeURIComponent(url)}&dimension=1200xfull&format=jpg&device=desktop&delay=3000&cacheLimit=1`;
```

### **Intento 2: Proporción 1:2 (Fallback)**
```typescript
const apiUrl = `https://api.screenshotmachine.com/?key=${process.env.SCREENSHOTMACHINE_API_KEY}&url=${encodeURIComponent(url)}&dimension=1200x2400&format=jpg&device=desktop&delay=3000&cacheLimit=1`;
```

### **Explicación de Parámetros**
- `key`: Tu API key
- `url`: URL del sitio a capturar (URL-encoded)
- `dimension`: 
  - `1200xfull`: Ancho 1200px, altura completa del sitio (captura todo)
  - `1200x2400`: Proporción 1:2 para capturar más contenido (fallback)
- `format=jpg`: Formato de imagen (jpg, png, gif)
- `device=desktop`: Tipo de dispositivo (desktop, phone, tablet)
- `delay=3000`: Espera 3 segundos antes de capturar (mejorado para carga completa)
- `cacheLimit=1`: Usar cache si la imagen tiene menos de 1 día

## ⚙️ **Configuraciones Avanzadas Disponibles**

### **Dimensiones**
```
320x240    - Thumbnail pequeño
800x600    - Tamaño estándar
1024x768   - Tamaño desktop
1920x1080  - Full HD
1024xfull  - Página completa (puede ser muy largo)
```

### **Dispositivos**
```
device=desktop  - Vista desktop (por defecto)
device=phone    - Vista móvil
device=tablet   - Vista tablet
```

### **Formatos**
```
format=jpg  - JPEG (por defecto, menor tamaño)
format=png  - PNG (mejor calidad)
format=gif  - GIF (para animaciones)
```

### **Gestión de Cache**
```
cacheLimit=0      - Nunca usar cache (siempre fresco)
cacheLimit=1      - Cache máximo 1 día
cacheLimit=0.042  - Cache máximo 1 hora (1/24 = 0.042)
```

### **Delays**
```
delay=0     - Capturar inmediatamente
delay=2000  - Esperar 2 segundos (recomendado)
delay=5000  - Esperar 5 segundos (sitios lentos)
```

## 🎛️ **Funciones Avanzadas**

### **Ocultar Elementos**
```
hide=.cookie-banner              - Ocultar banners de cookies
hide=#popup                      - Ocultar popup específico
hide=.ad-banner1,.ad-banner2     - Ocultar múltiples elementos
```

### **Hacer Click**
```
click=.accept-cookies  - Hacer click en botón de aceptar cookies
click=#close-popup     - Cerrar popup antes de capturar
```

### **Zoom**
```
zoom=100  - Tamaño normal (por defecto)
zoom=200  - 2x zoom (para screenshots "retina")
zoom=50   - 50% del tamaño
```

### **Idioma y User Agent**
```
accept-language=es-ES                    - Contenido en español
user-agent=Mozilla/5.0%20(iPhone...)     - Simular iPhone
```

## 💡 **Ejemplos de Uso**

### **Screenshot Básico**
```
https://api.screenshotmachine.com/?key=YOUR_API_KEY&url=google.com&dimension=1024x768
```

### **Screenshot Móvil**
```
https://api.screenshotmachine.com/?key=YOUR_API_KEY&url=google.com&dimension=480x800&device=phone
```

### **Screenshot sin Cookies**
```
https://api.screenshotmachine.com/?key=YOUR_API_KEY&url=google.com&dimension=1200x800&hide=.cookie-banner&click=.accept-all
```

### **Screenshot de Alta Calidad**
```
https://api.screenshotmachine.com/?key=YOUR_API_KEY&url=google.com&dimension=1920x1080&format=png&zoom=200&delay=3000
```

## 🔧 **Personalizar la Implementación**

Si quieres modificar los parámetros por defecto, puedes crear una función personalizada:

```typescript
async function captureScreenshotMachine(url: string, options?: {
  dimension?: string;
  format?: 'jpg' | 'png' | 'gif';
  device?: 'desktop' | 'phone' | 'tablet';
  delay?: number;
  zoom?: number;
  hide?: string;
  click?: string;
}): Promise<string> {
  const params = new URLSearchParams({
    key: process.env.SCREENSHOTMACHINE_API_KEY!,
    url: url,
    dimension: options?.dimension || '1200x800',
    format: options?.format || 'jpg',
    device: options?.device || 'desktop',
    delay: options?.delay?.toString() || '2000',
    cacheLimit: '1'
  });

  if (options?.zoom) params.append('zoom', options.zoom.toString());
  if (options?.hide) params.append('hide', options.hide);
  if (options?.click) params.append('click', options.click);

  const apiUrl = `https://api.screenshotmachine.com/?${params.toString()}`;
  
  const response = await fetch(apiUrl);
  if (response.ok) {
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return `data:image/${options?.format || 'jpg'};base64,${base64}`;
  }
  
  throw new Error(`Screenshot failed: ${response.status}`);
}
```

## 🔒 **Seguridad con Hash**

Para sitios públicos, puedes usar el parámetro `hash` para proteger tu API key:

```php
$url = "http://www.google.com";
$secret = "MI_FRASE_SECRETA";
$hash = md5($url.$secret);
```

Entonces usar: `&hash=${hash}` en la URL de la API.

## 📊 **Límites y Precios**

- Consulta el dashboard y la documentación vigente del proveedor.
- Los límites y precios varían según el plan contratado.

## 🐛 **Debugging**

Para debugging, revisa los logs en consola:
```
✅ Screenshot full-page generado con ScreenshotMachine
✅ Screenshot 1:2 generado con ScreenshotMachine
❌ Error con ScreenshotMachine full-page: 401 Unauthorized
❌ Error con ScreenshotMachine 1:2: Invalid API key
⚠️ Error con ScreenshotMachine: Timeout
```

### **Interpretación de Logs**
- **full-page**: Se capturó toda la página (ideal)
- **1:2**: Se usó proporción 1:2 como fallback
- **401**: API key inválida o expirada
- **Timeout**: La página tardó demasiado en cargar

## 📚 **Recursos Adicionales**

- **Documentación oficial**: https://screenshotmachine.com/apidoc.php
- **Registro**: https://screenshotmachine.com/register.php
- **Soporte**: https://screenshotmachine.com/contact.php

---

**Nota**: Esta implementación está configurada como la primera opción en el sistema. Si ScreenshotMachine falla, el sistema automáticamente intentará con ScreenshotLayer, ScreenshotsCloud, y finalmente thum.io como fallback. 