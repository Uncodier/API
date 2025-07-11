// Utilidades para el procesamiento de HTML
import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

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

// Función alternativa para obtener HTML en entornos serverless
async function fetchHtmlServerless(url: string, timeout: number): Promise<string> {
  console.log(`[fetchHtmlServerless] Obteniendo HTML para ${url} con timeout ${timeout}ms`);
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    console.log(`[fetchHtmlServerless] HTML obtenido: ${html.length} bytes`);
    
    return html;
  } catch (error) {
    console.error(`[fetchHtmlServerless] Error obteniendo HTML: ${error}`);
    throw error;
  }
}

/**
 * Obtiene el HTML de una URL
 */
export async function fetchHtml(url: string, options?: { timeout?: number }): Promise<string> {
  const timeout = options?.timeout || 30000;
  console.log(`[fetchHtml] Obteniendo HTML de ${url} con timeout ${timeout}ms`);
  
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    console.error(`[fetchHtml] URL inválida: ${url}`);
    throw new Error(`URL inválida: ${url}`);
  }
  
  // Detectar entorno serverless
  if (isServerlessEnvironment()) {
    console.log(`[fetchHtml] Entorno serverless detectado, usando fetch directo...`);
    return await fetchHtmlServerless(url, timeout);
  }
  
  // Primero intentamos con Puppeteer para sitios con JavaScript (solo en entornos locales)
  try {
    console.log(`[fetchHtml] Intentando obtener HTML con Puppeteer...`);
    return await fetchHtmlWithPuppeteer(url, timeout);
  } catch (puppeteerError) {
    console.warn(`[fetchHtml] Error con Puppeteer, intentando con fetch directo: ${puppeteerError}`);
    
    // Si falla Puppeteer, intentamos con fetch directo como fallback
    return await fetchHtmlServerless(url, timeout);
  }
}

/**
 * Obtiene el HTML de una URL usando Puppeteer
 */
