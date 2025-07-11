// Utilidades para el manejo de imágenes y capturas de pantalla
import puppeteer from 'puppeteer';

/**
 * Prepara una imagen para enviar a la API
 * Acepta tanto URLs como imágenes base64
 */
export function prepareImageForAPI(imageData: string | undefined): string | undefined {
  if (!imageData) {
    console.warn('[prepareImageForAPI] No se proporcionaron datos de imagen para procesar');
    return undefined;
  }
  
  console.log(`[prepareImageForAPI] Preparando imagen de ${imageData.length} caracteres`);
  
  // Si ya es una URL, la pasamos directamente
  if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
    console.log('[prepareImageForAPI] La imagen ya es una URL, no requiere preparación');
    return imageData;
  }
  
  try {
    // Verificar si ya es un data URI de imagen
    if (imageData.startsWith('data:image/')) {
      // Validamos que el formato general es correcto
      const base64Match = imageData.match(/^data:image\/([^;]+);base64,(.+)$/);
      if (base64Match && base64Match[2]) {
        const mimeType = base64Match[1]; // Extraer el tipo MIME (jpeg, png, etc.)
        const base64Data = base64Match[2];
        
        // Verificamos básicamente que hay contenido
        if (base64Data.length < 100) {
          console.warn('[prepareImageForAPI] Los datos base64 son demasiado pequeños para ser una imagen válida');
          return undefined;
        }
        
        // Verificar que el tipo MIME coincide con el contenido real
        try {
          const buffer = Buffer.from(base64Data, 'base64');
          const firstBytes = buffer.slice(0, 4);
          
          // Verificar si el tipo MIME declarado coincide con la firma de bytes
          let detectedMimeType = '';
          if (firstBytes[0] === 0xFF && firstBytes[1] === 0xD8) {
            detectedMimeType = 'jpeg';
          } else if (
            firstBytes[0] === 0x89 && 
            firstBytes[1] === 0x50 && 
            firstBytes[2] === 0x4E && 
            firstBytes[3] === 0x47
          ) {
            detectedMimeType = 'png';
          } else if (
            firstBytes[0] === 0x47 && 
            firstBytes[1] === 0x49 && 
            firstBytes[2] === 0x46
          ) {
            detectedMimeType = 'gif';
          }
          
          // Si detectamos un tipo MIME y es diferente al declarado, corregirlo
          if (detectedMimeType && detectedMimeType !== mimeType) {
            console.log(`[prepareImageForAPI] Corrigiendo tipo MIME: ${mimeType} -> ${detectedMimeType}`);
            return `data:image/${detectedMimeType};base64,${base64Data}`;
          }
        } catch (e) {
          console.warn(`[prepareImageForAPI] Error al verificar el tipo MIME: ${e}`);
        }
        
        // IMPORTANTE: Asegurarnos de que el formato es correcto para Claude
        console.log(`[prepareImageForAPI] Data URI válido detectado (${base64Data.length} bytes).`);
        return imageData;
      } else {
        console.warn('[prepareImageForAPI] La imagen tiene formato data URI pero no se pudo extraer el contenido base64');
        return undefined;
      }
    } 
    // Si es base64 sin el prefijo data:image
    else {
      // Verificar que los datos parecen ser base64 válido
      try {
        // Intentamos decodificar para verificar que es base64 válido
        const testBuffer = Buffer.from(imageData, 'base64');
        if (testBuffer.length < 100) {
          console.warn('[prepareImageForAPI] Los datos base64 son demasiado pequeños para ser una imagen válida');
          return undefined;
        }
        
        // Detectar el tipo de imagen basado en los primeros bytes
        let mimeType = 'image/png'; // Por defecto
        
        // Verificar firmas comunes de formatos de imagen
        const firstBytes = testBuffer.slice(0, 4);
        if (firstBytes[0] === 0xFF && firstBytes[1] === 0xD8) {
          mimeType = 'image/jpeg';
        } else if (
          firstBytes[0] === 0x89 && 
          firstBytes[1] === 0x50 && 
          firstBytes[2] === 0x4E && 
          firstBytes[3] === 0x47
        ) {
          mimeType = 'image/png';
        } else if (
          firstBytes[0] === 0x47 && 
          firstBytes[1] === 0x49 && 
          firstBytes[2] === 0x46
        ) {
          mimeType = 'image/gif';
        }
        
        // Crear un data URI completo
        console.log(`[prepareImageForAPI] Creando data URI con tipo MIME ${mimeType}`);
        return `data:${mimeType};base64,${imageData}`;
      } catch (e) {
        console.error(`[prepareImageForAPI] Error al procesar datos base64: ${e}`);
        return undefined;
      }
    }
  } catch (error) {
    console.error(`[prepareImageForAPI] Error al preparar la imagen: ${error}`);
    return undefined;
  }
}

