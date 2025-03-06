"use server"

import { z } from 'zod'
import puppeteer from 'puppeteer'
import { completeAnalysis } from '@/lib/agents/analyzer-agent'

// Esquema para validar los parámetros de entrada
const AnalyzeSiteParamsSchema = z.object({
  url: z.string().url(),
  ip: z.string(),
})

// Tipos para la respuesta
interface AnalyzeSiteSuccess {
  success: true
  url: string
  analysis: SiteAnalysis
}

interface AnalyzeSiteError {
  success: false
  error: string
}

// Tipo de respuesta
type AnalyzeSiteResult = AnalyzeSiteSuccess | AnalyzeSiteError

// Interfaz para el análisis del sitio
interface SiteAnalysis {
  title: string
  description: string
  sections: Section[]
  metadata: {
    favicon: string | null
    ogImage: string | null
    themeColor: string | null
  }
  rawHtml?: string
  screenshot?: string
}

// Interfaz para una sección
interface Section {
  type: SectionType
  content: string
  position: number
  elements: number
  attributes?: Record<string, string>
}

// Tipos de secciones que podemos identificar
type SectionType = 
  | 'hero'
  | 'features'
  | 'testimonials'
  | 'pricing'
  | 'cta'
  | 'footer'
  | 'header'
  | 'about'
  | 'contact'
  | 'gallery'
  | 'blog'
  | 'services'
  | 'team'
  | 'faq'
  | 'error-log'
  | 'error'
  | 'unknown'

/**
 * Acción del servidor para analizar un sitio web
 * @param params Parámetros para el análisis (url, ip)
 * @returns Resultado del análisis
 */
export async function analyzeSiteAction(params: z.infer<typeof AnalyzeSiteParamsSchema>): Promise<AnalyzeSiteResult> {
  try {
    // Validar parámetros
    const { url, ip } = AnalyzeSiteParamsSchema.parse(params)
    
    // TODO: Implementar rate limiting basado en IP
    
    // Analizar el sitio web
    const analysis = await getDetailedSiteAnalysis(url)
    
    return {
      success: true,
      url,
      analysis,
    }
  } catch (error) {
    console.error('Error analyzing site:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Error desconocido al analizar el sitio',
    }
  }
}

/**
 * Analiza una página web y extrae sus secciones principales.
 * @param url URL del sitio a analizar
 * @returns Análisis del sitio
 */
async function getDetailedSiteAnalysis(url: string): Promise<SiteAnalysis> {
  // Lanzar navegador headless para capturar el contenido post-render
  const browser = await puppeteer.launch({ 
    headless: true,  // Usar modo headless
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process', // Ayuda con algunos iframes
      '--disable-web-security', // Desactiva seguridad web para evitar problemas CORS
    ],
    timeout: 120000 // Aumentar a 2 minutos
  })
  const page = await browser.newPage()
  
  try {
    // Configurar timeouts y user-agent
    await page.setDefaultNavigationTimeout(90000) // 90 segundos para navegación
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36')
    
    // Interceptar solicitudes para mejorar rendimiento
    await page.setRequestInterception(true)
    page.on('request', (request: any) => {
      // Bloquear recursos que no son necesarios para el análisis
      const resourceType = request.resourceType()
      if (['image', 'media', 'font', 'other'].includes(resourceType)) {
        request.abort()
      } else {
        request.continue()
      }
    })
    
    console.log(`Iniciando navegación a ${url} (timeout: 90s)`)
    
    // Navegar a la URL con timeout y manejo de errores más robusto
    try {
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', // Cambiar a solo domcontentloaded para más velocidad
        timeout: 90000, // 90 segundos
      })
      // Esperar a que el selector body esté disponible antes de continuar
      await page.waitForSelector('body', { timeout: 30000 })
    } catch (navigationError) {
      console.warn(`Advertencia en navegación: ${navigationError}`)
      console.log('Intentando continuar con el análisis a pesar del error de navegación...')
      
      // Verificar si tenemos algo cargado a pesar del error
      const content = await page.content()
      if (!content || content.length < 1000) {
        throw new Error(`No se pudo navegar correctamente a ${url}: ${navigationError}`)
      }
      // Si llegamos aquí, tenemos algún contenido para analizar a pesar del error
    }
    
    // Esperar a que el sitio termine de cargarse y ejecutarse scripts
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Extraer metadatos mejorados
    const metadata = await page.evaluate(() => {
      return {
        title: document.title || '',
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') || 
                    document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
        favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href') || 
                 document.querySelector('link[rel="shortcut icon"]')?.getAttribute('href') || 
                 document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') || null,
        ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || null,
        url: document.location.href,
        domain: document.location.hostname
      }
    })
    
    // Analizar secciones de la página
    const sections = await analyzeSections(page)
    
    // Extraer el HTML completo de la página renderizada
    const rawHtml = await page.content();
    
    // Añadir logs para verificar el HTML
    console.log(`HTML capturado: ${rawHtml.length} caracteres`);
    console.log(`Primeros 100 caracteres del HTML: ${rawHtml.substring(0, 100)}`);
    
    return {
      title: metadata.title,
      description: metadata.description,
      sections,
      metadata: {
        favicon: metadata.favicon,
        ogImage: metadata.ogImage,
        themeColor: metadata.themeColor,
      },
      rawHtml
    }
  } finally {
    await browser.close()
  }
}