async function fetchHtmlWithPuppeteer(url: string, timeout: number): Promise<string> {
  console.log(`[fetchHtmlWithPuppeteer] Iniciando captura de HTML para ${url} con timeout ${timeout}ms`);
  
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--enable-javascript',
      '--disable-notifications',
      '--disable-geolocation',
      '--disable-infobars',
      '--window-size=1920,1080'
    ]
  });
  
  try {
    const page = await browser.newPage();
    
    // Habilitar JavaScript
    await page.setJavaScriptEnabled(true);
    
    // Configurar viewport
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1
    });
    
    // Configurar user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
    
    // Interceptar y manejar diálogos (alerts, confirms, prompts)
    page.on('dialog', async dialog => {
      console.log(`[fetchHtmlWithPuppeteer] Diálogo detectado: ${dialog.type()}, mensaje: ${dialog.message()}`);
      await dialog.dismiss();
    });
    
    // Monitorear cambios en el DOM para detectar cuando se estabiliza
    let domMutationCount = 0;
    let lastMutationTime = 0;
    
    await page.evaluateOnNewDocument(() => {
      // @ts-ignore
      window.__domMutationCount = 0;
      
      const observer = new MutationObserver((mutations) => {
        // @ts-ignore
        window.__domMutationCount += mutations.length;
        // @ts-ignore
        window.__lastMutationTime = Date.now();
      });
      
      // Observar cambios en todo el DOM
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
      });
    });
    
    // Manejar errores de recursos
    page.on('error', err => {
      console.warn(`[fetchHtmlWithPuppeteer] Error en la página: ${err.message}`);
    });
    
    page.on('pageerror', err => {
      console.warn(`[fetchHtmlWithPuppeteer] Error de JavaScript en la página: ${err.message}`);
    });
    
    // Manejar solicitudes fallidas
    page.on('requestfailed', request => {
      console.warn(`[fetchHtmlWithPuppeteer] Solicitud fallida: ${request.url()}`);
    });
    
    // Navegar a la URL con un timeout ajustado
    console.log(`[fetchHtmlWithPuppeteer] Navegando a ${url}...`);
    
    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: Math.min(timeout, 30000) // Máximo 30 segundos para la navegación inicial
      });
    } catch (error: any) {
      console.warn(`[fetchHtmlWithPuppeteer] Error en navegación inicial: ${error.message}`);
      console.log('[fetchHtmlWithPuppeteer] Intentando continuar a pesar del error de navegación...');
    }
    
    // Esperar a que el DOM esté completamente cargado
    try {
      await page.waitForFunction(() => document.readyState === 'complete', { 
        timeout: Math.min(timeout, 10000) // Máximo 10 segundos para readyState
      });
      console.log('[fetchHtmlWithPuppeteer] Estado del documento: complete');
    } catch (error: any) {
      console.warn(`[fetchHtmlWithPuppeteer] Timeout esperando readyState complete: ${error.message}`);
    }
    
    // Manejar banners de cookies y popups comunes
    console.log('[fetchHtmlWithPuppeteer] Intentando cerrar banners de cookies y popups...');
    await page.evaluate(() => {
      // Selectores comunes para botones de aceptación de cookies
      const cookieSelectors = [
        // Botones de aceptación de cookies
        'button[id*="accept"], button[class*="accept"], button[id*="cookie"], button[class*="cookie"]',
        'a[id*="accept"], a[class*="accept"], a[id*="cookie"], a[class*="cookie"]',
        // Botones de cierre de popups
        'button[class*="close"], button[id*="close"], button[aria-label*="close"], button[title*="close"]',
        '.modal-close, .popup-close, .close-modal, .close-popup',
        // Botones específicos por texto
        'button:contains("Accept"), button:contains("Aceptar"), button:contains("I agree"), button:contains("Acepto")',
        'button:contains("Close"), button:contains("Cerrar"), button:contains("Got it"), button:contains("Entendido")'
      ];
      
      // Intentar hacer clic en cada selector
      cookieSelectors.forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach(el => {
            try {
              (el as HTMLElement).click();
            } catch (e) {
              // Ignorar errores
            }
          });
        } catch (e) {
          // Ignorar errores
        }
      });
    });
    
    // Esperar un tiempo para que se procesen los clics
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Hacer scroll para cargar contenido lazy
    console.log('[fetchHtmlWithPuppeteer] Realizando scroll para cargar contenido lazy...');
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 300;
        const scrollInterval = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          
          // Si hemos llegado al final o hemos hecho scroll suficiente
          if (totalHeight >= scrollHeight || totalHeight > 15000) {
            clearInterval(scrollInterval);
            window.scrollTo(0, 0); // Volver al inicio
            resolve();
          }
        }, 200);
      });
    });
    
    // Esperar a que el DOM se estabilice (pocos cambios en un período de tiempo)
    console.log('[fetchHtmlWithPuppeteer] Esperando a que el DOM se estabilice...');
    try {
      await page.waitForFunction(
        () => {
          // @ts-ignore
          const currentCount = window.__domMutationCount || 0;
          // @ts-ignore
          const lastTime = window.__lastMutationTime || 0;
          const now = Date.now();
          
          // Si han pasado más de 2 segundos sin cambios significativos, consideramos que el DOM está estable
          return (now - lastTime > 2000) || (currentCount < 10);
        },
        { timeout: Math.min(timeout, 5000) } // Máximo 5 segundos para estabilización
      );
      console.log('[fetchHtmlWithPuppeteer] DOM estabilizado');
    } catch (error: any) {
      console.warn(`[fetchHtmlWithPuppeteer] Timeout esperando estabilización del DOM: ${error.message}`);
    }
    
    // Expandir elementos colapsados (como menús desplegables)
    console.log('[fetchHtmlWithPuppeteer] Expandiendo elementos colapsados...');
    await page.evaluate(() => {
      // Selectores para elementos que podrían expandir contenido
      const expandableSelectors = [
        // Menús de navegación
        '.navbar-toggle, .menu-toggle, .hamburger, [aria-label*="menu"], [aria-label*="navigation"]',
        // Acordeones y tabs
        '.accordion-toggle, .accordion-header, [aria-expanded="false"], [data-toggle="collapse"]',
        '.tab, .tab-header, [role="tab"], [data-toggle="tab"]',
        // Dropdowns
        '.dropdown-toggle, [data-toggle="dropdown"], .has-dropdown > a',
        // Botones de "mostrar más"
        'button:contains("more"), button:contains("Show"), button:contains("Ver"), button:contains("Mostrar")',
        'a:contains("more"), a:contains("Show"), a:contains("Ver"), a:contains("Mostrar")'
      ];
      
      // Intentar hacer clic en cada selector
      expandableSelectors.forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach(el => {
            try {
              (el as HTMLElement).click();
            } catch (e) {
              // Ignorar errores
            }
          });
        } catch (e) {
          // Ignorar errores
        }
      });
    });
    
    // Esperar un tiempo para que se expandan los elementos
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Obtener el HTML final
    console.log('[fetchHtmlWithPuppeteer] Obteniendo HTML final...');
    const html = await page.content();
    console.log(`[fetchHtmlWithPuppeteer] HTML obtenido (${html.length} bytes)`);
    
    // Obtener estadísticas básicas del DOM
    const domStats = await page.evaluate(() => {
      return {
        totalElements: document.querySelectorAll('*').length,
        bodyChildren: document.body.children.length,
        scripts: document.querySelectorAll('script').length,
        links: document.querySelectorAll('a').length,
        images: document.querySelectorAll('img').length,
        iframes: document.querySelectorAll('iframe').length
      };
    });
    
    console.log(`[fetchHtmlWithPuppeteer] Estadísticas del DOM: ${JSON.stringify(domStats)}`);
    
    return html;
  } finally {
    await browser.close();
    console.log('[fetchHtmlWithPuppeteer] Navegador cerrado');
  }
}