/**
 * Valida si una imagen es adecuada para enviar a la API de visión
 */
export function validateImageForVision(imageData: string | undefined): boolean {
  if (!imageData) {
    console.warn('[validateImageForVision] No se proporcionaron datos de imagen para validar');
    return false;
  }
  
  // Si es una URL, asumimos que es válida
  if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
    return true;
  }
  
  // Verificar si es un data URI de imagen
  if (imageData.startsWith('data:image/')) {
    const base64Match = imageData.match(/^data:image\/([^;]+);base64,(.+)$/);
    if (base64Match && base64Match[2]) {
      const mimeType = base64Match[1]; // Extraer el tipo MIME (jpeg, png, etc.)
      const base64Data = base64Match[2];
      
      // Verificar tamaño mínimo
      if (base64Data.length < 100) {
        console.warn('[validateImageForVision] Los datos base64 son demasiado pequeños para ser una imagen válida');
        return false;
      }
      
      // Verificar que el tipo MIME coincide con los primeros bytes
      try {
        const buffer = Buffer.from(base64Data, 'base64');
        const firstBytes = buffer.slice(0, 4);
        
        // Verificar si el tipo MIME declarado coincide con la firma de bytes
        if (mimeType === 'jpeg' && !(firstBytes[0] === 0xFF && firstBytes[1] === 0xD8)) {
          console.warn('[validateImageForVision] El tipo MIME jpeg no coincide con la firma de bytes');
          return false;
        } else if (mimeType === 'png' && !(
          firstBytes[0] === 0x89 && 
          firstBytes[1] === 0x50 && 
          firstBytes[2] === 0x4E && 
          firstBytes[3] === 0x47
        )) {
          console.warn('[validateImageForVision] El tipo MIME png no coincide con la firma de bytes');
          return false;
        } else if (mimeType === 'gif' && !(
          firstBytes[0] === 0x47 && 
          firstBytes[1] === 0x49 && 
          firstBytes[2] === 0x46
        )) {
          console.warn('[validateImageForVision] El tipo MIME gif no coincide con la firma de bytes');
          return false;
        }
      } catch (e) {
        console.error(`[validateImageForVision] Error al validar el tipo MIME: ${e}`);
        return false;
      }
      
      return true;
    }
  }
  
  // Si no es URL ni data URI, verificamos si es base64 válido
  try {
    const testBuffer = Buffer.from(imageData, 'base64');
    return testBuffer.length >= 100;
  } catch (e) {
    console.error(`[validateImageForVision] Error al validar datos base64: ${e}`);
    return false;
  }
}

// Función alternativa para capturar screenshots en entornos serverless
async function captureScreenshotServerless(url: string, options?: { timeout?: number }): Promise<string | undefined> {
  console.log(`[captureScreenshotServerless] Capturando screenshot para: ${url}`);
  
  try {
    // Usar API externa para screenshots
    const screenshot = await generateScreenshotExternal(url);
    return screenshot;
  } catch (error) {
    console.error(`[captureScreenshotServerless] Error capturando screenshot: ${error}`);
    return generatePlaceholderImage(url);
  }
}

