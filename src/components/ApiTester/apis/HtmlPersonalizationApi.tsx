'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField, SectionLabel } from '../utils';

// Props específicas para la API de Personalización HTML
export interface HtmlPersonalizationApiProps {
  defaultUrl?: string;
  defaultSegmentId?: string;
  defaultPersonalizationLevel?: 'minimal' | 'moderate' | 'extensive';
  defaultImplementationMethod?: 'js_injection' | 'static_html' | 'hybrid';
  defaultMethod?: 'GET' | 'POST';
  defaultTimeout?: string;
  defaultDeviceType?: 'all' | 'mobile' | 'desktop' | 'tablet';
  defaultModelType?: string;
  defaultModel?: string;
  showModelOptions?: boolean;
  defaultSiteId?: string;
  defaultUserId?: string;
  defaultAnalysisId?: string;
  defaultTestMode?: boolean;
}

// Estado específico para la API de Personalización HTML
export interface HtmlPersonalizationApiState {
  url: string;
  segment_id: string;
  method: 'GET' | 'POST';
  personalization_level: 'minimal' | 'moderate' | 'extensive';
  target_elements: ('layout' | 'navigation' | 'content' | 'cta' | 'visuals' | 'forms' | 'all')[];
  implementation_method: 'js_injection' | 'static_html' | 'hybrid';
  device_type: 'all' | 'mobile' | 'desktop' | 'tablet';
  timeout: string;
  modelType: ModelProviderType;
  modelId: string;
  site_id: string;
  user_id: string;
  analysis_id: string;
  include_preview: boolean;
  include_diff: boolean;
  include_performance_impact: boolean;
  includeScreenshot: boolean;
  test_mode: boolean;
  htmlContent: string;
  target_pages: string;
  redis_ttl: string;
  skip_cache: boolean;
}

