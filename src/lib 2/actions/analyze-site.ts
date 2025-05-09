export async function analyzeSiteAction(params: z.infer<typeof AnalyzeSiteParamsSchema>): Promise<AnalyzeSiteResult> {
  try {
    // Validar parámetros
    const { url, ip } = AnalyzeSiteParamsSchema.parse(params)
    
    // Implementar rate limiting basado en IP
    const rateLimitResult = await checkRateLimit(ip)
    if (!rateLimitResult.success) {
      return {
        success: false,
        error: rateLimitResult.error
      }
    }
    
    // Analizar el sitio web
    const analysis = await analyzeSite(url)
    
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
 * Verifica si una IP ha excedido el límite de solicitudes
 * @param ip Dirección IP del usuario
 * @returns Resultado de la verificación
 */
async function checkRateLimit(ip: string): Promise<{ success: boolean, error?: string }> {
  // TODO: Implementar almacenamiento persistente (Redis, base de datos, etc.)
  // Por ahora, usando un mapa en memoria (esto se reinicia con cada despliegue)
  const RATE_LIMIT_WINDOW = 60 * 60 * 1000 // 1 hora en milisegundos
  const MAX_REQUESTS_PER_WINDOW = 10 // Máximo número de solicitudes por ventana

  // Mapa en memoria para seguimiento de IPs
  const ipRequestMap = new Map<string, { count: number, firstRequest: number }>()
  
  const now = Date.now()
  const ipData = ipRequestMap.get(ip)
  
  if (!ipData) {
    // Primera solicitud de esta IP
    ipRequestMap.set(ip, { count: 1, firstRequest: now })
    return { success: true }
  }
  
  // Comprobar si estamos en una nueva ventana de tiempo
  if (now - ipData.firstRequest > RATE_LIMIT_WINDOW) {
    // Reiniciar contador para nueva ventana
    ipRequestMap.set(ip, { count: 1, firstRequest: now })
    return { success: true }
  }
  
  // Verificar límite de solicitudes
  if (ipData.count >= MAX_REQUESTS_PER_WINDOW) {
    const minutesRemaining = Math.ceil((RATE_LIMIT_WINDOW - (now - ipData.firstRequest)) / (60 * 1000))
    return { 
      success: false, 
      error: `Límite de solicitudes excedido. Inténtalo nuevamente en ${minutesRemaining} minutos.` 
    }
  }
  
  // Incrementar contador
  ipRequestMap.set(ip, { ...ipData, count: ipData.count + 1 })
  return { success: true }
}

// Actualizar la interfaz SiteAnalysis para incluir más metadatos
interface SiteAnalysis {
  title: string
  description: string
  sections: Section[]
  metadata: {
    favicon: string | null
    ogImage: string | null
    themeColor: string | null
    technologies: string[]
    colors: string[]
    fonts: string[]
    language: string | null
    viewport: string | null
    responsive: boolean
    hasSchema: boolean
  }
  performance: {
    totalElements: number
    domDepth: number
    imagesCount: number
    scriptsCount: number
    stylesheetsCount: number
  }
}

// Actualizar la interfaz Section para incluir metadatos enriquecidos
interface Section {
  type: SectionType
  content: string
  position: number
  elements: number
  attributes?: Record<string, string>
  semantics: {
    headings: { level: number, text: string }[]
    paragraphs: number
    images: {
      count: number
      srcs: string[]
      alts: string[]
    }
    links: {
      count: number
      texts: string[]
      hrefs: string[]
    }
    buttons: {
      count: number
      texts: string[]
      types: string[]
    }
    lists: {
      count: number
      items: number
    }
    forms: {
      count: number
      fields: number
      submitTexts: string[]
    }
  }
  style: {
    backgroundColor: string | null
    textColor: string | null
    fontFamily: string | null
    backgroundImage: string | null
    padding: string | null
    layout: 'row' | 'column' | 'grid' | 'unknown'
    alignment: 'left' | 'center' | 'right' | 'justified' | 'unknown'
  }
}

// Ampliar los tipos de secciones
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
  | 'newsletter'
  | 'stats'
  | 'partners'
  | 'product'
  | 'video'
  | 'comparison'
  | 'portfolio'
  | 'timeline'
  | 'login'
  | 'signup'
  | 'search'
  | 'checkout'
  | 'cart'
  | 'social'
  | 'map'
  | 'unknown'

/**
 * Analiza un sitio web para extraer su estructura y contenido
 * @param url URL del sitio a analizar
 * @returns Análisis del sitio
 */
async function analyzeSite(url: string): Promise<SiteAnalysis> {
  // Lanzar navegador headless para capturar el contenido post-render
  const browser = await puppeteer.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    timeout: 60000
  })
  const page = await browser.newPage()
  
  try {
    // Configurar timeouts y user-agent
    await page.setDefaultNavigationTimeout(45000)
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36')
    
    // Interceptar solicitudes para mejorar rendimiento
    await page.setRequestInterception(true)
    page.on('request', (request: any) => {
      // Permitir imágenes para el análisis visual pero bloquear otros recursos pesados
      const resourceType = request.resourceType()
      if (['media', 'font', 'other'].includes(resourceType)) {
        request.abort()
      } else {
        request.continue()
      }
    })
    
    // Navegar a la URL con timeout
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 45000,
    })
    
    // Esperar a que el contenido principal cargue
    await page.waitForSelector('body', { timeout: 10000 })
    
    // Esperar un poco más para asegurar que el JavaScript se ejecute
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    // Extraer metadatos mejorados
    const metadata = await page.evaluate(() => {
      // Función para detectar colores dominantes
      const extractDominantColors = () => {
        const colors: string[] = []
        const styleSheets = Array.from(document.styleSheets)
        
        try {
          styleSheets.forEach(sheet => {
            try {
              if (!sheet.cssRules) return
              Array.from(sheet.cssRules).forEach((rule: any) => {
                if (rule.style) {
                  const bgColor = rule.style.backgroundColor
                  const color = rule.style.color
                  
                  if (bgColor && bgColor !== 'transparent' && bgColor !== 'rgba(0, 0, 0, 0)') {
                    if (!colors.includes(bgColor)) colors.push(bgColor)
                  }
                  
                  if (color && color !== 'inherit') {
                    if (!colors.includes(color)) colors.push(color)
                  }
                }
              })
            } catch (e) {
              // Ignorar errores CORS
            }
          })
        } catch (e) {
          // Ignorar errores generales
        }
        
        // Limitar a los 10 colores más comunes
        return colors.slice(0, 10)
      }
      
      // Función para detectar fuentes usadas
      const extractFonts = () => {
        const fonts: string[] = []
        const elements = document.querySelectorAll('body, h1, h2, h3, p, a, button')
        
        elements.forEach(el => {
          const fontFamily = window.getComputedStyle(el).fontFamily
          if (fontFamily && !fonts.includes(fontFamily)) {
            fonts.push(fontFamily)
          }
        })
        
        return fonts
      }
      
      // Detectar tecnologías mediante marcadores comunes
      const detectTechnologies = () => {
        const technologies: string[] = []
        
        // Detectar frameworks y libraries comunes
        if (document.querySelector('[data-reactroot], [data-reactid]') || window.hasOwnProperty('React')) 
          technologies.push('React')
        
        if (window.hasOwnProperty('angular') || document.querySelector('[ng-app], [ng-controller], [ng-model]')) 
          technologies.push('Angular')
        
        if (window.hasOwnProperty('Vue')) 
          technologies.push('Vue.js')
        
        if (document.querySelector('.wp-block, .wp-content') || document.querySelector('meta[name="generator"][content*="WordPress"]'))
          technologies.push('WordPress')
        
        if (document.querySelector('html[data-wf-site], .w-webflow'))
          technologies.push('Webflow')
        
        if (document.querySelector('.elementor'))
          technologies.push('Elementor')
        
        if (document.querySelector('html[data-n-head-ssr]') || window.hasOwnProperty('__NUXT__'))
          technologies.push('Nuxt.js')
        
        if (window.hasOwnProperty('__NEXT_DATA__'))
          technologies.push('Next.js')
        
        if (document.querySelector('[class*="tailwind"], [class*="tw-"]') || 
            Array.from(document.querySelectorAll('[class]')).some(el => 
              el.className.split(' ').some(cls => /^(bg|text|flex|grid|p|m|w|h)-/.test(cls))
            ))
          technologies.push('Tailwind CSS')
        
        if (document.querySelector('.MuiButton-root, .MuiTypography-root'))
          technologies.push('Material UI')
        
        if (document.querySelector('.chakra-'))
          technologies.push('Chakra UI')
        
        if (document.querySelector('.ant-'))
          technologies.push('Ant Design')
        
        // Detectar analíticas y marketing
        if (window.hasOwnProperty('ga') || window.hasOwnProperty('gtag') || 
            document.querySelector('script[src*="google-analytics"], script[src*="googletagmanager"]'))
          technologies.push('Google Analytics')
        
        if (document.querySelector('script[src*="facebook"], script[src*="fbevents"], .fb-page, .fb-like'))
          technologies.push('Facebook')
        
        if (document.querySelector('script[src*="hotjar"]'))
          technologies.push('Hotjar')
        
        return technologies
      }
      
      // Comprobar si el sitio es responsive
      const isResponsive = () => {
        return !!document.querySelector('meta[name="viewport"][content*="width=device-width"]')
      }
      
      // Comprobar si tiene datos estructurados (schema.org)
      const hasSchema = () => {
        return !!document.querySelector('script[type="application/ld+json"]')
      }
      
      return {
        title: document.title || '',
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') || 
                    document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
        favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href') || 
                 document.querySelector('link[rel="shortcut icon"]')?.getAttribute('href') || 
                 document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') || null,
        ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || null,
        language: document.documentElement.lang || null,
        viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || null,
        url: document.location.href,
        domain: document.location.hostname,
        technologies: detectTechnologies(),
        colors: extractDominantColors(),
        fonts: extractFonts(),
        responsive: isResponsive(),
        hasSchema: hasSchema()
      }
    })
    
    // Recopilar métricas de rendimiento
    const performance = await page.evaluate(() => {
      return {
        totalElements: document.querySelectorAll('*').length,
        domDepth: (() => {
          let deepestElement = document.body
          let maxDepth = 0
          
          function checkDepth(element: Element, depth: number) {
            if (depth > maxDepth) {
              maxDepth = depth
              deepestElement = element
            }
            
            for (let i = 0; i < element.children.length; i++) {
              checkDepth(element.children[i], depth + 1)
            }
          }
          
          checkDepth(document.body, 0)
          return maxDepth
        })(),
        imagesCount: document.querySelectorAll('img').length,
        scriptsCount: document.querySelectorAll('script').length,
        stylesheetsCount: document.querySelectorAll('link[rel="stylesheet"]').length
      }
    })
    
    // Analizar secciones de la página con más detalle
    const sections = await analyzeSections(page)
    
    return {
      title: metadata.title,
      description: metadata.description,
      sections,
      metadata: {
        favicon: metadata.favicon,
        ogImage: metadata.ogImage,
        themeColor: metadata.themeColor,
        technologies: metadata.technologies,
        colors: metadata.colors,
        fonts: metadata.fonts,
        language: metadata.language,
        viewport: metadata.viewport,
        responsive: metadata.responsive,
        hasSchema: metadata.hasSchema
      },
      performance
    }
  } finally {
    await browser.close()
  }
}

