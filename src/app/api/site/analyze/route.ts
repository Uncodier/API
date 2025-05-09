import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { performInitialAnalysis } from '@/lib/services/initial-analyzer-service'
import { performDetailedAnalysis } from '@/lib/services/detailed-analyzer-service'
import { performStructuredAnalysis } from '@/lib/services/structured-analyzer-service'
import puppeteer from 'puppeteer'

/**
 * API AVANZADA DE ANÁLISIS DE SITIOS WEB
 * 
 * Esta es la implementación avanzada de la API de análisis de sitios web.
 * 
 * DIFERENCIAS CON LA API BÁSICA (/api/analyze):
 * 1. Esta API utiliza servicios especializados (performInitialAnalysis,
 *    performDetailedAnalysis, performStructuredAnalysis) en lugar de la
 *    función 'analyzeSiteAction'.
 * 2. Esta API permite configurar múltiples opciones avanzadas como tipo de
 *    análisis, profundidad, timeout, proveedor de IA, etc.
 * 3. Esta API devuelve una estructura de respuesta más detallada con
 *    metadatos adicionales.
 * 4. Esta API implementa un sistema de manejo de errores más sofisticado
 *    con tipos de errores específicos.
 * 
 * NOTA: Esta API y la API básica (/api/analyze) son implementaciones
 * completamente independientes con diferentes enfoques y arquitecturas.
 * No comparten código entre ellas.
 * 
 * Documentación completa: /docs/api/analysis/advanced-analyze
 */

// Definición de la interfaz AnalyzeRequest
interface AnalyzeRequest {
  url: string;
  options?: {
    depth?: number;
    timeout?: number;
    userAgent?: string;
    includeScreenshot?: boolean;
  };
  htmlContent?: string; // Contenido HTML renderizado de la página
  screenshot?: string; // Captura de pantalla en formato base64
}

// Caché para almacenar el HTML capturado para análisis posteriores
const analysisCache = new Map<string, { htmlContent: string; timestamp: number }>();

// Esquema para validar el cuerpo de la solicitud
const RequestSchema = z.object({
  url: z.string().url('Debe ser una URL válida'),
  options: z.object({
    timeout: z.number().min(5000).max(60000).default(30000),
    ignoreSSL: z.boolean().default(false),
    userAgent: z.string().optional(),
    failOnError: z.boolean().default(false), // Si es false, intenta continuar incluso con errores
    safeSelectors: z.boolean().default(true), // Si es true, valida los selectores antes de usarlos
  }).optional(),
})

// Interfaces para los resultados detallados del análisis
interface MetricDetail {
  score: number
  label: string
  description: string
}

interface PerformanceMetrics {
  overall: number
  firstContentfulPaint: MetricDetail
  largestContentfulPaint: MetricDetail
  timeToInteractive: MetricDetail
  totalBlockingTime: MetricDetail
  cumulativeLayoutShift: MetricDetail
  speedIndex: MetricDetail
}

interface SeoMetrics {
  overall: number
  metaTags: MetricDetail
  headings: MetricDetail
  imageAlt: MetricDetail
  linkText: MetricDetail
  crawlability: MetricDetail
  mobileOptimization: MetricDetail
}

interface AccessibilityMetrics {
  overall: number
  contrast: MetricDetail
  ariaLabels: MetricDetail
  keyboardNavigation: MetricDetail
  textAlternatives: MetricDetail
  formLabels: MetricDetail
}

interface BestPracticesMetrics {
  overall: number
  httpsUsage: MetricDetail
  javascriptErrors: MetricDetail
  deprecatedAPIs: MetricDetail
  responsiveDesign: MetricDetail
  doctype: MetricDetail
}

interface TechnologiesDetected {
  name: string
  version?: string
  category: string
}

interface PageResource {
  url: string
  type: string
  size: number
  transferSize: number
}

interface Recommendation {
  category: string
  priority: 'alta' | 'media' | 'baja'
  issue: string
  recommendation: string
  impact: string
}

// Interfaz para errores específicos del análisis
interface AnalysisError {
  code: string
  message: string
  details?: string
  location?: string
  recoverable: boolean
  timestamp?: string
}