/**
 * Analiza las secciones de una página web de forma segura.
 * Implementa manejo de errores detallado para evitar fallos catastróficos.
 * @param page Instancia de la página de Puppeteer
 * @returns Lista de secciones identificadas
 */
async function analyzeSections(page: any): Promise<Section[]> {
  try {
    return await page.evaluate(() => {
      const sections: Section[] = []
      let position = 0
      
      // Estructura para recopilar errores sin romper el análisis
      const analysisErrors: { component: string, error: any }[] = []
      
      // Función para registrar errores sin interrumpir el proceso
      const logSectionError = (component: string, error: any) => {
        console.warn(`Error en sección ${component}:`, error)
        analysisErrors.push({ component, error: error.toString() })
      }
      
      // Función para analizar una sección de forma segura
      const analyzeSectionSafely = (sectionType: string, analyzerFn: () => void) => {
        try {
          analyzerFn()
        } catch (error) {
          logSectionError(sectionType, error)
        }
      }
      
      // Función utilitaria para consultas seguras de selectores
      const safeQuerySelector = (selector: string): Element | null => {
        try {
          return document.querySelector(selector)
        } catch (error) {
          console.warn(`Error al ejecutar selector: ${selector}`, error)
          return null
        }
      }
      
      const safeQuerySelectorAll = (selector: string, parent?: Element): Element[] => {
        try {
          const context = parent || document
          return Array.from(context.querySelectorAll(selector))
        } catch (error) {
          console.warn(`Error al ejecutar selector múltiple: ${selector}`, error)
          return []
        }
      }
      
      // Función para intentar múltiples selectores de forma segura
      const querySelectorWithFallbacks = (selectors: string[]): Element | null => {
        for (const selector of selectors) {
          try {
            const element = safeQuerySelector(selector)
            if (element) return element
          } catch (error) {
            console.warn(`Error con selector ${selector}:`, error)
          }
        }
        return null
      }
      
      // Función auxiliar para obtener el texto visible de un elemento
      const getVisibleText = (element: Element): string => {
        try {
          if (!element) return ''
          
          // Filtrar nodos de texto visibles
          let text = ''
          try {
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
              {
                acceptNode: function(node) {
                  try {
                    // Comprobar si el nodo está visible
                    if (!node.parentElement) return NodeFilter.FILTER_REJECT
                    
                    const style = window.getComputedStyle(node.parentElement as Element)
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                      return NodeFilter.FILTER_REJECT
                    }
                    return NodeFilter.FILTER_ACCEPT
                  } catch (error) {
                    console.warn('Error en acceptNode:', error)
                    return NodeFilter.FILTER_REJECT // Si hay error, rechazar el nodo
                  }
                }
              }
            )
            
            try {
              while(walker.nextNode()) {
                if (walker.currentNode && walker.currentNode.textContent) {
                  text += walker.currentNode.textContent + ' '
                }
              }
            } catch (walkError) {
              console.warn('Error en tree walker:', walkError)
            }
          } catch (treeWalkerError) {
            console.warn('Error al crear tree walker:', treeWalkerError)
            
            // Fallback: extraer texto de otra manera
            try {
              text = element.textContent || ''
            } catch (textError) {
              console.warn('Error al obtener textContent:', textError)
            }
          }
          
          return text.trim().replace(/\s+/g, ' ')
        } catch (error) {
          console.warn('Error en getVisibleText:', error)
          return '' // Devolver cadena vacía en caso de error
        }
      }
      
      // Función para comprobar si un elemento ya está en las secciones
      const isElementAlreadyIncluded = (element: Element): boolean => {
        try {
          if (!element) return true
          
          const elementId = element.id || ''
          const elementClass = (element.className || '').toString()
          
          // Validar el selector antes de usarlo
          const safeQuery = (selector: string): Element | null => {
            try {
              return document.querySelector(selector)
            } catch (error) {
              console.warn(`Error al ejecutar selector: ${selector}`, error)
              return null
            }
          }
          
          // Función para sanitizar una cadena de clase para uso en selectores
          const sanitizeClassSelector = (classString: string): string => {
            if (!classString) return ''
            // Eliminar caracteres problemáticos que podrían causar problemas en selectores
            return classString.split(' ')
              .filter(Boolean)
              .map(cls => cls.replace(/[^\w-]/g, '')) // Solo permitir caracteres alfanuméricos y guiones
              .join('.')
          }
          
          // Buscar por ID si está disponible
          if (elementId) {
            return sections.some(s => s.attributes?.id === elementId)
          }
          
          // Buscar por clase sanitizada
          if (elementClass) {
            const sanitizedClass = sanitizeClassSelector(elementClass)
            if (sanitizedClass) {
              try {
                const matchedElement = safeQuery(`.${sanitizedClass}`)
                return sections.some(s => matchedElement && s.attributes?.class === elementClass)
              } catch (error) {
                console.warn('Error al buscar por clase:', error)
              }
            }
          }
          
          // Comparación por contenido y posición como fallback
          return sections.some(s => {
            const sectionElement = document.getElementById(s.attributes?.id || '')
            if (sectionElement) {
              const rect1 = element.getBoundingClientRect()
              const rect2 = sectionElement.getBoundingClientRect()
              
              // Comparar las posiciones de los elementos
              return (
                Math.abs(rect1.top - rect2.top) < 50 &&
                Math.abs(rect1.left - rect2.left) < 50
              )
            }
            return false
          })
        } catch (error) {
          console.warn('Error en isElementAlreadyIncluded:', error)
          return false // Si hay error, asumimos que no está incluido
        }
      }
      
      // Ejecutar cada análisis de sección de forma segura
      analyzeSectionSafely('header', () => {
        // Buscar encabezado (header)
        const headerSelectors = ['header', 'nav', '.navbar', '.header', '[role="navigation"]']
        const headerElements = headerSelectors
          .map(selector => safeQuerySelector(selector))
          .filter(Boolean) as Element[]

        const header = headerElements.length > 0 ? headerElements[0] : null

        if (header && !isElementAlreadyIncluded(header)) {
          try {
            sections.push({
              type: 'header',
              content: getVisibleText(header),
              position: position++,
              elements: safeQuerySelectorAll('*', header).length,
              attributes: {
                id: header.id || '',
                class: (header.className || '').toString(),
              }
            })
          } catch (error) {
            console.warn('Error al procesar el header:', error)
          }
        }
      })
      
      analyzeSectionSafely('hero', () => {
        // Buscar hero section (mejorado)
        const heroSelectors = [
          '.hero',
          '.banner',
          '.jumbotron',
          '.main-banner',
          '.intro',
          '#hero',
          '[data-section="hero"]',
          '.hero-section',
          'section:first-of-type'
        ]
        
        let hero: Element | null = null
        
        // Intentar encontrar el hero usando los selectores
        hero = querySelectorWithFallbacks(heroSelectors)
        
        // Si no se encontró, buscar características comunes de un hero
        if (!hero) {
          try {
            // Buscar una sección con un h1 grande y un botón CTA cerca
            const mainHeadings = safeQuerySelectorAll('h1')
            for (const h1 of mainHeadings) {
              try {
                // Buscar el elemento padre más cercano de forma segura
                const getClosestParent = (element: Element, selector: string): Element | null => {
                  try {
                    // Intentar usar .closest() si está disponible
                    if (typeof element.closest === 'function') {
                      return element.closest(selector)
                    }
                    
                    // Fallback manual
                    let current = element
                    while (current) {
                      if (current.matches && current.matches(selector)) {
                        return current
                      }
                      if (!current.parentElement) break
                      current = current.parentElement
                    }
                    return null
                  } catch (error) {
                    console.warn(`Error al buscar padre cercano con selector ${selector}:`, error)
                    return null
                  }
                }
                
                // Buscar un contenedor padre apropiado
                const parent = getClosestParent(h1, 'section') || 
                               getClosestParent(h1, 'div[class*="hero"]') || 
                               h1.parentElement
                               
                if (parent) {
                  // Buscar elementos CTA de forma segura
                  const ctaElements = safeQuerySelectorAll('a.btn, button, a.button, .cta', parent)
                  if (ctaElements.length > 0) {
                    hero = parent
                    break
                  }
                }
              } catch (error) {
                console.warn('Error al procesar un h1 para hero:', error)
              }
            }
          } catch (error) {
            console.warn('Error al buscar hero alternativo:', error)
          }
        }
        
        if (hero && !isElementAlreadyIncluded(hero)) {
          try {
            sections.push({
              type: 'hero',
              content: getVisibleText(hero),
              position: position++,
              elements: safeQuerySelectorAll('*', hero).length,
              attributes: {
                id: hero.id || '',
                class: (hero.className || '').toString(),
              }
            })
          } catch (error) {
            console.warn('Error al procesar el hero:', error)
          }
        }
      })
      
      analyzeSectionSafely('features', () => {
        // Buscar secciones de características (features)
        try {
          // Recolectar elementos potenciales de features de forma segura
          const featuresSections: Element[] = []
          
          // Buscar por clase features
          const featuresByClass = safeQuerySelectorAll('.features')
          featuresSections.push(...featuresByClass)
          
          // Buscar por encabezados que contienen "features" o "características"
          try {
            const h2Elements = safeQuerySelectorAll('section h2')
            
            for (const h2 of h2Elements) {
              try {
                const h2Text = (h2.textContent || '').toLowerCase()
                if (h2Text.includes('features') || h2Text.includes('características')) {
                  // Buscar la sección contenedora de forma segura
                  const getClosestSection = (element: Element): Element | null => {
                    try {
                      if (typeof element.closest === 'function') {
                        return element.closest('section')
                      }
                      
                      // Fallback: buscar un ancestro que sea section
                      let current = element.parentElement
                      while (current) {
                        if (current.tagName && current.tagName.toLowerCase() === 'section') {
                          return current
                        }
                        current = current.parentElement
                      }
                      return null
                    } catch (error) {
                      console.warn('Error al buscar section contenedora:', error)
                      return null
                    }
                  }
                  
                  const section = getClosestSection(h2)
                  if (section) {
                    featuresSections.push(section)
                  }
                }
              } catch (h2Error) {
                console.warn('Error al procesar h2 para features:', h2Error)
              }
            }
          } catch (h2QueryError) {
            console.warn('Error al buscar h2 para features:', h2QueryError)
          }
          
          // Buscar divs con clase que contenga "feature"
          try {
            // Selector más seguro para buscar divs con feature en la clase
            const divsByFeatureClass = safeQuerySelectorAll('div[class*="feature"]')
            featuresSections.push(...divsByFeatureClass)
          } catch (divError) {
            console.warn('Error al buscar divs para features:', divError)
          }
          
          if (featuresSections.length > 0) {
            try {
              // Tomar el contenedor padre si hay múltiples elementos de características
              let featuresContainer = featuresSections[0]
              
              if (featuresSections.length > 2 && featuresSections[0]?.parentElement) {
                featuresContainer = featuresSections[0].parentElement
              }
              
              if (featuresContainer && !isElementAlreadyIncluded(featuresContainer)) {
                sections.push({
                  type: 'features',
                  content: getVisibleText(featuresContainer),
                  position: position++,
                  elements: safeQuerySelectorAll('*', featuresContainer).length,
                  attributes: {
                    id: featuresContainer.id || '',
                    class: (featuresContainer.className || '').toString(),
                  }
                })
              }
            } catch (containerError) {
              console.warn('Error al procesar contenedor de features:', containerError)
            }
          }
        } catch (featuresError) {
          console.warn('Error al buscar secciones de features:', featuresError)
        }
      })
      
      // Buscar sección de testimonios
      const testimonialSelectors = [
        '.testimonials',
        '.reviews',
      ]
      
      // Buscar blockquotes para potenciales testimonios
      const blockquotes = Array.from(document.querySelectorAll('blockquote'))
      const testimonialSectionFromBlockquote = blockquotes.length > 0 ? 
        blockquotes[0].closest('section') : null
      
      const testimonialsElement = testimonialSelectors.reduce(
        (found, selector) => found || document.querySelector(selector), 
        null as Element | null
      ) || testimonialSectionFromBlockquote
      
      if (testimonialsElement && !isElementAlreadyIncluded(testimonialsElement)) {
        sections.push({
          type: 'testimonials',
          content: getVisibleText(testimonialsElement),
          position: position++,
          elements: testimonialsElement.querySelectorAll('*').length,
          attributes: {
            id: testimonialsElement.id || '',
            class: testimonialsElement.className || '',
          }
        })
      }
      
      // Mejora para detectar secciones de contenido
      const contentSelectors = [
        'main',
        'article',
        '.content',
        '#content',
        '[role="main"]'
      ]
      
      let mainContent: Element | null = null
      
      // Encontrar el contenido principal
      for (const selector of contentSelectors) {
        const element = document.querySelector(selector)
        if (element && !isElementAlreadyIncluded(element)) {
          mainContent = element
          break
        }
      }
      
      if (mainContent) {
        // Buscar secciones dentro del contenido principal
        const contentSections = Array.from(mainContent.querySelectorAll('section, article, .section, [data-section]'))
        
        // Si no hay secciones definidas, usar divisiones claras
        if (contentSections.length === 0) {
          const contentDivisions = Array.from(mainContent.querySelectorAll('div > h2, div > h3')).map(
            heading => heading.parentElement
          ).filter(Boolean) as Element[]
          
          // Procesar cada división como una sección potencial
          contentDivisions.forEach(division => {
            if (division && !isElementAlreadyIncluded(division)) {
              // Determinar el tipo basado en el contenido
              let type: SectionType = 'unknown'
              const text = getVisibleText(division).toLowerCase()
              const classes = division.className.toLowerCase() || ''
              
              // Detectar tipo basado en texto y clases
              if (text.includes('about') || classes.includes('about')) {
                type = 'about'
              } else if (text.includes('contact') || classes.includes('contact')) {
                type = 'contact'
              } else if (text.includes('faq') || text.includes('frequently asked') || classes.includes('faq')) {
                type = 'faq'
              } else if (text.includes('team') || text.includes('our people') || classes.includes('team')) {
                type = 'team'
              } else if (text.includes('gallery') || text.includes('portfolio') || classes.includes('gallery')) {
                type = 'gallery'
              } else if (text.includes('blog') || text.includes('news') || classes.includes('blog')) {
                type = 'blog'
              } else if (text.includes('services') || text.includes('what we do') || classes.includes('services')) {
                type = 'services'
              }
              
              sections.push({
                type,
                content: getVisibleText(division),
                position: position++,
                elements: division.querySelectorAll('*').length,
                attributes: {
                  id: division.id || '',
                  class: division.className || '',
                }
              })
            }
          })
        }
      }
      
      // Buscar footer (mejorado)
      const footerSelectors = [
        'footer',
        '.footer',
        '#footer',
        '[data-section="footer"]',
        '.site-footer'
      ]
      
      let footer: Element | null = null
      
      for (const selector of footerSelectors) {
        const element = document.querySelector(selector)
        if (element && !isElementAlreadyIncluded(element)) {
          footer = element
          break
        }
      }
      
      if (footer) {
        sections.push({
          type: 'footer',
          content: getVisibleText(footer),
          position: position++,
          elements: footer.querySelectorAll('*').length,
          attributes: {
            id: footer.id || '',
            class: footer.className || '',
          }
        })
      }
      
      // Registrar errores como una sección especial si hubo problemas
      if (analysisErrors.length > 0) {
        sections.push({
          type: 'error-log',
          content: JSON.stringify(analysisErrors),
          position: 999, // Al final
          elements: analysisErrors.length,
          attributes: {
            errorCount: String(analysisErrors.length)
          }
        })
      }
      
      return sections
    })
  } catch (error) {
    const evaluateError = error as Error
    console.error('Error crítico al analizar secciones:', evaluateError)
    
    // Devolver al menos un resultado con el error para que no se interrumpa todo el análisis
    return [{
      type: 'error',
      content: `Error al analizar secciones: ${evaluateError.message || 'Error desconocido'}`,
      position: 0,
      elements: 0,
      attributes: {
        error: 'true',
        stack: evaluateError.stack || ''
      }
    }]
  }
}

