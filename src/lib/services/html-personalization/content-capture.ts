/**
 * Módulo para capturar contenido HTML y capturas de pantalla de páginas web
 */

import { logInfo } from '@/lib/utils/api-response-utils';
import { fetchHtml } from '@/lib/utils/html-utils';
import { captureScreenshot as captureScreenshotUtil } from '@/lib/utils/image-utils';

/**
 * Captura el contenido HTML y una captura de pantalla de una página web
 * 
 * @param url URL de la página a capturar
 * @param timeout Tiempo máximo de espera en milisegundos
 * @returns Objeto con el HTML y la captura de pantalla en base64
 */
export async function capturePageContent(
  url: string, 
  timeout: number = 30000
): Promise<{ html: string, screenshot: string }> {
  logInfo('Content Capture', `Capturando contenido de la página: ${url}`);
  
  try {
    // Capturar HTML usando la función fetchHtml que ya detecta entornos serverless
    const html = await fetchHtml(url, { timeout });
    logInfo('Content Capture', `HTML capturado: ${html.length} bytes`);
    
    // Capturar screenshot usando la función captureScreenshot que ya detecta entornos serverless
    const screenshot = await captureScreenshotUtil(url, { timeout });
    
    if (screenshot) {
      logInfo('Content Capture', `Screenshot capturado correctamente`);
    } else {
      logInfo('Content Capture', `Screenshot no disponible - usando placeholder`);
    }
    
    return { 
      html, 
      screenshot: screenshot || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    };
  } catch (error) {
    logInfo('Content Capture', `Error capturando contenido: ${error}`);
    throw error;
  }
}

/**
 * Captura una captura de pantalla de una página web
 * 
 * @param url URL de la página a capturar
 * @param options Opciones de captura
 * @returns Captura de pantalla en base64
 */
export async function captureScreenshot(
  url: string,
  options: {
    width?: number;
    height?: number;
    fullPage?: boolean;
    timeout?: number;
  } = {}
): Promise<string> {
  logInfo('Content Capture', `Delegando captura de screenshot al servicio de conversación para: ${url}`);
  
  // Devolver un placeholder para evitar duplicación, ya que el servicio de conversación
  // se encargará de capturar la imagen real a través de prepareAnalysisData
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
} 