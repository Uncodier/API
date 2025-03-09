/**
 * HTML Preprocessor
 * 
 * Utilities to preprocess HTML content before sending it to the analysis models,
 * reducing context size while preserving important structural information.
 */

import * as cheerio from 'cheerio';
import { fetchHtml } from './html-utils';
import { generateHtmlStats as getHtmlStats } from './html-utils';

/**
 * Preprocesses HTML to reduce its size while maintaining structural integrity
 * @param html - The original HTML content
 * @param options - Configuration options for preprocessing
 * @returns Processed HTML with reduced size
 */
export async function preprocessHtml(
  url: string,
  options = defaultOptions
): Promise<{ html: string; stats: ReturnType<typeof getHtmlStats> }> {
  try {
    // Obtener el HTML
    const html = await fetchHtml(url);
    
    // Generar estadísticas antes del preprocesamiento
    const originalStats = getHtmlStats(html);
    
    // Cargar el HTML con cheerio
    const $ = cheerio.load(html);
    
    // Eliminar scripts si se solicita
    if (options.removeScripts) {
      $('script').remove();
    }
    
    // Eliminar estilos si se solicita
    if (options.removeStyles) {
      $('style').remove();
      $('link[rel="stylesheet"]').remove();
    }
    
    // Eliminar comentarios si se solicita
    if (options.removeComments) {
      $('*').contents().each(function() {
        if (this.type === 'comment') {
          $(this).remove();
        }
      });
    }
    
    // Eliminar estilos en línea si se solicita
    if (options.removeInlineStyles) {
      $('[style]').removeAttr('style');
    }
    
    // Eliminar atributos data- si se solicita
    if (options.removeDataAttributes) {
      $('*').each(function() {
        const element = $(this);
        const attributes = element.attr() || {};
        
        Object.keys(attributes).forEach(attr => {
          if (attr.startsWith('data-')) {
            element.removeAttr(attr);
          }
        });
      });
    }
    
    // Optimizar SVGs - reemplazar contenido interno complejo pero mantener atributos importantes
    if (options.optimizeSvgs) {
      $('svg').each(function() {
        const svg = $(this);
        const id = svg.attr('id') || '';
        const className = svg.attr('class') || '';
        const width = svg.attr('width') || '';
        const height = svg.attr('height') || '';
        const viewBox = svg.attr('viewBox') || '';
        const ariaLabel = svg.attr('aria-label') || '';
        const role = svg.attr('role') || '';
        
        // Preservar el elemento SVG pero simplificar su contenido interno
        svg.empty();
        
        // Restaurar atributos importantes
        if (id) svg.attr('id', id);
        if (className) svg.attr('class', className);
        if (width) svg.attr('width', width);
        if (height) svg.attr('height', height);
        if (viewBox) svg.attr('viewBox', viewBox);
        if (ariaLabel) svg.attr('aria-label', ariaLabel);
        if (role) svg.attr('role', role);
        
        // Añadir un marcador para indicar que es un SVG simplificado
        svg.attr('data-simplified', 'true');
      });
    }
    
    // Limpiar elementos del head que no son relevantes para el análisis UX
    if (options.cleanHead) {
      // Preservar solo los elementos importantes del head
      const title = $('head title').text();
      const metaDescription = $('head meta[name="description"]').attr('content') || '';
      const metaKeywords = $('head meta[name="keywords"]').attr('content') || '';
      const metaViewport = $('head meta[name="viewport"]').attr('content') || '';
      const favicon = $('head link[rel="icon"], head link[rel="shortcut icon"]').attr('href') || '';
      
      // Limpiar todo el head
      $('head').empty();
      
      // Restaurar solo los elementos importantes
      if (title) $('head').append(`<title>${title}</title>`);
      if (metaDescription) $('head').append(`<meta name="description" content="${metaDescription}">`);
      if (metaKeywords) $('head').append(`<meta name="keywords" content="${metaKeywords}">`);
      if (metaViewport) $('head').append(`<meta name="viewport" content="${metaViewport}">`);
      if (favicon) $('head').append(`<link rel="icon" href="${favicon}">`);
      
      // Añadir un comentario para indicar que el head ha sido simplificado
      $('head').prepend('<!-- Head content simplified for analysis -->');
    }
    
    // Limpiar elementos del footer que no son relevantes para el análisis UX
    if (options.cleanFooter) {
      $('footer').each(function() {
        const footer = $(this);
        
        // Preservar elementos importantes del footer
        const navigationLinks: string[] = [];
        const ctaElements: string[] = [];
        const contactInfo: string[] = [];
        
        // Preservar enlaces de navegación importantes
        footer.find('a').each(function() {
          const link = $(this);
          const href = link.attr('href') || '';
          const text = link.text().trim();
          
          if (text && !options.footerExcludePatterns.some(pattern => 
            text.toLowerCase().includes(pattern.toLowerCase()) || 
            href.toLowerCase().includes(pattern.toLowerCase())
          )) {
            navigationLinks.push(`<a href="${href}">${text}</a>`);
          }
        });
        
        // Preservar CTAs
        footer.find('button, .btn, .button, .cta, a.btn, a.button, a.cta').each(function() {
          const cta = $(this);
          const text = cta.text().trim();
          const className = cta.attr('class') || '';
          
          if (text && !options.footerExcludePatterns.some(pattern => 
            text.toLowerCase().includes(pattern.toLowerCase())
          )) {
            ctaElements.push(`<button class="${className}">${text}</button>`);
          }
        });
        
        // Preservar información de contacto
        footer.find('address, .contact, .contact-info, [itemprop="address"], [itemprop="telephone"], [itemprop="email"]').each(function() {
          contactInfo.push($(this).prop('outerHTML') || '');
        });
        
        // Limpiar todo el footer
        footer.empty();
        
        // Restaurar solo los elementos importantes
        if (navigationLinks.length > 0) {
          footer.append('<div class="footer-nav">');
          navigationLinks.forEach(link => {
            footer.find('.footer-nav').append(link);
          });
          footer.append('</div>');
        }
        
        if (ctaElements.length > 0) {
          footer.append('<div class="footer-cta">');
          ctaElements.forEach(cta => {
            footer.find('.footer-cta').append(cta);
          });
          footer.append('</div>');
        }
        
        if (contactInfo.length > 0) {
          footer.append('<div class="footer-contact">');
          contactInfo.forEach(info => {
            footer.find('.footer-contact').append(info);
          });
          footer.append('</div>');
        }
        
        // Añadir un comentario para indicar que el footer ha sido simplificado
        footer.prepend('<!-- Footer content simplified for analysis -->');
      });
    }
    
    // Preservar elementos de navegación y sus enlaces
    if (options.preserveNavigation) {
      // Identificar elementos de navegación
      $('nav, [role="navigation"], .nav, .navbar, .menu, .navigation, header').each(function() {
        const navElement = $(this);
        
        // Preservar todos los enlaces dentro de la navegación
        navElement.find('a').each(function() {
          const link = $(this);
          const href = link.attr('href') || '';
          const text = link.text().trim();
          const id = link.attr('id') || '';
          const className = link.attr('class') || '';
          
          // Asegurarse de que el texto no se trunca en enlaces de navegación
          if (text) {
            // Limpiar todos los nodos de texto y elementos internos
            link.contents().each(function() {
              if (this.type === 'text' || $(this).is('span, i, em, strong')) {
                $(this).remove();
              }
            });
            
            // Restaurar el texto original completo
            link.text(text);
          }
          
          // Asegurarse de que se preservan los atributos importantes
          if (href) link.attr('href', href);
          if (id) link.attr('id', id);
          if (className) link.attr('class', className);
          
          // Marcar como elemento de navegación preservado
          link.attr('data-preserved-nav', 'true');
        });
      });
    }
    
    // Preservar botones y CTAs
    if (options.preserveCTAs) {
      $('button, [role="button"], .btn, .button, .cta, a.btn, a.button, a.cta').each(function() {
        const cta = $(this);
        const text = cta.text().trim();
        const id = cta.attr('id') || '';
        const className = cta.attr('class') || '';
        const href = cta.attr('href') || '';
        const onclick = cta.attr('onclick') || '';
        
        // Preservar el texto completo en CTAs
        if (text) {
          // Limpiar todos los nodos de texto y elementos internos
          cta.contents().each(function() {
            if (this.type === 'text' || $(this).is('span, i, em, strong')) {
              $(this).remove();
            }
          });
          
          // Restaurar el texto original completo
          cta.text(text);
        }
        
        // Asegurarse de que se preservan los atributos importantes
        if (id) cta.attr('id', id);
        if (className) cta.attr('class', className);
        if (href) cta.attr('href', href);
        if (onclick) cta.attr('onclick', onclick);
        
        // Marcar como CTA preservado
        cta.attr('data-preserved-cta', 'true');
      });
    }
    
    // Truncar textos largos para reducir tamaño pero mantener estructura
    $('*').each(function() {
      const element = $(this);
      
      // No truncar textos en elementos de navegación o CTAs preservados
      if (element.attr('data-preserved-nav') || element.attr('data-preserved-cta')) {
        return;
      }
      
      // Solo procesar nodos de texto directos (no elementos anidados)
      element.contents().each(function() {
        if (this.type === 'text') {
          const text = $(this).text().trim();
          if (text.length > options.maxTextNodeLength) {
            // Reemplazar el texto largo con una versión truncada
            this.data = text.substring(0, options.maxTextNodeLength) + '...';
          }
        }
      });
    });
    
    // Preservar elementos semánticos si se solicita
    if (!options.preserveSemanticElements) {
      $('header, footer, nav, main, section, article, aside').each(function() {
        $(this).replaceWith($(this).html() || '');
      });
    }
    
    // Preservar encabezados si se solicita
    if (!options.preserveHeadings) {
      $('h1, h2, h3, h4, h5, h6').each(function() {
        $(this).replaceWith(`<p>${$(this).text()}</p>`);
      });
    }
    
    // Preservar formularios si se solicita
    if (!options.preserveForms) {
      $('form').each(function() {
        $(this).replaceWith($(this).html() || '');
      });
      $('input, select, textarea, button').remove();
    }
    
    // Preservar enlaces si se solicita
    if (!options.preserveLinks) {
      $('a').each(function() {
        $(this).replaceWith($(this).text());
      });
    }
    
    // Preservar imágenes si se solicita
    if (!options.preserveImages) {
      $('img').remove();
    }
    
    // Simplificar atributos de imagen pero mantener alt y src
    if (options.simplifyImageAttributes) {
      $('img').each(function() {
        const element = $(this);
        const src = element.attr('src') || '';
        const alt = element.attr('alt') || '';
        const id = element.attr('id') || '';
        const className = element.attr('class') || '';
        
        // Eliminar todos los atributos
        const attributes = element.attr() || {};
        Object.keys(attributes).forEach(attr => {
          element.removeAttr(attr);
        });
        
        // Restaurar solo los atributos importantes
        if (src) element.attr('src', src);
        if (alt) element.attr('alt', alt);
        if (id) element.attr('id', id);
        if (className) element.attr('class', className);
      });
    }
    
    // Obtener el HTML preprocesado
    let processedHtml = $.html();
    
    // Limitar la longitud del texto si es necesario
    if (options.maxTextLength && processedHtml.length > options.maxTextLength) {
      processedHtml = processedHtml.substring(0, options.maxTextLength);
    }
    
    // Generar estadísticas después del preprocesamiento
    const processedStats = getHtmlStats(processedHtml);
    
    console.log(`[preprocessHtml] HTML preprocesado: ${processedHtml.length} bytes (original: ${html.length} bytes)`);
    
    return {
      html: processedHtml,
      stats: processedStats
    };
  } catch (error) {
    console.error(`[preprocessHtml] Error al preprocesar HTML: ${error}`);
    throw new Error(`Error al preprocesar HTML: ${error}`);
  }
}