/**
 * Extrae el título de un documento HTML
 */
export function extractTitle(html: string): string {
  try {
    const $ = cheerio.load(html);
    const title = $('title').text().trim();
    return title || 'Sin título';
  } catch (error) {
    console.error(`[extractTitle] Error al extraer título: ${error}`);
    return 'Error al extraer título';
  }
}

/**
 * Extrae la descripción de un documento HTML
 */
export function extractDescription(html: string): string {
  try {
    const $ = cheerio.load(html);
    const description = $('meta[name="description"]').attr('content') || 
                        $('meta[property="og:description"]').attr('content') || 
                        '';
    return description.trim();
  } catch (error) {
    console.error(`[extractDescription] Error al extraer descripción: ${error}`);
    return '';
  }
}

/**
 * Extrae el idioma de un documento HTML
 */
export function extractLanguage(html: string): string {
  try {
    const $ = cheerio.load(html);
    const htmlLang = $('html').attr('lang') || '';
    return htmlLang.trim() || 'es';
  } catch (error) {
    console.error(`[extractLanguage] Error al extraer idioma: ${error}`);
    return 'es';
  }
}

/**
 * Genera estadísticas básicas de un documento HTML
 */
export function generateHtmlStats(html: string): {
  totalElements: number;
  headings: { h1: number; h2: number; h3: number; h4: number; h5: number; h6: number };
  links: number;
  images: number;
  forms: number;
  tables: number;
  lists: number;
  paragraphs: number;
  scripts: number;
  styles: number;
} {
  try {
    const $ = cheerio.load(html);
    
    return {
      totalElements: $('*').length,
      headings: {
        h1: $('h1').length,
        h2: $('h2').length,
        h3: $('h3').length,
        h4: $('h4').length,
        h5: $('h5').length,
        h6: $('h6').length
      },
      links: $('a').length,
      images: $('img').length,
      forms: $('form').length,
      tables: $('table').length,
      lists: $('ul, ol').length,
      paragraphs: $('p').length,
      scripts: $('script').length,
      styles: $('style, link[rel="stylesheet"]').length
    };
  } catch (error) {
    console.error(`[generateHtmlStats] Error al generar estadísticas: ${error}`);
    return {
      totalElements: 0,
      headings: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
      links: 0,
      images: 0,
      forms: 0,
      tables: 0,
      lists: 0,
      paragraphs: 0,
      scripts: 0,
      styles: 0
    };
  }
} 