// Configuración de la API de Personalización HTML
const HtmlPersonalizationApi: BaseApiConfig = {
  id: 'html-personalization',
  name: 'API de Personalización HTML',
  description: 'API para personalizar HTML basado en segmentos de audiencia',
  defaultEndpoint: '/api/site/personalize-html',

  // Obtener el estado inicial
  getInitialState: (props: HtmlPersonalizationApiProps): HtmlPersonalizationApiState => {
    return {
      url: props.defaultUrl || '',
      segment_id: props.defaultSegmentId || '',
      method: props.defaultMethod || 'POST',
      personalization_level: props.defaultPersonalizationLevel || 'moderate',
      target_elements: ['all'],
      implementation_method: props.defaultImplementationMethod || 'js_injection',
      device_type: props.defaultDeviceType || 'all',
      timeout: props.defaultTimeout || '45000',
      modelType: (props.defaultModelType as ModelProviderType) || 'anthropic',
      modelId: props.defaultModel || 'claude-3-5-sonnet-20240620',
      site_id: props.defaultSiteId || '',
      user_id: props.defaultUserId || '',
      analysis_id: props.defaultAnalysisId || '',
      include_preview: true,
      include_diff: true,
      include_performance_impact: true,
      includeScreenshot: true,
      test_mode: props.defaultTestMode ?? true,
      htmlContent: '',
      target_pages: '',
      redis_ttl: '86400',
      skip_cache: false
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: HtmlPersonalizationApiState): Record<string, any> => {
    if (state.method === 'GET') {
      return {}; // GET no necesita cuerpo
    }
    
    const body: Record<string, any> = {
      url: state.url,
      segment_id: state.segment_id,
      personalization_level: state.personalization_level,
      target_elements: state.target_elements,
      implementation_method: state.implementation_method,
      device_type: state.device_type,
      timeout: parseInt(state.timeout),
      include_preview: state.include_preview,
      include_diff: state.include_diff,
      include_performance_impact: state.include_performance_impact,
      includeScreenshot: state.includeScreenshot,
      test_mode: state.test_mode,
      skip_cache: state.skip_cache
    };
    
    // Agregar campos opcionales solo si tienen valores
    if (state.site_id) body.site_id = state.site_id;
    if (state.user_id) body.user_id = state.user_id;
    if (state.analysis_id) body.analysis_id = state.analysis_id;
    if (state.htmlContent) body.htmlContent = state.htmlContent;
    if (state.modelType) body.aiProvider = state.modelType;
    if (state.modelId) body.aiModel = state.modelId;
    if (state.redis_ttl) body.redis_ttl = parseInt(state.redis_ttl);
    
    // Procesar target_pages si está presente
    if (state.target_pages) {
      try {
        body.target_pages = state.target_pages.split(',').map(url => url.trim());
      } catch (error) {
        console.error('Error processing target_pages:', error);
      }
    }
    
    return body;
  },

  // Construir las cabeceras de la solicitud
  buildRequestHeaders: (state: HtmlPersonalizationApiState): Record<string, string> => {
    return {
      'Content-Type': 'application/json'
    };
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: HtmlPersonalizationApiState;
    setState: React.Dispatch<React.SetStateAction<HtmlPersonalizationApiState>>;
    showJsonOption: boolean;
    showScreenshotOption: boolean;
    showModelOptions: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showModelOptions } = props;
    
    const handleChange = (field: keyof HtmlPersonalizationApiState, value: any) => {
      setState({ ...state, [field]: value });
    };
    
    const handleTargetElementsChange = (element: string, isChecked: boolean) => {
      // Si se selecciona 'all', deseleccionar todos los demás
      if (element === 'all' && isChecked) {
        setState({ ...state, target_elements: ['all'] });
        return;
      }
      
      // Si se deselecciona 'all', mantener el resto de elementos
      if (element === 'all' && !isChecked) {
        // Si no hay más elementos seleccionados, seleccionar uno por defecto
        if (state.target_elements.length <= 1) {
          setState({ ...state, target_elements: ['content'] });
        } else {
          setState({ 
            ...state, 
            target_elements: state.target_elements.filter(e => e !== 'all') 
          });
        }
        return;
      }
      
      // Si se selecciona cualquier otro elemento, quitar 'all' si está presente
      let newElements = [...state.target_elements];
      
      if (isChecked) {
        // Agregar el nuevo elemento y quitar 'all' si existe
        newElements = [...newElements.filter(e => e !== 'all'), element as any];
      } else {
        // Quitar el elemento
        newElements = newElements.filter(e => e !== element);
        // Si no queda ninguno, agregar 'all'
        if (newElements.length === 0) {
          newElements = ['all'];
        }
      }
      
      setState({ ...state, target_elements: newElements as ('layout' | 'navigation' | 'content' | 'cta' | 'visuals' | 'forms' | 'all')[] });
    };
    
    return (
      <>
        <FormField
          label="URL del Sitio"
          id="url"
          type="text"
          value={state.url}
          onChange={(value) => handleChange('url', value)}
          placeholder="https://ejemplo.com"
          required
        />
        
        <FormField
          label="ID de Segmento"
          id="segment_id"
          type="text"
          value={state.segment_id}
          onChange={(value) => handleChange('segment_id', value)}
          placeholder="seg_123456"
          required
        />
        
        <FormField
          label="ID de Análisis (opcional)"
          id="analysis_id"
          type="text"
          value={state.analysis_id}
          onChange={(value) => handleChange('analysis_id', value)}
          placeholder="analysis_123456"
        />
        
        <SectionLabel>Opciones de Personalización</SectionLabel>
        
        <FormField
          label="Nivel de Personalización"
          id="personalization_level"
          type="select"
          value={state.personalization_level}
          onChange={(value) => handleChange('personalization_level', value)}
          options={[
            { value: 'minimal', label: 'Mínima' },
            { value: 'moderate', label: 'Moderada' },
            { value: 'extensive', label: 'Extensiva' }
          ]}
        />
        
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Elementos a Personalizar</label>
          <div className="space-y-2">
            {['all', 'layout', 'navigation', 'content', 'cta', 'visuals', 'forms'].map((element) => (
              <div key={element} className="flex items-center">
                <input
                  type="checkbox"
                  id={`element_${element}`}
                  checked={state.target_elements.includes(element as any)}
                  onChange={(e) => handleTargetElementsChange(element, e.target.checked)}
                  className="mr-2"
                />
                <label htmlFor={`element_${element}`} className="text-sm">
                  {element === 'all' ? 'Todos' : element.charAt(0).toUpperCase() + element.slice(1)}
                </label>
              </div>
            ))}
          </div>
        </div>
        
        <FormField
          label="Método de Implementación"
          id="implementation_method"
          type="select"
          value={state.implementation_method}
          onChange={(value) => handleChange('implementation_method', value)}
          options={[
            { value: 'js_injection', label: 'JavaScript Injection' },
            { value: 'static_html', label: 'Static HTML' },
            { value: 'hybrid', label: 'Hybrid' }
          ]}
        />
        
        <FormField
          label="Tipo de Dispositivo"
          id="device_type"
          type="select"
          value={state.device_type}
          onChange={(value) => handleChange('device_type', value)}
          options={[
            { value: 'all', label: 'Todos' },
            { value: 'desktop', label: 'Desktop' },
            { value: 'mobile', label: 'Mobile' },
            { value: 'tablet', label: 'Tablet' }
          ]}
        />
        
        <FormField
          label="URLs Específicas (separadas por comas)"
          id="target_pages"
          type="text"
          value={state.target_pages}
          onChange={(value) => handleChange('target_pages', value)}
          placeholder="https://ejemplo.com/pagina1, https://ejemplo.com/pagina2"
        />
        
        <SectionLabel>Opciones Avanzadas</SectionLabel>
        
        {showModelOptions && (
          <>
            <FormField
              label="Proveedor del Modelo"
              id="modelType"
              type="select"
              value={state.modelType}
              onChange={(value) => handleChange('modelType', value)}
              options={[
                { value: 'anthropic', label: 'Anthropic' },
                { value: 'openai', label: 'OpenAI' },
                { value: 'gemini', label: 'Google (Gemini)' }
              ]}
            />
            
            <FormField
              label="Modelo"
              id="modelId"
              type="select"
              value={state.modelId}
              onChange={(value) => handleChange('modelId', value)}
              options={MODEL_OPTIONS[state.modelType]}
            />
          </>
        )}
        
        <FormField
          label="Timeout (ms)"
          id="timeout"
          type="number"
          value={state.timeout}
          onChange={(value) => handleChange('timeout', value)}
          placeholder="45000"
          min={5000}
          max={120000}
        />
        
        <div className="grid grid-cols-2 gap-4">
          <FormField
            label="Incluir Preview"
            id="include_preview"
            type="checkbox"
            value={state.include_preview}
            onChange={(value) => handleChange('include_preview', value)}
          />
          
          <FormField
            label="Incluir Diff"
            id="include_diff"
            type="checkbox"
            value={state.include_diff}
            onChange={(value) => handleChange('include_diff', value)}
          />
          
          <FormField
            label="Incluir Impacto de Rendimiento"
            id="include_performance_impact"
            type="checkbox"
            value={state.include_performance_impact}
            onChange={(value) => handleChange('include_performance_impact', value)}
          />
          
          <FormField
            label="Incluir Screenshot"
            id="includeScreenshot"
            type="checkbox"
            value={state.includeScreenshot}
            onChange={(value) => handleChange('includeScreenshot', value)}
          />
        </div>
        
        <FormField
          label="Modo de Prueba"
          id="test_mode"
          type="checkbox"
          value={state.test_mode}
          onChange={(value) => handleChange('test_mode', value)}
        />
        
        <SectionLabel>Contenido Personalizado</SectionLabel>
        
        <FormField
          label="HTML Personalizado (opcional)"
          id="htmlContent"
          type="textarea"
          value={state.htmlContent}
          onChange={(value) => handleChange('htmlContent', value)}
          placeholder="Ingrese el HTML del sitio para personalización"
          rows={5}
        />
        
        <SectionLabel>Información de Almacenamiento</SectionLabel>
        
        <FormField
          label="Site ID (UUID)"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value) => handleChange('site_id', value)}
          placeholder="UUID del sitio"
        />
        
        <FormField
          label="User ID (UUID)"
          id="user_id"
          type="text"
          value={state.user_id}
          onChange={(value) => handleChange('user_id', value)}
          placeholder="UUID del usuario"
        />
        
        <SectionLabel>Opciones de Caché</SectionLabel>
        
        <FormField
          label="Redis TTL (seconds)"
          id="redis_ttl"
          type="text"
          value={state.redis_ttl}
          onChange={(value) => handleChange('redis_ttl', value)}
          placeholder="86400"
        />
        
        <div className="mb-4">
          <div className="flex items-center">
            <input
              type="checkbox"
              id="skip_cache"
              checked={state.skip_cache}
              onChange={(e) => handleChange('skip_cache', e.target.checked)}
              className="mr-2"
            />
            <label htmlFor="skip_cache" className="text-sm">
              Skip Cache (Force Regeneration)
            </label>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            If checked, will bypass Redis cache and generate a new personalization
          </p>
        </div>
      </>
    );
  },

  buildRequestUrl: (state: HtmlPersonalizationApiState, endpoint: string): string => {
    if (state.method !== 'GET') {
      return endpoint;
    }
    
    // Construir la URL con parámetros para GET
    const urlParams = new URLSearchParams();
    urlParams.append('url', state.url);
    urlParams.append('segment_id', state.segment_id);
    
    if (state.personalization_level) {
      urlParams.append('personalization_level', state.personalization_level);
    }
    
    if (state.implementation_method) {
      urlParams.append('implementation_method', state.implementation_method);
    }
    
    if (state.device_type) {
      urlParams.append('device_type', state.device_type);
    }
    
    if (state.timeout) {
      urlParams.append('timeout', state.timeout);
    }
    
    if (state.site_id) {
      urlParams.append('site_id', state.site_id);
    }
    
    // Add Redis parameters
    if (state.redis_ttl) {
      urlParams.append('redis_ttl', state.redis_ttl);
    }
    
    if (state.skip_cache) {
      urlParams.append('skip_cache', 'true');
    }
    
    return `${endpoint}?${urlParams.toString()}`;
  }
};

export default HtmlPersonalizationApi; 