// Crear una nueva función para capturar el HTML completo sin sanitizar
async function captureCompleteHTML(url: string, options?: { timeout?: number; userAgent?: string }): Promise<{html: string, screenshot: string}> {
  console.log(`Capturando HTML completo y screenshot para: ${url}`);
  const startTime = Date.now();
  
  // Valores por defecto
  const timeout = options?.timeout || 30000;
  const userAgent = options?.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
  
  // Lanzar navegador con configuración óptima para captura completa
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--allow-running-insecure-content', // Permite contenido mixto (http en https)
      '--disable-popup-blocking', // No bloquear popups
      '--disable-extensions', // Desactivar extensiones
      '--ignore-certificate-errors', // Ignorar errores de certificados
    ],
  });
  
  try {
    // Abrir nueva página
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    await page.setDefaultNavigationTimeout(timeout);
    
    // No interceptar solicitudes - permitimos todas para obtener la página completa
    await page.setRequestInterception(false);
    
    // Configurar resolución de MacBook Pro de 15 pulgadas
    await page.setViewport({ 
      width: 2880, 
      height: 1800,
      deviceScaleFactor: 2.0 // Retina display
    });
    
    console.log(`Iniciando navegación a ${url} (timeout: ${timeout}ms)`);
    
    try {
      // Navegar con timeout generoso
      await page.goto(url, {
        waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
        timeout: timeout
      });
    } catch (navError) {
      console.warn(`Advertencia en navegación: ${navError}`);
      console.log('Intentando continuar aunque la navegación no se completara perfectamente...');
    }
    
    // Esperar tiempo adicional para cargar recursos dinámicos
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Realizar scroll para activar carga de elementos lazy
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 250;
        const scrollHeight = document.body.scrollHeight;
        
        console.log(`Altura total de la página: ${scrollHeight}px`);
        
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            console.log(`Scroll completado: ${totalHeight}px recorridos`);
            
            // Esperar un poco más después del scroll
            setTimeout(() => {
              // Volver al inicio
              window.scrollTo(0, 0);
              resolve(true);
            }, 1000);
          }
        }, 100);
      });
    });
    
    // Esperar un poco más tras el scroll
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Obtener el HTML COMPLETO sin sanitizar ni ofuscar scripts
    const html = await page.content();
    
    // Verificar que el HTML capturado no tenga marcadores de ofuscación
    if (html.includes('[script-content-removed]') || html.includes('[data-attr-removed]')) {
      console.error('⚠️ El HTML todavía contiene marcadores de ofuscación - hay un problema de captura');
    }
    
    // Capturar screenshot de la página completa
    console.log('Capturando screenshot de la página completa...');
    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'jpeg',
      quality: 90
    }) as Buffer;
    
    // Convertir la imagen a base64
    const screenshotBase64 = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
    console.log(`Screenshot capturado: ${(screenshotBase64.length / 1024 / 1024).toFixed(2)} MB`);
    
    // Tiempo total de captura
    const endTime = Date.now();
    console.log(`Tiempo total de captura: ${((endTime - startTime) / 1000).toFixed(2)} segundos`);
    
    return {
      html,
      screenshot: screenshotBase64
    };
  } finally {
    // Cerrar el navegador
    await browser.close();
  }
}

