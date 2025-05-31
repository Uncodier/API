'use client';

import React from 'react';
import { BaseApiConfig, ApiType } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props específicas para la API de Sesiones de Visitantes
export interface VisitorSessionApiProps {
  defaultEndpoint?: string;
  defaultMethod?: 'GET' | 'POST' | 'PUT';
  defaultSiteId?: string;
  defaultVisitorId?: string;
  defaultSessionId?: string;
  defaultUrl?: string;
  defaultReferrer?: string;
  showPreviousSessionId?: boolean;
}

// Estado específico para la API de Sesiones de Visitantes
export interface VisitorSessionApiState {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT';
  site_id: string;
  visitor_id: string;
  session_id: string;
  url: string;
  current_url: string;
  referrer: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
  last_activity_at: string;
  page_views: string;
  active_time: string;
  previous_session_id: string;
  useDeviceInfo: boolean;
  useBrowserInfo: boolean;
  useLocationInfo: boolean;
  device_type: string;
  device_screen: string;
  browser_name: string;
  browser_version: string;
  browser_language: string;
  country: string;
  region: string;
  city: string;
  custom_data: string;
  includeUTM: boolean;
  includePerformance: boolean;
  includeConsent: boolean;
}

// Configuración de la API de Sesiones de Visitantes
const VisitorSessionApi: BaseApiConfig = {
  id: 'visitor_session',
  name: 'API de Sesiones de Visitantes',
  description: 'API para gestionar sesiones de visitantes en un sitio web',
  defaultEndpoint: '/api/visitors/session',

  // Obtener el estado inicial
  getInitialState: (props: VisitorSessionApiProps): VisitorSessionApiState => {
    // Generar un site_id por defecto si no se proporciona uno
    const defaultSiteId = props.defaultSiteId || crypto.randomUUID();
    
    // Generar un session_id por defecto si se necesita para GET o PUT
    let defaultSessionId = props.defaultSessionId || '';
    if ((props.defaultMethod === 'GET' || props.defaultMethod === 'PUT') && !defaultSessionId) {
      defaultSessionId = crypto.randomUUID();
    }
    
    return {
      endpoint: props.defaultEndpoint || '/api/visitors/session',
      method: props.defaultMethod || 'POST',
      site_id: defaultSiteId,
      visitor_id: props.defaultVisitorId || '',
      session_id: defaultSessionId,
      url: props.defaultUrl || '',
      current_url: props.defaultUrl || '',
      referrer: props.defaultReferrer || '',
      utm_source: '',
      utm_medium: '',
      utm_campaign: '',
      utm_term: '',
      utm_content: '',
      last_activity_at: '',
      page_views: '1',
      active_time: '0',
      previous_session_id: '',
      useDeviceInfo: false,
      useBrowserInfo: false,
      useLocationInfo: false,
      device_type: 'desktop',
      device_screen: '1920x1080',
      browser_name: 'Chrome',
      browser_version: '98.0.4758.102',
      browser_language: 'es-ES',
      country: 'ES',
      region: 'Madrid',
      city: 'Madrid',
      custom_data: '{}',
      includeUTM: false,
      includePerformance: false,
      includeConsent: false
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: VisitorSessionApiState): Record<string, any> => {
    // El cuerpo depende del método HTTP
    switch (state.method) {
      case 'POST': {
        // Crear una nueva sesión
        const body: Record<string, any> = { site_id: state.site_id };
        
        // Añadir campos opcionales si están presentes
        if (state.visitor_id) body.visitor_id = state.visitor_id;
        if (state.url) body.url = state.url;
        if (state.referrer) body.referrer = state.referrer;
        
        // Añadir UTM si está habilitado
        if (state.includeUTM) {
          if (state.utm_source) body.utm_source = state.utm_source;
          if (state.utm_medium) body.utm_medium = state.utm_medium;
          if (state.utm_campaign) body.utm_campaign = state.utm_campaign;
          if (state.utm_term) body.utm_term = state.utm_term;
          if (state.utm_content) body.utm_content = state.utm_content;
        }
        
        // Añadir información del dispositivo
        if (state.useDeviceInfo) {
          body.device = {
            type: state.device_type,
            screen_size: state.device_screen
          };
        }
        
        // Añadir información del navegador
        if (state.useBrowserInfo) {
          body.browser = {
            name: state.browser_name,
            version: state.browser_version,
            language: state.browser_language
          };
        }
        
        // Añadir información de ubicación
        if (state.useLocationInfo) {
          body.location = {
            country: state.country,
            region: state.region,
            city: state.city
          };
        }
        
        // Añadir sesión anterior
        if (state.previous_session_id) {
          body.previous_session_id = state.previous_session_id;
        }
        
        // Añadir información de rendimiento
        if (state.includePerformance) {
          body.performance = {
            page_load_time: 1250,
            first_paint: 850,
            first_contentful_paint: 920,
            dom_interactive: 780
          };
        }
        
        // Añadir información de consentimiento
        if (state.includeConsent) {
          body.consent = {
            necessary: true,
            analytics: true,
            marketing: false,
            preferences: true
          };
        }
        
        return body;
      }
      
      case 'PUT': {
        // Actualizar una sesión existente
        const body: Record<string, any> = {
          session_id: state.session_id,
          site_id: state.site_id
        };
        
        // Añadir campos opcionales
        if (state.last_activity_at) {
          body.last_activity_at = parseInt(state.last_activity_at) || Date.now();
        }
        
        if (state.current_url) body.current_url = state.current_url;
        if (state.page_views) body.page_views = parseInt(state.page_views) || 1;
        if (state.active_time) body.active_time = parseInt(state.active_time) || 0;
        
        // Añadir datos personalizados
        if (state.custom_data && state.custom_data !== '{}') {
          try {
            body.custom_data = JSON.parse(state.custom_data);
          } catch (e) {
            console.error('Error parsing custom_data JSON:', e);
          }
        }
        
        return body;
      }
      
      default:
        // Para GET, no necesitamos un cuerpo
        return {};
    }
  },

  // Construir las cabeceras de la solicitud
  buildRequestHeaders: (state: VisitorSessionApiState): Record<string, string> => {
    return {
      'Content-Type': 'application/json',
      'X-SA-API-KEY': 'test-api-key-001'
    };
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: VisitorSessionApiState;
    setState: React.Dispatch<React.SetStateAction<VisitorSessionApiState>>;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    // Función para manejar los cambios en los campos del formulario
    const handleChange = (field: keyof VisitorSessionApiState, value: any) => {
      setState({ ...state, [field]: value });
    };
    
    return (
      <>
        <FormField
          label="ID del Sitio"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value) => handleChange('site_id', value)}
          placeholder="site_123abc"
          required
        />
        
        {/* Campos específicos según el método HTTP */}
        {state.method === 'POST' && (
          <>
            <FormField
              label="ID del Visitante (opcional)"
              id="visitor_id"
              type="text"
              value={state.visitor_id}
              onChange={(value) => handleChange('visitor_id', value)}
              placeholder="vis_abcd1234"
            />
            
            <FormField
              label="URL Inicial"
              id="url"
              type="text"
              value={state.url}
              onChange={(value) => handleChange('url', value)}
              placeholder="https://ejemplo.com/landing-page"
            />
            
            <FormField
              label="Referrer"
              id="referrer"
              type="text"
              value={state.referrer}
              onChange={(value) => handleChange('referrer', value)}
              placeholder="https://google.com"
            />
            
            <FormField
              label="Incluir Datos UTM"
              id="includeUTM"
              type="checkbox"
              value={state.includeUTM}
              onChange={(value) => handleChange('includeUTM', value)}
            />
            
            {state.includeUTM && (
              <>
                <SectionLabel>Parámetros UTM</SectionLabel>
                
                <FormField
                  label="UTM Source"
                  id="utm_source"
                  type="text"
                  value={state.utm_source}
                  onChange={(value) => handleChange('utm_source', value)}
                  placeholder="google"
                />
                
                <FormField
                  label="UTM Medium"
                  id="utm_medium"
                  type="text"
                  value={state.utm_medium}
                  onChange={(value) => handleChange('utm_medium', value)}
                  placeholder="cpc"
                />
                
                <FormField
                  label="UTM Campaign"
                  id="utm_campaign"
                  type="text"
                  value={state.utm_campaign}
                  onChange={(value) => handleChange('utm_campaign', value)}
                  placeholder="spring_sale"
                />
                
                <FormField
                  label="UTM Term"
                  id="utm_term"
                  type="text"
                  value={state.utm_term}
                  onChange={(value) => handleChange('utm_term', value)}
                  placeholder="analytics"
                />
                
                <FormField
                  label="UTM Content"
                  id="utm_content"
                  type="text"
                  value={state.utm_content}
                  onChange={(value) => handleChange('utm_content', value)}
                  placeholder="banner_1"
                />
              </>
            )}
            
            <FormField
              label="Incluir Info de Dispositivo"
              id="useDeviceInfo"
              type="checkbox"
              value={state.useDeviceInfo}
              onChange={(value) => handleChange('useDeviceInfo', value)}
            />
            
            {state.useDeviceInfo && (
              <>
                <SectionLabel>Información del Dispositivo</SectionLabel>
                
                <FormField
                  label="Tipo de Dispositivo"
                  id="device_type"
                  type="select"
                  value={state.device_type}
                  onChange={(value) => handleChange('device_type', value)}
                  options={[
                    { value: 'desktop', label: 'Desktop' },
                    { value: 'mobile', label: 'Mobile' },
                    { value: 'tablet', label: 'Tablet' }
                  ]}
                />
                
                <FormField
                  label="Tamaño de Pantalla"
                  id="device_screen"
                  type="text"
                  value={state.device_screen}
                  onChange={(value) => handleChange('device_screen', value)}
                  placeholder="1920x1080"
                />
              </>
            )}
            
            <FormField
              label="Incluir Info de Navegador"
              id="useBrowserInfo"
              type="checkbox"
              value={state.useBrowserInfo}
              onChange={(value) => handleChange('useBrowserInfo', value)}
            />
            
            {state.useBrowserInfo && (
              <>
                <SectionLabel>Información del Navegador</SectionLabel>
                
                <FormField
                  label="Nombre del Navegador"
                  id="browser_name"
                  type="select"
                  value={state.browser_name}
                  onChange={(value) => handleChange('browser_name', value)}
                  options={[
                    { value: 'Chrome', label: 'Chrome' },
                    { value: 'Firefox', label: 'Firefox' },
                    { value: 'Safari', label: 'Safari' },
                    { value: 'Edge', label: 'Edge' }
                  ]}
                />
                
                <FormField
                  label="Versión del Navegador"
                  id="browser_version"
                  type="text"
                  value={state.browser_version}
                  onChange={(value) => handleChange('browser_version', value)}
                  placeholder="98.0.4758.102"
                />
                
                <FormField
                  label="Idioma del Navegador"
                  id="browser_language"
                  type="text"
                  value={state.browser_language}
                  onChange={(value) => handleChange('browser_language', value)}
                  placeholder="es-ES"
                />
              </>
            )}
            
            <FormField
              label="Incluir Info de Ubicación"
              id="useLocationInfo"
              type="checkbox"
              value={state.useLocationInfo}
              onChange={(value) => handleChange('useLocationInfo', value)}
            />
            
            {state.useLocationInfo && (
              <>
                <SectionLabel>Información de Ubicación</SectionLabel>
                
                <FormField
                  label="País"
                  id="country"
                  type="text"
                  value={state.country}
                  onChange={(value) => handleChange('country', value)}
                  placeholder="ES"
                />
                
                <FormField
                  label="Región"
                  id="region"
                  type="text"
                  value={state.region}
                  onChange={(value) => handleChange('region', value)}
                  placeholder="Madrid"
                />
                
                <FormField
                  label="Ciudad"
                  id="city"
                  type="text"
                  value={state.city}
                  onChange={(value) => handleChange('city', value)}
                  placeholder="Madrid"
                />
              </>
            )}
            
            <FormField
              label="Incluir Info de Performance"
              id="includePerformance"
              type="checkbox"
              value={state.includePerformance}
              onChange={(value) => handleChange('includePerformance', value)}
            />
            
            <FormField
              label="Incluir Info de Consentimiento"
              id="includeConsent"
              type="checkbox"
              value={state.includeConsent}
              onChange={(value) => handleChange('includeConsent', value)}
            />
            
            {props.additionalFields && props.additionalFields.length > 0 && (
              <>
                <SectionLabel>Campos Adicionales</SectionLabel>
                {props.additionalFields.map((field) => (
                  <FormField
                    key={field.name}
                    label={field.label}
                    id={field.name}
                    type={field.type}
                    value={state[field.name as keyof VisitorSessionApiState] || field.defaultValue}
                    onChange={(value) => handleChange(field.name as keyof VisitorSessionApiState, value)}
                    options={field.options}
                    placeholder={field.placeholder}
                    required={field.required}
                  />
                ))}
              </>
            )}
          </>
        )}
        
        {state.method === 'GET' && (
          <>
            <FormField
              label="ID de la Sesión"
              id="session_id"
              type="text"
              value={state.session_id}
              onChange={(value) => handleChange('session_id', value)}
              placeholder="sess_xyz789"
              required
            />
          </>
        )}
        
        {state.method === 'PUT' && (
          <>
            <FormField
              label="ID de la Sesión"
              id="session_id"
              type="text"
              value={state.session_id}
              onChange={(value) => handleChange('session_id', value)}
              placeholder="sess_xyz789"
              required
            />
            
            <FormField
              label="URL Actual"
              id="current_url"
              type="text"
              value={state.current_url}
              onChange={(value) => handleChange('current_url', value)}
              placeholder="https://ejemplo.com/checkout"
            />
            
            <FormField
              label="Última Actividad (timestamp)"
              id="last_activity_at"
              type="number"
              value={state.last_activity_at}
              onChange={(value) => handleChange('last_activity_at', value)}
              placeholder={Date.now().toString()}
            />
            
            <FormField
              label="Páginas Vistas"
              id="page_views"
              type="number"
              value={state.page_views}
              onChange={(value) => handleChange('page_views', value)}
              placeholder="1"
              min={1}
            />
            
            <FormField
              label="Tiempo Activo (ms)"
              id="active_time"
              type="number"
              value={state.active_time}
              onChange={(value) => handleChange('active_time', value)}
              placeholder="0"
              min={0}
            />
            
            <FormField
              label="Datos Personalizados (JSON)"
              id="custom_data"
              type="textarea"
              value={state.custom_data}
              onChange={(value) => handleChange('custom_data', value)}
              placeholder="{}"
            />
          </>
        )}
      </>
    );
  }
};

export default VisitorSessionApi; 