// Interface principal para los resultados del análisis
interface AnalysisResult {
  url: string
  title: string
  description?: string
  screenshot?: string
  performance?: PerformanceMetrics // Ahora opcionales para permitir análisis parciales
  seo?: SeoMetrics
  accessibility?: AccessibilityMetrics
  bestPractices?: BestPracticesMetrics
  technologies?: TechnologiesDetected[]
  resources?: {
    total: number
    totalSize: number
    byType: {
      [key: string]: {
        count: number
        size: number
      }
    }
    largest: PageResource[]
  }
  recommendations?: Recommendation[]
  timestamp: string
  analyzedBy: string
  analysisVersion: string
  errors?: AnalysisError[] // Errores no críticos en el análisis
  completeness?: number // Porcentaje de completitud del análisis (0-100)
  agentData?: {
    initialAnalysis: any
    detailedAnalysis: any
  }
  analysis: any
  rawHtml?: string
}

// Función auxiliar para identificar y formatear errores específicos
function parseAnalysisError(error: unknown): AnalysisError {
  // Extraer mensaje de error
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  
  // Procesar error de selector inválido
  if (errorMessage.includes('Failed to execute \'querySelector\'') || 
      errorMessage.includes('is not a valid selector')) {
    return {
      code: 'INVALID_SELECTOR',
      message: 'Error al procesar un selector en la página',
      details: errorMessage,
      location: extractErrorLocation(errorStack),
      recoverable: true,
      timestamp: new Date().toISOString()
    };
  }
  
  // Error de tiempo de espera
  if (errorMessage.includes('Timeout') || errorMessage.includes('timed out')) {
    return {
      code: 'TIMEOUT',
      message: 'El análisis excedió el tiempo máximo de espera',
      details: errorMessage,
      location: extractErrorLocation(errorStack),
      recoverable: true, // Ahora marcamos los timeouts como recuperables para análisis parciales
      timestamp: new Date().toISOString()
    };
  }
  
  // Error de navegación
  if (errorMessage.includes('Navigation failed') || 
      errorMessage.includes('net::ERR_') || 
      errorMessage.includes('ERR_CONNECTION_')) {
    return {
      code: 'NAVIGATION_ERROR',
      message: 'No se pudo acceder al sitio web especificado',
      details: errorMessage,
      location: extractErrorLocation(errorStack),
      recoverable: false,
      timestamp: new Date().toISOString()
    };
  }
  
  // Error genérico por defecto
  return {
    code: 'ANALYSIS_ERROR',
    message: 'Error durante el análisis del sitio',
    details: errorMessage,
    location: extractErrorLocation(errorStack),
    recoverable: true, // Por defecto consideramos los errores como recuperables
    timestamp: new Date().toISOString()
  };
}

// Extrae la ubicación del error del stack trace
function extractErrorLocation(stackTrace?: string): string | undefined {
  if (!stackTrace) return undefined;
  
  // Intentar extraer información útil del stack trace
  const lines = stackTrace.split('\n');
  
  // Buscar líneas relevantes (típicamente las que contienen archivos de nuestro proyecto)
  const relevantLine = lines.find(line => 
    line.includes('/src/lib/actions/') || 
    line.includes('/app/api/')
  );
  
  return relevantLine ? relevantLine.trim() : undefined;
}