// Modificar la función getSiteHtml para usar la nueva implementación
export async function getSiteHtml(url: string, options?: { depth?: number; timeout?: number; userAgent?: string }) {
  try {
    console.log(`Fetching HTML for: ${url}`);
    
    // Usar la nueva función de captura completa
    const { html, screenshot } = await captureCompleteHTML(url, {
      timeout: options?.timeout || 30000,
      userAgent: options?.userAgent
    });
    
    // Verificar que se haya capturado un screenshot
    if (screenshot) {
      console.log(`Screenshot obtenido correctamente de tipo data URI`);
      console.log(`Longitud del screenshot: ${screenshot.length} caracteres`);
    } else {
      console.warn('No se obtuvo screenshot en la captura.');
    }
    
    return {
      html,
      screenshot
    };
  } catch (error) {
    console.error(`Failed to get HTML: ${error}`);
    throw error;
  }
}

// Modificar la función principal de análisis para asegurar el HTML adecuado
export async function analyzeSite(url: string, options?: { depth?: number; timeout?: number; userAgent?: string }): Promise<any> {
  console.log(`Analyzing site: ${url}`);
  const startTime = Date.now();
  
  try {
    // Normalizar la URL para asegurar que tenga el formato correcto
    let normalizedUrl = url;
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
    }
    
    console.log(`URL normalizada: ${normalizedUrl}`);
    
    // Intentar capturar el HTML con manejo de errores mejorado
    let html = '';
    let screenshot = '';
    try {
      const result = await getSiteHtml(normalizedUrl, {
        timeout: options?.timeout || 60000, // Aumentar timeout por defecto a 60 segundos
        userAgent: options?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
      });
      
      html = result.html;
      screenshot = result.screenshot;
      
      // Verificar si el HTML obtenido es válido
      if (!html || html.length < 2000) {
        console.warn(`Advertencia: HTML capturado es muy pequeño (${html?.length || 0} bytes)`);
        // Intentar obtener HTML mediante un método alternativo
        console.log("Intentando método alternativo para obtener HTML...");
        try {
          // Implementar aquí un método alternativo para obtener HTML (por ejemplo, una solicitud fetch simple)
          if (!html) {
            html = await fetch(normalizedUrl).then(res => res.text());
            console.log(`Método alternativo obtuvo ${html.length} bytes de HTML`);
          }
        } catch (altError) {
          console.error(`Error en método alternativo: ${altError}`);
          // Continuamos con lo que tengamos
        }
      }
    } catch (htmlError) {
      console.error(`Error al obtener HTML: ${htmlError}`);
      // Intentamos un método de respaldo para obtener algo de contenido
      try {
        console.log("Error en navegación principal, intentando método de respaldo simple...");
        html = await fetch(normalizedUrl).then(res => res.text());
        console.log(`Método de respaldo obtuvo ${html.length} bytes de HTML`);
      } catch (fallbackError) {
        console.error(`También falló el método de respaldo: ${fallbackError}`);
        return {
          success: false,
          error: `No se pudo obtener HTML del sitio: ${fallbackError}`,
          url: normalizedUrl,
          partial_results: {
            url: normalizedUrl,
            timestamp: new Date().toISOString(),
            error: `${htmlError} / ${fallbackError}`
          }
        };
      }
    }
    
    console.log(`HTML capturado correctamente: ${html.length} bytes`);
    if (screenshot) {
      console.log(`Screenshot capturado correctamente: ${Math.round(screenshot.length / 1024)} KB`);
    }
    console.log(`Tiempo de captura HTML: ${Date.now() - startTime}ms`);
    
    // Continuar con el análisis utilizando el HTML obtenido
    try {
      const request = {
        url: normalizedUrl,
        htmlContent: html,
        screenshot: screenshot,
        options
      };
      
      const analysis = await completeAnalysis(request);
      
      // Agregar el HTML a la respuesta para futuros análisis (como el estructurado)
      analysis.rawHtml = html;
      analysis.screenshot = screenshot;
      
      // En lugar de agregar directamente al objeto analysis, vamos a incluirlo en el objeto de respuesta
      console.log(`Análisis completado en ${Date.now() - startTime}ms`);
      return {
        success: true,
        url: normalizedUrl,
        originalUrl: url,
        analysis
      };
    } catch (analysisError) {
      console.error(`Error en el análisis: ${analysisError}`);
      // Devolver resultado parcial con el HTML capturado
      return {
        success: false,
        error: `Error en el análisis: ${analysisError}`,
        url: normalizedUrl,
        html_length: html.length,
        has_screenshot: Boolean(screenshot),
        partial_results: {
          url: normalizedUrl,
          timestamp: new Date().toISOString(),
          html_sample: html.substring(0, 500) + '...' // Muestra solo parte del HTML para debug
        }
      };
    }
  } catch (error) {
    console.error(`Error crítico en analyzeSite: ${error}`);
    return {
      success: false,
      error: `Error crítico: ${error}`,
      url
    };
  }
} 