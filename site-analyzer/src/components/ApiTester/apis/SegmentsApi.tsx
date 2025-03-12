'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField } from '../utils';

// Props específicas para la API de Segmentos
export interface SegmentsApiProps {
  defaultUrl?: string;
  defaultSegmentCount?: number;
  defaultModelType?: string;
  defaultModel?: string;
  showModelOptions?: boolean;
  defaultMode?: 'analyze' | 'create' | 'update';
}

// Estado específico para la API de Segmentos
export interface SegmentsApiState {
  siteUrl: string;
  segmentCount: number;
  modelType: ModelProviderType;
  modelId: string;
  includeScreenshot: boolean;
  user_id?: string;
  site_id?: string;
  mode: 'analyze' | 'create' | 'update';
}

// Configuración de la API de Segmentos
const SegmentsApi: BaseApiConfig = {
  id: 'segments',
  name: 'API de Segmentos',
  description: 'API para análisis de segmentos de sitios web',
  defaultEndpoint: '/api/site/segments',

  // Obtener el estado inicial
  getInitialState: (props: SegmentsApiProps): SegmentsApiState => {
    return {
      siteUrl: props.defaultUrl || '',
      segmentCount: props.defaultSegmentCount || 10,
      modelType: (props.defaultModelType as ModelProviderType) || 'anthropic',
      modelId: props.defaultModel || 'claude-3-5-sonnet-20240620',
      includeScreenshot: false,
      user_id: '',
      site_id: '',
      mode: props.defaultMode || 'analyze'
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: SegmentsApiState): Record<string, any> => {
    const body: Record<string, any> = {
      url: state.siteUrl,
      segmentCount: state.segmentCount,
      mode: state.mode
    };
    
    if (state.modelType) body.aiProvider = state.modelType;
    if (state.modelId) body.aiModel = state.modelId;
    if (state.includeScreenshot) body.includeScreenshot = state.includeScreenshot;
    
    // Agregar campos específicos según el modo
    if (state.mode === 'create' || state.mode === 'update') {
      if (state.user_id) body.user_id = state.user_id;
      if (state.site_id) body.site_id = state.site_id;
    }
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: SegmentsApiState;
    setState: React.Dispatch<React.SetStateAction<SegmentsApiState>>;
    showModelOptions?: boolean;
    showJsonOption?: boolean;
    showScreenshotOption?: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showModelOptions, showJsonOption, showScreenshotOption } = props;
    
    // Determinar el endpoint según el modo
    const getEndpoint = (mode: 'analyze' | 'create' | 'update') => {
      // Siempre devolver la misma ruta independientemente del modo
      return '/api/site/segments';
    };
    
    const handleChange = (field: keyof SegmentsApiState, value: any) => {
      setState(prev => {
        const newState = { ...prev, [field]: value };
        
        // Ya no necesitamos cambiar el endpoint cuando cambia el modo
        // El modo se enviará como parte del cuerpo de la solicitud
        
        return newState;
      });
    };
    
    return (
      <>
        <FormField
          label="Modo de Operación"
          id="mode"
          type="select"
          value={state.mode}
          onChange={(value) => handleChange('mode', value)}
          options={[
            { value: 'analyze', label: 'Analizar' },
            { value: 'create', label: 'Crear' },
            { value: 'update', label: 'Actualizar' }
          ]}
        />
        
        <FormField
          label="URL del Sitio"
          id="siteUrl"
          type="text"
          value={state.siteUrl}
          onChange={(value) => handleChange('siteUrl', value)}
          placeholder="https://ejemplo.com"
          required
        />
        
        <FormField
          label="Número de Segmentos"
          id="segmentCount"
          type="number"
          value={state.segmentCount}
          onChange={(value) => handleChange('segmentCount', value)}
          placeholder="10"
          min={1}
          max={50}
        />
        
        <FormField
          label="ID de Usuario (opcional)"
          id="user_id"
          type="text"
          value={state.user_id}
          onChange={(value) => handleChange('user_id', value)}
          placeholder="user_123456"
        />
        
        <FormField
          label="ID del Sitio (opcional)"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value) => handleChange('site_id', value)}
          placeholder="site_123456"
        />
        
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
        
        {showScreenshotOption && (
          <div style={{ marginBottom: '1rem' }}>
            <label>Opciones adicionales</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <FormField
                label="Incluir captura"
                id="includeScreenshot"
                type="checkbox"
                value={state.includeScreenshot}
                onChange={(value) => handleChange('includeScreenshot', value)}
              />
            </div>
          </div>
        )}
      </>
    );
  }
};

export default SegmentsApi; 