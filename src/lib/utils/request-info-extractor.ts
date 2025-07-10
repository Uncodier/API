/**
 * Utilidades para extraer información del dispositivo, navegador y ubicación desde peticiones HTTP
 */

import { NextRequest } from 'next/server';

export interface DeviceInfo {
  type: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  screen_size?: string;
  os?: {
    name: string;
    version?: string;
  };
  pixel_ratio?: number;
  orientation?: string;
  memory?: number;
  cpu_cores?: number;
  touch_support?: boolean;
}

export interface BrowserInfo {
  name: string;
  version?: string;
  language?: string;
}

export interface LocationInfo {
  country?: string;
  region?: string;
  city?: string;
}

export interface RequestInfo {
  ip: string;
  userAgent: string;
  acceptLanguage: string;
  device: DeviceInfo;
  browser: BrowserInfo;
  location: LocationInfo;
}

/**
 * Extrae la IP real del cliente desde varios headers posibles
 */
export function extractClientIP(request: NextRequest): string {
  const ip = request.headers.get('x-forwarded-for') || 
             request.headers.get('x-real-ip') || 
             request.headers.get('x-client-ip') || 
             request.headers.get('cf-connecting-ip') || 
             request.headers.get('x-forwarded') || 
             request.headers.get('forwarded-for') || 
             request.headers.get('forwarded') || 
             '127.0.0.1';
  
  // Si hay múltiples IPs separadas por coma, tomar la primera
  return ip.split(',')[0].trim();
}

/**
 * Extrae información del User-Agent
 */
export function parseUserAgent(userAgent: string): { device: DeviceInfo; browser: BrowserInfo } {
  const ua = userAgent.toLowerCase();
  
  // Detectar tipo de dispositivo
  let deviceType: DeviceInfo['type'] = 'unknown';
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    deviceType = 'mobile';
  } else if (ua.includes('tablet') || ua.includes('ipad')) {
    deviceType = 'tablet';
  } else if (ua.includes('windows') || ua.includes('macintosh') || ua.includes('linux')) {
    deviceType = 'desktop';
  }

  // Detectar sistema operativo
  let osName = 'unknown';
  let osVersion = '';
  
  if (ua.includes('windows nt')) {
    osName = 'Windows';
    const match = ua.match(/windows nt ([\d.]+)/);
    if (match) osVersion = match[1];
  } else if (ua.includes('mac os x')) {
    osName = 'macOS';
    const match = ua.match(/mac os x ([\d_]+)/);
    if (match) osVersion = match[1].replace(/_/g, '.');
  } else if (ua.includes('linux')) {
    osName = 'Linux';
  } else if (ua.includes('android')) {
    osName = 'Android';
    const match = ua.match(/android ([\d.]+)/);
    if (match) osVersion = match[1];
  } else if (ua.includes('iphone os')) {
    osName = 'iOS';
    const match = ua.match(/iphone os ([\d_]+)/);
    if (match) osVersion = match[1].replace(/_/g, '.');
  }

  // Detectar navegador
  let browserName = 'unknown';
  let browserVersion = '';
  
  if (ua.includes('chrome/') && !ua.includes('edg/')) {
    browserName = 'Chrome';
    const match = ua.match(/chrome\/([\d.]+)/);
    if (match) browserVersion = match[1];
  } else if (ua.includes('firefox/')) {
    browserName = 'Firefox';
    const match = ua.match(/firefox\/([\d.]+)/);
    if (match) browserVersion = match[1];
  } else if (ua.includes('safari/') && !ua.includes('chrome')) {
    browserName = 'Safari';
    const match = ua.match(/version\/([\d.]+)/);
    if (match) browserVersion = match[1];
  } else if (ua.includes('edg/')) {
    browserName = 'Microsoft Edge';
    const match = ua.match(/edg\/([\d.]+)/);
    if (match) browserVersion = match[1];
  } else if (ua.includes('opera/') || ua.includes('opr/')) {
    browserName = 'Opera';
    const match = ua.match(/(?:opera|opr)\/?([\d.]+)/);
    if (match) browserVersion = match[1];
  }

  // Detectar características adicionales del dispositivo
  const touchSupport = ua.includes('touch') || deviceType === 'mobile' || deviceType === 'tablet';
  
  return {
    device: {
      type: deviceType,
      os: {
        name: osName,
        version: osVersion || undefined
      },
      touch_support: touchSupport
    },
    browser: {
      name: browserName,
      version: browserVersion || undefined
    }
  };
}

/**
 * Extrae el idioma preferido del header Accept-Language
 */
export function extractLanguage(acceptLanguage: string): string {
  if (!acceptLanguage) return 'en';
  
  // Tomar el primer idioma de la lista
  const languages = acceptLanguage.split(',');
  const primaryLanguage = languages[0].split(';')[0].trim();
  
  // Extraer solo el código del idioma (ej: "es-ES" -> "es")
  return primaryLanguage.split('-')[0].toLowerCase();
}

/**
 * Función principal para extraer toda la información de la petición
 */
export function extractRequestInfo(request: NextRequest): RequestInfo {
  const ip = extractClientIP(request);
  const userAgent = request.headers.get('user-agent') || '';
  const acceptLanguage = request.headers.get('accept-language') || '';
  
  const { device, browser } = parseUserAgent(userAgent);
  
  // Añadir idioma al navegador si no está
  browser.language = extractLanguage(acceptLanguage);
  
  // Información de ubicación básica (se puede expandir con servicios de geolocalización)
  const location: LocationInfo = {
    // TODO: Implementar geolocalización por IP usando un servicio externo
    // Por ahora, dejar vacío y permitir que se llene desde el cliente
  };
  
  return {
    ip,
    userAgent,
    acceptLanguage,
    device,
    browser,
    location
  };
}

/**
 * Detecta el tamaño aproximado de pantalla basado en el User-Agent
 */
export function detectScreenSize(userAgent: string): string | undefined {
  const ua = userAgent.toLowerCase();
  
  // Tamaños comunes basados en el dispositivo
  if (ua.includes('iphone')) {
    if (ua.includes('iphone 14') || ua.includes('iphone 13')) return '390x844';
    if (ua.includes('iphone 12') || ua.includes('iphone 11')) return '375x812';
    return '375x667'; // iPhone estándar
  }
  
  if (ua.includes('ipad')) {
    return '1024x768';
  }
  
  if (ua.includes('android')) {
    if (ua.includes('mobile')) return '360x640'; // Android móvil común
    return '800x1280'; // Android tablet
  }
  
  // Para desktop, usar tamaños comunes
  if (ua.includes('windows') || ua.includes('macintosh') || ua.includes('linux')) {
    return '1920x1080'; // Full HD común
  }
  
  return undefined;
} 