/**
 * Exporta la función para generar estadísticas de HTML
 */
export const generateHtmlStats = getHtmlStats;

/**
 * Interface for HTML preprocessing options
 */
export interface PreprocessingOptions {
  removeScripts: boolean;
  removeStyles: boolean;
  removeComments: boolean;
  removeInlineStyles: boolean;
  removeDataAttributes: boolean;
  simplifyClassNames: boolean;
  preserveSemanticElements: boolean;
  preserveHeadings: boolean;
  preserveForms: boolean;
  preserveLinks: boolean;
  preserveImages: boolean;
  simplifyImageAttributes: boolean;
  optimizeSvgs: boolean;
  preserveNavigation: boolean;
  preserveCTAs: boolean;
  maxTextNodeLength: number;
  maxTextLength: number;
  cleanHead: boolean;
  cleanFooter: boolean;
  headExcludePatterns: string[];
  footerExcludePatterns: string[];
}

/**
 * Interface for HTML statistics
 */
export interface HtmlStats {
  totalElements: number;
  elementTypes: Record<string, number>;
  interactiveElements: number;
  imageCount: number;
  linkCount: number;
  formCount: number;
  headingCount: number;
  semanticElements: number;
  ctaElements: number;
  navigationElements: number;
  sectionCount: number;
  divCount: number;
  hiddenElements: number;
}

