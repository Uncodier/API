/**
 * Tests para el extractor de información de peticiones HTTP
 */

import { describe, it, expect } from '@jest/globals';
import { 
  parseUserAgent, 
  extractLanguage, 
  detectScreenSize,
  extractClientIP
} from '@/lib/utils/request-info-extractor';
import { NextRequest } from 'next/server';

describe('Request Info Extractor', () => {
  describe('parseUserAgent', () => {
    it('debería detectar Chrome en Windows', () => {
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
      const result = parseUserAgent(userAgent);
      
      expect(result.browser.name).toBe('Chrome');
      expect(result.browser.version).toBe('119.0.0.0');
      expect(result.device.type).toBe('desktop');
      expect(result.device.os?.name).toBe('Windows');
      expect(result.device.os?.version).toBe('10.0');
    });

    it('debería detectar Safari en macOS', () => {
      const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
      const result = parseUserAgent(userAgent);
      
      expect(result.browser.name).toBe('Safari');
      expect(result.browser.version).toBe('17.1');
      expect(result.device.type).toBe('desktop');
      expect(result.device.os?.name).toBe('macOS');
      expect(result.device.os?.version).toBe('10.15.7');
    });

    it('debería detectar Chrome en Android móvil', () => {
      const userAgent = 'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';
      const result = parseUserAgent(userAgent);
      
      expect(result.browser.name).toBe('Chrome');
      expect(result.device.type).toBe('mobile');
      expect(result.device.os?.name).toBe('Android');
      expect(result.device.os?.version).toBe('13');
      expect(result.device.touch_support).toBe(true);
    });

    it('debería detectar Safari en iPhone', () => {
      const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
      const result = parseUserAgent(userAgent);
      
      expect(result.browser.name).toBe('Safari');
      expect(result.device.type).toBe('mobile');
      expect(result.device.os?.name).toBe('iOS');
      expect(result.device.os?.version).toBe('17.1.1');
      expect(result.device.touch_support).toBe(true);
    });

    it('debería detectar Firefox en Linux', () => {
      const userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/119.0';
      const result = parseUserAgent(userAgent);
      
      expect(result.browser.name).toBe('Firefox');
      expect(result.browser.version).toBe('119.0');
      expect(result.device.type).toBe('desktop');
      expect(result.device.os?.name).toBe('Linux');
    });

    it('debería detectar Microsoft Edge', () => {
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0';
      const result = parseUserAgent(userAgent);
      
      expect(result.browser.name).toBe('Microsoft Edge');
      expect(result.browser.version).toBe('119.0.0.0');
      expect(result.device.type).toBe('desktop');
    });

    it('debería detectar iPad', () => {
      const userAgent = 'Mozilla/5.0 (iPad; CPU OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
      const result = parseUserAgent(userAgent);
      
      expect(result.device.type).toBe('tablet');
      expect(result.device.touch_support).toBe(true);
    });
  });

  describe('extractLanguage', () => {
    it('debería extraer el idioma principal del header Accept-Language', () => {
      expect(extractLanguage('es-ES,es;q=0.9,en;q=0.8')).toBe('es');
      expect(extractLanguage('en-US,en;q=0.9')).toBe('en');
      expect(extractLanguage('fr-FR,fr;q=0.9,en;q=0.8')).toBe('fr');
      expect(extractLanguage('de')).toBe('de');
    });

    it('debería retornar "en" por defecto si no hay idioma', () => {
      expect(extractLanguage('')).toBe('en');
      expect(extractLanguage(null as any)).toBe('en');
      expect(extractLanguage(undefined as any)).toBe('en');
    });
  });

  describe('detectScreenSize', () => {
    it('debería detectar tamaños de pantalla para iPhone', () => {
      expect(detectScreenSize('iPhone 14')).toBe('390x844');
      expect(detectScreenSize('iPhone 13')).toBe('390x844');
      expect(detectScreenSize('iPhone 12')).toBe('375x812');
      expect(detectScreenSize('iPhone')).toBe('375x667');
    });

    it('debería detectar tamaño de pantalla para iPad', () => {
      expect(detectScreenSize('iPad')).toBe('1024x768');
    });

    it('debería detectar tamaños de pantalla para Android', () => {
      expect(detectScreenSize('Android mobile')).toBe('360x640');
      expect(detectScreenSize('Android')).toBe('800x1280');
    });

    it('debería detectar tamaño de pantalla para desktop', () => {
      expect(detectScreenSize('Windows')).toBe('1920x1080');
      expect(detectScreenSize('Macintosh')).toBe('1920x1080');
      expect(detectScreenSize('Linux')).toBe('1920x1080');
    });
  });

  describe('extractClientIP', () => {
    it('debería extraer IP del header x-forwarded-for', () => {
      const mockRequest = {
        headers: {
          get: (header: string) => {
            if (header === 'x-forwarded-for') return '192.168.1.100, 10.0.0.1';
            return null;
          }
        }
      } as unknown as NextRequest;

      expect(extractClientIP(mockRequest)).toBe('192.168.1.100');
    });

    it('debería usar IP por defecto si no hay headers', () => {
      const mockRequest = {
        headers: {
          get: () => null
        }
      } as unknown as NextRequest;

      expect(extractClientIP(mockRequest)).toBe('127.0.0.1');
    });

    it('debería priorizar headers en orden correcto', () => {
      const mockRequest = {
        headers: {
          get: (header: string) => {
            if (header === 'x-forwarded-for') return '192.168.1.100';
            if (header === 'x-real-ip') return '192.168.1.200';
            return null;
          }
        }
      } as unknown as NextRequest;

      expect(extractClientIP(mockRequest)).toBe('192.168.1.100');
    });
  });
}); 