// Función para mejorar la captura de HTML con menos ofuscación
async function captureFullHTML(url: string, timeout = 30000): Promise<{ html: string, screenshot: string }> {
  console.log(`Capturing full HTML content for ${url}`);
  
  // Launch browser
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--enable-javascript'
    ]
  });
  
  try {
    const page = await browser.newPage();
    
    // Habilitar JavaScript
    await page.setJavaScriptEnabled(true);
    
    // Configurar resolución de MacBook Pro de 15 pulgadas
    await page.setViewport({ 
      width: 2880, 
      height: 1800,
      deviceScaleFactor: 2.0 // Retina display
    });
    
    // Set a realistic MacBook Pro user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
    
    // Interceptar peticiones para evitar bloqueos
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
        request.continue();
      } else {
        request.continue();
      }
    });
    
    // Monitorear la consola para depuración
    page.on('console', msg => console.log(`[Browser Console] ${msg.text()}`));
    
    // Navegar a la página con un timeout extendido
    console.log(`Navigating to ${url} with timeout ${timeout}ms`);
    await page.goto(url, {
      waitUntil: 'networkidle2', // Cambiado a networkidle2 para ser menos estricto
      timeout: timeout
    });
    
    // Esperar a que el DOM esté completamente cargado
    await page.waitForFunction(() => document.readyState === 'complete', { timeout });
    
    // Esperar elementos importantes que podrían indicar que la página está cargada
    try {
      await page.waitForSelector('#root, #app, main, .main, [role="main"]', { timeout: 5000 });
    } catch (e) {
      console.log('No se encontraron contenedores principales, continuando...');
    }
    
    // Esperar tiempo adicional para contenido dinámico
    console.log('Waiting for dynamic content to load...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Realizar interacciones para activar posibles cargas de contenido
    await page.evaluate(async () => {
      // Simular movimiento del ratón
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100
      }));
      
      // Simular scroll para activar cargas lazy
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 300;
        const scrollHeight = document.body.scrollHeight;
        
        console.log(`Altura total de la página: ${scrollHeight}px`);
        
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          
          // Hacer una pausa en cada tercio de la página para permitir cargas
          if (totalHeight % Math.floor(scrollHeight/3) < distance) {
            console.log(`Pausa en scroll: ${totalHeight}px`);
            clearInterval(timer);
            
            // Continuar después de una pausa
            setTimeout(() => {
              const newTimer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                
                if (totalHeight >= scrollHeight) {
                  clearInterval(newTimer);
                  console.log(`Scroll completado: ${totalHeight}px recorridos`);
                  
                  // Esperar un poco más después del scroll
                  setTimeout(() => {
                    // Scroll back to top
                    window.scrollTo(0, 0);
                    resolve(true);
                  }, 2000);
                }
              }, 100);
            }, 2000);
          }
          
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            console.log(`Scroll completado: ${totalHeight}px recorridos`);
            
            // Esperar un poco más después del scroll
            setTimeout(() => {
              // Scroll back to top
              window.scrollTo(0, 0);
              resolve(true);
            }, 2000);
          }
        }, 100);
      });
    });
    
    // Esperar un poco más tras el scroll
    console.log('Waiting after scroll...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Intentar hacer clic en elementos que podrían mostrar más contenido
    await page.evaluate(() => {
      const clickableElements = document.querySelectorAll('button, [role="button"], .btn, a');
      clickableElements.forEach((el) => {
        // Solo hacer clic en elementos visibles que podrían expandir contenido
        const text = (el as HTMLElement).innerText.toLowerCase();
        if (text.includes('more') || text.includes('show') || text.includes('expand') || 
            text.includes('ver') || text.includes('más') || text.includes('mostrar')) {
          try {
            (el as HTMLElement).click();
            console.log('Clicked on:', text);
          } catch (e) {
            // Ignorar errores de clic
          }
        }
      });
    });
    
    // Esperar después de los clics
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get the full HTML content without modification
    console.log('Capturing final HTML content...');
    const html = await page.content();
    
    // Capture screenshot of the entire page
    console.log('Capturing full page screenshot...');
    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'jpeg',
      quality: 90
    }) as Buffer;
    
    // Convert screenshot to base64 data URI
    const screenshotBase64 = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
    console.log(`Screenshot captured: ${(screenshotBase64.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`HTML captured: ${Math.round(html.length / 1024)} KB`);
    
    return {
      html,
      screenshot: screenshotBase64
    };
    
  } finally {
    await browser.close();
  }
}

/**
 * RECOMENDACIONES PARA LA IMPLEMENTACIÓN DEL ANÁLISIS:
 * 
 * 1. Estructura cada función de análisis con try-catch:
 * 
 * async function analyzeSomething(page, url) {
 *   try {
 *     // Código de análisis
 *     return { success: true, data: result };
 *   } catch (error) {
 *     console.error('Error en análisis:', error);
 *     return { success: false, error };
 *   }
 * }
 * 
 * 2. Valida los selectores antes de usarlos:
 * 
 * function safeQuerySelector(page, selector) {
 *   return page.evaluate((sel) => {
 *     try {
 *       return document.querySelector(sel) !== null;
 *     } catch (e) {
 *       return false;
 *     }
 *   }, selector);
 * }
 * 
 * 3. Implementa un sistema de análisis modular que continue incluso si partes fallan:
 * 
 * async function analyzeSite(url, options) {
 *   const results = { url, timestamp: new Date().toISOString() };
 *   const errors = [];
 *   
 *   // Análisis de performance (si falla, continúa con el siguiente)
 *   try {
 *     results.performance = await analyzePerformance(page, url);
 *   } catch (error) {
 *     errors.push(parseAnalysisError(error));
 *   }
 *   
 *   // Análisis de SEO (si falla, continúa con el siguiente)
 *   try {
 *     results.seo = await analyzeSEO(page, url);
 *   } catch (error) {
 *     errors.push(parseAnalysisError(error));
 *   }
 *   
 *   // Añadir errores al resultado
 *   if (errors.length > 0) {
 *     results.errors = errors;
 *     results.completeness = calculateCompleteness(results);
 *   }
 *   
 *   return results;
 * }
 */

export async function POST(request: NextRequest) {
  try {
    // Validate request body
    const requestBody = await request.json()
    
    // Validate URL
    const { url, options } = z.object({
      url: z.string().url('URL inválida. Por favor proporciona una URL válida.'),
      options: z.object({
        analysisType: z.enum(['basic', 'detailed', 'structured']).default('basic'),
        depth: z.number().min(1).max(3).default(1),
        timeout: z.number().min(5000).max(60000).default(30000),
        includeScreenshot: z.boolean().default(true),
        provider: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),
        modelId: z.string().optional()
      }).optional()
    }).parse(requestBody)

    // Set default options
    const analysisOptions = {
      depth: options?.depth || 1,
      timeout: options?.timeout || 30000,
      includeScreenshot: options?.includeScreenshot === true,
      provider: options?.provider || 'anthropic',
      modelId: options?.modelId
    }
    
    const analysisType = options?.analysisType || 'basic'
    
    console.log(`Iniciando análisis para URL: ${url}`);
    console.log(`Tipo de análisis seleccionado: ${analysisType}`);
    console.log(`Opciones de análisis:`, JSON.stringify(analysisOptions));
    
    try {
      let result
      const startTime = Date.now()
      
      switch (analysisType) {
        case 'basic':
          console.log('Ejecutando análisis básico...');
          result = await performInitialAnalysis(url, analysisOptions)
          break
          
        case 'detailed':
          console.log('Ejecutando análisis detallado...');
          // Primero realizar un análisis inicial
          const initialAnalysis = await performInitialAnalysis(url, analysisOptions)
          // Luego realizar el análisis detallado
          result = await performDetailedAnalysis(url, initialAnalysis, analysisOptions)
          break
          
        case 'structured':
          console.log('Ejecutando análisis estructurado...');
          result = await performStructuredAnalysis(url, analysisOptions)
          break
          
        default:
          result = await performInitialAnalysis(url, analysisOptions)
      }
      
      const endTime = Date.now()
      const processingTime = endTime - startTime
      
      console.log(`Análisis completado en ${processingTime}ms`);
      console.log(`Tipo de análisis realizado: ${analysisType}`);
      
      // Devolver el resultado con metadatos adicionales
      return NextResponse.json({
        result,
        analysisType,
        processingTime,
        timestamp: new Date().toISOString()
      })
      
    } catch (error) {
      console.error('Error durante el análisis:', error)
      
      return NextResponse.json({
        success: false,
        url,
        analysisType,
        error: {
          message: error instanceof Error ? error.message : 'Error desconocido durante el análisis',
          type: 'ANALYSIS_ERROR'
        }
      }, { status: 500 })
    }
    
  } catch (error) {
    console.error('Error en la solicitud:', error)
    
    let errorMessage = 'Error procesando la solicitud'
    let status = 500
    
    if (error instanceof z.ZodError) {
      errorMessage = error.errors[0].message
      status = 400
    }
    
    return NextResponse.json({
      success: false,
      error: {
        message: errorMessage,
        type: error instanceof z.ZodError ? 'VALIDATION_ERROR' : 'SERVER_ERROR'
      }
    }, { status })
  }
}

// También implementamos un endpoint GET para obtener información sobre el servicio
export async function GET(request: NextRequest) {
  return NextResponse.json(
    { 
      message: 'API de análisis de sitios web',
      usage: 'Envía una solicitud POST con un objeto JSON que contenga la propiedad "url"',
      example: { 
        url: "https://example.com",
        options: {
          timeout: 30000,
          ignoreSSL: false,
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          failOnError: false, // No detener el análisis si hay errores
          safeSelectors: true // Validar selectores antes de usarlos
        }
      },
      capabilities: [
        'Análisis de rendimiento web',
        'Evaluación de SEO',
        'Verificación de accesibilidad',
        'Mejores prácticas web',
        'Detección de tecnologías',
        'Análisis de recursos',
        'Recomendaciones personalizadas'
      ],
      errorHandling: {
        codes: [
          'INVALID_SELECTOR', 
          'TIMEOUT', 
          'NAVIGATION_ERROR', 
          'ANALYSIS_ERROR',
          'VALIDATION_ERROR',
          'SERVER_ERROR'
        ]
      },
      documentation: '/docs/api/analysis/advanced-analyze',
      note: 'Esta es la API avanzada de análisis. Existe también una API básica en /api/analyze con funcionalidad más limitada.'
    },
    { status: 200 }
  )
} 