/**
 * Default preprocessing options
 */
export const defaultOptions: PreprocessingOptions = {
  removeScripts: true,
  removeStyles: true,
  removeComments: true,
  removeInlineStyles: false,
  removeDataAttributes: false,
  simplifyClassNames: false,
  preserveSemanticElements: true,
  preserveHeadings: true,
  preserveForms: true,
  preserveLinks: true,
  preserveImages: true,
  simplifyImageAttributes: true,
  optimizeSvgs: true,
  preserveNavigation: true,
  preserveCTAs: true,
  maxTextNodeLength: 50,
  maxTextLength: 100000,
  cleanHead: true,
  cleanFooter: true,
  headExcludePatterns: [
    'analytics', 'tracking', 'pixel', 'facebook', 'twitter', 'google', 
    'gtm', 'ga', 'tag manager', 'hotjar', 'optimize', 'schema.org'
  ],
  footerExcludePatterns: [
    'privacy policy', 'terms', 'cookies', 'copyright', 'all rights reserved',
    'sitemap', 'legal', 'gdpr', 'accessibility', 'preferences'
  ]
};

/**
 * Preprocessing options optimized for maximum reduction
 */
export const aggressiveOptions: PreprocessingOptions = {
  ...defaultOptions,
  simplifyClassNames: true,
  preserveSemanticElements: true,
  preserveHeadings: true,
  preserveForms: false,
  preserveLinks: false,
  preserveImages: false,
  maxTextLength: 30000,
  cleanHead: true,
  cleanFooter: true,
  headExcludePatterns: [
    ...defaultOptions.headExcludePatterns,
    'meta', 'charset', 'http-equiv', 'preload', 'prefetch'
  ],
  footerExcludePatterns: [
    ...defaultOptions.footerExcludePatterns,
    'newsletter', 'subscribe', 'follow us', 'social'
  ]
};

/**
 * Preprocessing options optimized for keeping more visual elements
 */
export const conservativeOptions: PreprocessingOptions = {
  ...defaultOptions,
  removeScripts: true,
  removeStyles: true,
  removeComments: true,
  removeInlineStyles: false,
  removeDataAttributes: false,
  simplifyClassNames: false,
  maxTextLength: 100000,
  cleanHead: true,
  cleanFooter: false,
  headExcludePatterns: defaultOptions.headExcludePatterns,
  footerExcludePatterns: []
}; 