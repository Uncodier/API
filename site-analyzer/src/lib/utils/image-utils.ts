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

/**
 * Captura una screenshot de la URL proporcionada utilizando Puppeteer
 */
export async function captureScreenshot(url: string, options?: { timeout?: number }): Promise<string | undefined> {
  console.log(`[captureScreenshot] Iniciando captura de screenshot para: ${url}`);
  
  let browser;
  try {
    // Configurar el navegador
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
    
    // Crear una nueva página
    const page = await browser.newPage();
    
    // Configurar viewport para capturar una buena parte de la página
    await page.setViewport({
      width: 1280,
      height: 1024,
      deviceScaleFactor: 1,
    });
    
    // Configurar timeout
    const timeout = options?.timeout || 30000;
    await page.setDefaultNavigationTimeout(timeout);
    
    // Navegar a la URL
    console.log(`[captureScreenshot] Navegando a: ${url}`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeout
    });
    
    // Esperar un poco para que se carguen elementos dinámicos
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Tomar screenshot
    console.log('[captureScreenshot] Tomando screenshot...');
    const screenshot = await page.screenshot({ type: 'png' });
    
    // Convertir a base64
    const base64Image = Buffer.from(screenshot).toString('base64');
    console.log(`[captureScreenshot] Screenshot capturado: ${base64Image.length} bytes`);
    
    return `data:image/png;base64,${base64Image}`;
  } catch (error) {
    console.error(`[captureScreenshot] Error al capturar screenshot: ${error}`);
    return undefined;
  } finally {
    // Cerrar el navegador
    if (browser) {
      await browser.close();
      console.log('[captureScreenshot] Navegador cerrado');
    }
  }
} 