// Función para generar screenshot usando API externa
async function generateScreenshotExternal(url: string): Promise<string> {
  // Opción 1: Usar ScreenshotMachine si está configurado
  if (process.env.SCREENSHOTMACHINE_API_KEY) {
    try {
      // Intentar primero con full-page screenshot para capturar todo el sitio
      const apiUrl = `https://api.screenshotmachine.com/?key=${process.env.SCREENSHOTMACHINE_API_KEY}&url=${encodeURIComponent(url)}&dimension=1200xfull&format=jpg&device=desktop&delay=3000&cacheLimit=1`;
      const response = await fetch(apiUrl);
      
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        console.log('✅ Screenshot full-page generado con ScreenshotMachine');
        return `data:image/jpeg;base64,${base64}`;
      } else {
        console.warn(`Error con ScreenshotMachine full-page: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.warn('Error con ScreenshotMachine full-page:', error);
    }
    
    // Fallback: usar dimensiones fijas largas (1:2 ratio)
    try {
      const apiUrl = `https://api.screenshotmachine.com/?key=${process.env.SCREENSHOTMACHINE_API_KEY}&url=${encodeURIComponent(url)}&dimension=1200x2400&format=jpg&device=desktop&delay=3000&cacheLimit=1`;
      const response = await fetch(apiUrl);
      
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        console.log('✅ Screenshot 1:2 generado con ScreenshotMachine');
        return `data:image/jpeg;base64,${base64}`;
      } else {
        console.warn(`Error con ScreenshotMachine 1:2: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.warn('Error con ScreenshotMachine 1:2:', error);
    }
  }
  
  // Opción 2: Usar ScreenshotLayer si está configurado
  if (process.env.SCREENSHOTLAYER_API_KEY) {
    try {
      const apiUrl = `https://api.screenshotlayer.com/api/capture?access_key=${process.env.SCREENSHOTLAYER_API_KEY}&url=${encodeURIComponent(url)}&viewport=1200x800&width=1200&format=JPG`;
      const response = await fetch(apiUrl);
      
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        console.log('✅ Screenshot generado con ScreenshotLayer');
        return `data:image/jpeg;base64,${base64}`;
      }
    } catch (error) {
      console.warn('Error con ScreenshotLayer:', error);
    }
  }
  
  // Opción 3: Usar ScreenshotsCloud si está configurado
  if (process.env.SCREENSHOTSCLOUD_KEY && process.env.SCREENSHOTSCLOUD_SECRET) {
    try {
      // Implementar lógica de ScreenshotsCloud con autenticación HMAC
      const crypto = require('crypto');
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = crypto.createHmac('sha1', process.env.SCREENSHOTSCLOUD_SECRET)
        .update(`${process.env.SCREENSHOTSCLOUD_KEY}${timestamp}${url}`)
        .digest('hex');
      
      const apiUrl = `https://api.screenshots.cloud/v1/screenshot?key=${process.env.SCREENSHOTSCLOUD_KEY}&url=${encodeURIComponent(url)}&width=1200&timestamp=${timestamp}&signature=${signature}`;
      const response = await fetch(apiUrl);
      
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        console.log('✅ Screenshot generado con ScreenshotsCloud');
        return `data:image/jpeg;base64,${base64}`;
      }
    } catch (error) {
      console.warn('Error con ScreenshotsCloud:', error);
    }
  }
  
  // Opción 4: Usar thum.io como fallback (API gratuita)
  try {
    const apiUrl = `https://image.thum.io/get/allowJPG/wait/20/width/1200/crop/800/${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl);
    
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      console.log('✅ Screenshot generado con thum.io');
      return `data:image/jpeg;base64,${base64}`;
    }
  } catch (error) {
    console.warn('Error con thum.io:', error);
  }
  
  // Si todo falla, usar placeholder
  console.warn('⚠️ No se pudo generar screenshot, usando placeholder');
  return generatePlaceholderImage(url);
}

// Función para generar imagen placeholder con proporción 1:2
function generatePlaceholderImage(url: string): string {
  // Generar un SVG simple como placeholder con proporción 1:2 (1200x2400)
  try {
    const domain = new URL(url).hostname;
    const svg = `
      <svg width="1200" height="2400" xmlns="http://www.w3.org/2000/svg">
        <rect width="1200" height="2400" fill="#f8f9fa"/>
        <!-- Header mockup -->
        <rect x="50" y="50" width="1100" height="100" fill="#e9ecef" rx="5"/>
        <!-- Hero section -->
        <rect x="50" y="200" width="1100" height="400" fill="#e9ecef" rx="5"/>
        <!-- Content sections -->
        <rect x="50" y="650" width="350" height="300" fill="#e9ecef" rx="5"/>
        <rect x="425" y="650" width="350" height="300" fill="#e9ecef" rx="5"/>
        <rect x="800" y="650" width="350" height="300" fill="#e9ecef" rx="5"/>
        <!-- More content -->
        <rect x="50" y="1000" width="1100" height="200" fill="#e9ecef" rx="5"/>
        <rect x="50" y="1250" width="1100" height="300" fill="#e9ecef" rx="5"/>
        <!-- Footer mockup -->
        <rect x="50" y="1600" width="1100" height="150" fill="#e9ecef" rx="5"/>
        <!-- Text overlay -->
        <text x="600" y="1200" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="#6c757d">
          ${domain}
        </text>
        <text x="600" y="1230" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="#adb5bd">
          Screenshot placeholder (1:2 ratio)
        </text>
      </svg>
    `;
    
    const base64 = Buffer.from(svg).toString('base64');
    return `data:image/svg+xml;base64,${base64}`;
  } catch (error) {
    console.error('Error generando placeholder:', error);
    // Fallback ultra simple con proporción 1:2
    const simpleBase64 = 'PHN2ZyB3aWR0aD0iMTIwMCIgaGVpZ2h0PSIyNDAwIiB2aWV3Qm94PSIwIDAgMTIwMCAyNDAwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPiA8cmVjdCB3aWR0aD0iMTIwMCIgaGVpZ2h0PSIyNDAwIiBmaWxsPSIjZjhmOWZhIi8+IDx0ZXh0IHg9IjYwMCIgeT0iMTIwMCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjI0IiBmaWxsPSIjNmM3NTdkIj5TY3JlZW5zaG90IHBsYWNlaG9sZGVyICgxOjIpPC90ZXh0PiA8L3N2Zz4=';
    return `data:image/svg+xml;base64,${simpleBase64}`;
  }
}

// Detectar si estamos en entorno serverless
function isServerlessEnvironment(): boolean {
  return !!(
    process.env.VERCEL || 
    process.env.NETLIFY || 
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTION_NAME ||
    process.env.SERVERLESS
  );
}

/**
 * Captura una screenshot de la URL proporcionada utilizando Puppeteer
 */
export async function captureScreenshot(url: string, options?: { timeout?: number }): Promise<string | undefined> {
  const timeout = options?.timeout || 30000;
  console.log(`[captureScreenshot] Iniciando captura de screenshot para: ${url}`);
  console.log(`[captureScreenshot] Opciones: timeout=${timeout}ms`);
  
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    console.error(`[captureScreenshot] URL inválida: ${url}`);
    return undefined;
  }
  
  // Detectar si estamos en entorno serverless
  if (isServerlessEnvironment()) {
    console.log('[captureScreenshot] Entorno serverless detectado, usando captura sin Puppeteer...');
    return await captureScreenshotServerless(url, options);
  }
  
  // Usar Puppeteer solo en entornos locales
  console.log('[captureScreenshot] Entorno local detectado, usando Puppeteer...');
  let browser;
  try {
    // Configurar el navegador
    console.log(`[captureScreenshot] Lanzando navegador Puppeteer...`);
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security'
      ]
    });
    console.log(`[captureScreenshot] Navegador lanzado correctamente`);
    
    // Crear una nueva página
    console.log(`[captureScreenshot] Creando nueva página...`);
    const page = await browser.newPage();
    console.log(`[captureScreenshot] Página creada correctamente`);
    
    // Configurar viewport para capturar una buena parte de la página
    console.log(`[captureScreenshot] Configurando viewport...`);
    await page.setViewport({
      width: 1280,
      height: 1024,
      deviceScaleFactor: 1,
    });
    console.log(`[captureScreenshot] Viewport configurado correctamente`);
    
    // Configurar timeout
    console.log(`[captureScreenshot] Configurando timeout: ${timeout}ms`);
    await page.setDefaultNavigationTimeout(timeout);
    
    // Navegar a la URL
    console.log(`[captureScreenshot] Navegando a: ${url}`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeout
    });
    console.log(`[captureScreenshot] Navegación completada correctamente`);
    
    // Esperar un poco para que se carguen elementos dinámicos
    console.log(`[captureScreenshot] Esperando 2 segundos para elementos dinámicos...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Tomar screenshot
    console.log('[captureScreenshot] Tomando screenshot...');
    const screenshot = await page.screenshot({ type: 'png' });
    console.log(`[captureScreenshot] Screenshot tomado: ${screenshot.length} bytes`);
    
    // Convertir a base64
    const base64Image = Buffer.from(screenshot).toString('base64');
    console.log(`[captureScreenshot] Screenshot convertido a base64: ${base64Image.length} bytes`);
    
    return `data:image/png;base64,${base64Image}`;
  } catch (error) {
    console.error(`[captureScreenshot] Error al capturar screenshot con Puppeteer: ${error}`);
    // Fallback al método serverless
    console.log('[captureScreenshot] Intentando método serverless como fallback...');
    return await captureScreenshotServerless(url, options);
  } finally {
    // Cerrar el navegador
    if (browser) {
      try {
        await browser.close();
        console.log('[captureScreenshot] Navegador cerrado en bloque finally');
      } catch (closeError) {
        console.error(`[captureScreenshot] Error al cerrar el navegador: ${closeError}`);
      }
    }
  }
} 