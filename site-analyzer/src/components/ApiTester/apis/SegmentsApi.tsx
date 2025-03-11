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
}

// Estado específico para la API de Segmentos
export interface SegmentsApiState {
  siteUrl: string;
  segmentCount: number;
  modelType: ModelProviderType;
  modelId: string;
  includeScreenshot: boolean;
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
      includeScreenshot: false
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: SegmentsApiState): Record<string, any> => {
    const body: Record<string, any> = {
      url: state.siteUrl,
      segmentCount: state.segmentCount
    };
    
    if (state.modelType) body.aiProvider = state.modelType;
    if (state.modelId) body.aiModel = state.modelId;
    if (state.includeScreenshot) body.includeScreenshot = state.includeScreenshot;
    
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
    
    const handleChange = (field: keyof SegmentsApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
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