/**
 * Analiza las secciones de una página web
 * @param page Página de Puppeteer
 * @returns Lista de secciones identificadas
 */
async function analyzeSections(page: any): Promise<Section[]> {
  return await page.evaluate(() => {
    const sections: Section[] = []
    let position = 0
    
    // Función auxiliar para obtener el texto visible de un elemento
    const getVisibleText = (element: Element): string => {
      if (!element) return ''
      
      // Filtrar nodos de texto visibles
      let text = ''
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            // Comprobar si el nodo está visible
            const style = window.getComputedStyle(node.parentElement as Element)
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return NodeFilter.FILTER_REJECT
            }
            return NodeFilter.FILTER_ACCEPT
          }
        }
      )
      
      while(walker.nextNode()) {
        text += walker.currentNode.textContent + ' '
      }
      
      return text.trim().replace(/\s+/g, ' ')
    }
    
    // Función para comprobar si un elemento ya está en las secciones
    const isElementAlreadyIncluded = (element: Element): boolean => {
      if (!element) return true
      
      const elementId = element.id || ''
      const elementClass = element.className || ''
      
      return sections.some(s => 
        (elementId && s.attributes?.id === elementId) || 
        (elementClass && element === document.querySelector(`.${elementClass.split(' ').join('.')}`))
      )
    }
    
    // Función para analizar los elementos semánticos de una sección
    const analyzeSemantics = (element: Element) => {
      // Extraer encabezados
      const headings = Array.from(element.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
        level: parseInt(h.tagName.substring(1)),
        text: h.textContent?.trim() || ''
      }))
      
      // Extraer imágenes
      const images = Array.from(element.querySelectorAll('img'))
      const imagesData = {
        count: images.length,
        srcs: images.map(img => img.getAttribute('src') || '').filter(Boolean),
        alts: images.map(img => img.getAttribute('alt') || '').filter(Boolean)
      }
      
      // Extraer enlaces
      const links = Array.from(element.querySelectorAll('a:not(button)'))
      const linksData = {
        count: links.length,
        texts: links.map(link => link.textContent?.trim() || '').filter(Boolean),
        hrefs: links.map(link => link.getAttribute('href') || '').filter(Boolean)
      }
      
      // Extraer botones
      const buttons = Array.from(element.querySelectorAll('button, a.button, a.btn, [class*="btn-"], [role="button"]'))
      const buttonsData = {
        count: buttons.length,
        texts: buttons.map(btn => btn.textContent?.trim() || '').filter(Boolean),
        types: buttons.map(btn => {
          const text = btn.textContent?.toLowerCase().trim() || ''
          if (text.includes('sign up') || text.includes('register') || text.includes('join')) return 'signup'
          if (text.includes('log in') || text.includes('login') || text.includes('sign in')) return 'login'
          if (text.includes('contact') || text.includes('get in touch')) return 'contact'
          if (text.includes('learn more') || text.includes('read more')) return 'learn'
          if (text.includes('buy') || text.includes('purchase') || text.includes('get')) return 'purchase'
          if (text.includes('download')) return 'download'
          if (text.includes('submit')) return 'submit'
          if (text.includes('try') || text.includes('start')) return 'trial'
          return 'generic'
        })
      }
      
      // Extraer listas
      const lists = Array.from(element.querySelectorAll('ul, ol'))
      const listsData = {
        count: lists.length,
        items: lists.reduce((acc, list) => acc + list.querySelectorAll('li').length, 0)
      }
      
      // Extraer formularios
      const forms = Array.from(element.querySelectorAll('form'))
      const formsData = {
        count: forms.length,
        fields: forms.reduce((acc, form) => 
          acc + form.querySelectorAll('input, select, textarea').length, 0),
        submitTexts: forms.map(form => {
          const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]')
          return submitBtn?.textContent?.trim() || 
                 (submitBtn as HTMLInputElement)?.value || 'Submit'
        })
      }
      
      return {
        headings,
        paragraphs: element.querySelectorAll('p').length,
        images: imagesData,
        links: linksData,
        buttons: buttonsData,
        lists: listsData,
        forms: formsData
      }
    }
    
    // Función para analizar el estilo de una sección
    const analyzeStyle = (element: Element) => {
      const computedStyle = window.getComputedStyle(element)
      
      // Detectar tipo de layout
      let layout: 'row' | 'column' | 'grid' | 'unknown' = 'unknown'
      
      if (computedStyle.display === 'grid') {
        layout = 'grid'
      } else if (computedStyle.display.includes('flex')) {
        layout = computedStyle.flexDirection.includes('row') ? 'row' : 'column'
      }
      
      // Detectar alineación de texto
      let alignment: 'left' | 'center' | 'right' | 'justified' | 'unknown' = 'unknown'
      const textAlign = computedStyle.textAlign
      
      if (textAlign === 'left' || textAlign === 'start') alignment = 'left'
      else if (textAlign === 'center') alignment = 'center'
      else if (textAlign === 'right' || textAlign === 'end') alignment = 'right'
      else if (textAlign === 'justify') alignment = 'justified'
      
      return {
        backgroundColor: computedStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' ? computedStyle.backgroundColor : null,
        textColor: computedStyle.color,
        fontFamily: computedStyle.fontFamily,
        backgroundImage: computedStyle.backgroundImage !== 'none' ? computedStyle.backgroundImage : null,
        padding: computedStyle.padding !== '0px' ? computedStyle.padding : null,
        layout,
        alignment
      }
    }
    
    // Función para determinar qué tipo de sección es basado en el contenido y atributos
    const determineSectionType = (element: Element, backupType: SectionType = 'unknown'): SectionType => {
      const elementClasses = element.className?.toLowerCase() || ''
      const elementId = element.id?.toLowerCase() || ''
      const text = getVisibleText(element).toLowerCase()
      const tagName = element.tagName.toLowerCase()
      
      // Comprobar atributos data o roles específicos
      const dataSection = element.getAttribute('data-section')
      if (dataSection) return dataSection as SectionType
      
      // Verificar clases e IDs
      if (elementClasses.includes('hero') || elementId.includes('hero')) return 'hero'
      if (elementClasses.includes('header') || elementId.includes('header') || tagName === 'header') return 'header'
      if (elementClasses.includes('footer') || elementId.includes('footer') || tagName === 'footer') return 'footer'
      if (elementClasses.includes('feature') || elementId.includes('feature')) return 'features'
      if (elementClasses.includes('testimonial') || elementId.includes('testimonial')) return 'testimonials'
      if (elementClasses.includes('pricing') || elementId.includes('pricing')) return 'pricing'
      if (elementClasses.includes('cta') || elementId.includes('cta')) return 'cta'
      if (elementClasses.includes('about') || elementId.includes('about')) return 'about'
      if (elementClasses.includes('contact') || elementId.includes('contact')) return 'contact'
      if (elementClasses.includes('faq') || elementId.includes('faq')) return 'faq'
      if (elementClasses.includes('team') || elementId.includes('team')) return 'team'
      if (elementClasses.includes('gallery') || elementId.includes('gallery')) return 'gallery'
      if (elementClasses.includes('blog') || elementId.includes('blog')) return 'blog'
      if (elementClasses.includes('newsletter') || elementId.includes('newsletter')) return 'newsletter'
      if (elementClasses.includes('login') || elementId.includes('login')) return 'login'
      if (elementClasses.includes('signup') || elementId.includes('signup')) return 'signup'
      
      // Analizar contenido para determinar tipo
      if (text.includes('sign up') || text.includes('subscribe')) {
        if (element.querySelectorAll('form, input[type="email"]').length > 0) {
          return 'newsletter'
        }
      }
      
      if (element.querySelectorAll('blockquote, .testimonial, .review, [class*="testimonial"]').length > 0) {
        return 'testimonials'
      }
      
      if (text.includes('pricing') || text.includes('plan') || text.includes('subscription')) {
        if (element.querySelectorAll('table, .price, .pricing, [class*="price"]').length > 0) {
          return 'pricing'
        }
      }
      
      if (text.includes('faq') || text.includes('frequently asked question')) {
        return 'faq'
      }
      
      if (element.querySelectorAll('iframe[src*="map"], [class*="map"]').length > 0) {
        return 'map'
      }
      
      if (element.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"], video').length > 0) {
        return 'video'
      }
      
      if (element.querySelectorAll('form').length > 0) {
        // Determinar qué tipo de formulario
        const formText = getVisibleText(element.querySelector('form') as Element).toLowerCase()
        
        if (formText.includes('login') || formText.includes('sign in')) {
          return 'login'
        }
        
        if (formText.includes('register') || formText.includes('sign up')) {
          return 'signup'
        }
        
        if (formText.includes('contact') || formText.includes('message')) {
          return 'contact'
        }
        
        if (formText.includes('search')) {
          return 'search'
        }
      }
      
      // Comprobar headings para determinar el tipo
      const headings = Array.from(element.querySelectorAll('h1, h2, h3'))
      for (const heading of headings) {
        const headingText = heading.textContent?.toLowerCase() || ''
        
        if (headingText.includes('about')) return 'about'
        if (headingText.includes('service')) return 'services'
        if (headingText.includes('feature')) return 'features'
        if (headingText.includes('contact')) return 'contact'
        if (headingText.includes('team') || headingText.includes('our people')) return 'team'
        if (headingText.includes('client') || headingText.includes('testimonial')) return 'testimonials'
        if (headingText.includes('faq')) return 'faq'
        if (headingText.includes('blog') || headingText.includes('article')) return 'blog'
        if (headingText.includes('portfolio') || headingText.includes('work')) return 'portfolio'
        if (headingText.includes('stat') || headingText.includes('number')) return 'stats'
        if (headingText.includes('partner') || headingText.includes('client')) return 'partners'
      }
      
      return backupType
    }

    // Buscar encabezado (header)
    const headerElements = [
      document.querySelector('header'),
      document.querySelector('nav'),
      document.querySelector('.navbar'),
      document.querySelector('.header'),
      document.querySelector('[role="navigation"]')
    ].filter(Boolean) as Element[]
    
    const header = headerElements.length > 0 ? headerElements[0] : null
    
    if (header && !isElementAlreadyIncluded(header)) {
      sections.push({
        type: 'header',
        content: getVisibleText(header),
        position: position++,
        elements: header.querySelectorAll('*').length,
        attributes: {
          id: header.id || '',
          class: header.className || '',
          role: header.getAttribute('role') || '',
          ariaLabel: header.getAttribute('aria-label') || ''
        },
        semantics: analyzeSemantics(header),
        style: analyzeStyle(header)
      })
    }
    
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
    for (const selector of heroSelectors) {
      const element = document.querySelector(selector)
      if (element && !isElementAlreadyIncluded(element)) {
        hero = element
        break
      }
    }
    
    // Si no se encontró, buscar características comunes de un hero
    if (!hero) {
      // Buscar una sección con un h1 grande y un botón CTA cerca
      const mainHeadings = document.querySelectorAll('h1')
      for (const h1 of Array.from(mainHeadings)) {
        const parent = h1.closest('section') || h1.closest('div[class*="hero"]') || h1.parentElement
        if (parent && parent.querySelectorAll('a.btn, button, a.button, .cta').length > 0) {
          hero = parent
          break
        }
      }
      
      // Alternativa: buscar primera sección grande con imagen de fondo
      if (!hero) {
        const sections = document.querySelectorAll('section, [class*="section"]')
        for (const section of Array.from(sections)) {
          const style = window.getComputedStyle(section)
          if (style.backgroundImage && style.backgroundImage !== 'none' && 
              section.getBoundingClientRect().height > window.innerHeight * 0.5) {
            hero = section
            break
          }
        }
      }
    }
    
    if (hero && !isElementAlreadyIncluded(hero)) {
      sections.push({
        type: 'hero',
        content: getVisibleText(hero),
        position: position++,
        elements: hero.querySelectorAll('*').length,
        attributes: {
          id: hero.id || '',
          class: hero.className || '',
          role: hero.getAttribute('role') || '',
          ariaLabel: hero.getAttribute('aria-label') || ''
        },
        semantics: analyzeSemantics(hero),
        style: analyzeStyle(hero)
      })
    }
    
    // Buscar todas las secciones principales
    const allSections = [
      ...Array.from(document.querySelectorAll('section')),
      ...Array.from(document.querySelectorAll('div[class*="section"]')),
      ...Array.from(document.querySelectorAll('div[id*="section"]')),
      ...Array.from(document.querySelectorAll('article')),
      ...Array.from(document.querySelectorAll('main > div')),
      ...Array.from(document.querySelectorAll('[data-section]')),
    ]
    
    // Procesar cada sección potencial
    for (const section of allSections) {
      if (isElementAlreadyIncluded(section)) continue
      
      // Ignorar secciones muy pequeñas (menos de 3 elementos)
      if (section.querySelectorAll('*').length < 3) continue
      
      // Determinar el tipo de sección
      const sectionType = determineSectionType(section)
      
      sections.push({
        type: sectionType,
        content: getVisibleText(section),
        position: position++,
        elements: section.querySelectorAll('*').length,
        attributes: {
          id: section.id || '',
          class: section.className || '',
          role: section.getAttribute('role') || '',
          ariaLabel: section.getAttribute('aria-label') || ''
        },
        semantics: analyzeSemantics(section),
        style: analyzeStyle(section)
      })
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
          role: footer.getAttribute('role') || '',
          ariaLabel: footer.getAttribute('aria-label') || ''
        },
        semantics: analyzeSemantics(footer),
        style: analyzeStyle(footer)
      })
    }
    
    return sections
  })
} 