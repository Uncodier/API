'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField } from '../components/FormComponents';

// Props específicas para la API de ICP
export interface IcpApiProps {
  defaultUrl?: string;
  defaultSegmentId?: string;
  defaultModelType?: string;
  defaultModel?: string;
  showModelOptions?: boolean;
  defaultMode?: 'analyze' | 'create' | 'update';
}

// Estado específico para la API de ICP
export interface IcpApiState {
  url: string;
  segment_id: string;
  mode: 'analyze' | 'create' | 'update';
  modelType: ModelProviderType;
  modelId: string;
  includeScreenshot: boolean;
  user_id?: string;
  site_id?: string;
  timeout: number;
  personalizationMetrics: string[];
  minConfidenceScore: number;
}

// Configuración de la API de ICP
const IcpApi: BaseApiConfig = {
  id: 'icp',
  name: 'API de Perfiles de Cliente Ideal',
  description: 'API para análisis y creación de perfiles de cliente ideal (ICP)',
  defaultEndpoint: '/api/site/icp',

  // Obtener el estado inicial
  getInitialState: (props: IcpApiProps): IcpApiState => {
    return {
      url: props.defaultUrl || 'https://ejemplo.com',
      segment_id: props.defaultSegmentId || 'seg_content_creators',
      mode: props.defaultMode || 'analyze',
      modelType: (props.defaultModelType as ModelProviderType) || 'anthropic',
      modelId: props.defaultModel || 'claude-3-5-sonnet-20240620',
      includeScreenshot: true,
      user_id: '',
      site_id: '',
      timeout: 45000,
      personalizationMetrics: ['engagementRate', 'conversionRate'],
      minConfidenceScore: 0.7
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: IcpApiState): Record<string, any> => {
    const body: Record<string, any> = {
      url: state.url,
      segment_id: state.segment_id,
      mode: state.mode,
      timeout: state.timeout,
      personalizationMetrics: state.personalizationMetrics,
      minConfidenceScore: state.minConfidenceScore,
      includeScreenshot: state.includeScreenshot
    };
    
    if (state.modelType) body.provider = state.modelType;
    if (state.modelId) body.modelId = state.modelId;
    
    // Agregar campos específicos según el modo
    if (state.mode === 'create' || state.mode === 'update') {
      if (state.user_id) body.user_id = state.user_id;
      if (state.site_id) body.site_id = state.site_id;
    }
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: IcpApiState;
    setState: React.Dispatch<React.SetStateAction<IcpApiState>>;
    showModelOptions?: boolean;
  }) => {
    const { state, setState, showModelOptions } = props;
    
    const handleChange = (field: keyof IcpApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    const handleMultiselectChange = (field: keyof IcpApiState, value: string, checked: boolean) => {
      setState(prev => {
        const currentValues = prev[field] as string[];
        let newValues;
        
        if (checked) {
          newValues = [...currentValues, value];
        } else {
          newValues = currentValues.filter(v => v !== value);
        }
        
        return { ...prev, [field]: newValues };
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
            { value: 'analyze', label: 'Analizar (sin crear perfiles)' },
            { value: 'create', label: 'Crear (crear perfiles nuevos)' },
            { value: 'update', label: 'Actualizar (actualizar perfiles existentes)' }
          ]}
        />
        
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
          label="ID del Segmento"
          id="segment_id"
          type="text"
          value={state.segment_id}
          onChange={(value) => handleChange('segment_id', value)}
          placeholder="ID del segmento en la base de datos"
          required
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
          placeholder="site_789012"
        />
        
        <FormField
          label="Incluir captura de pantalla"
          id="includeScreenshot"
          type="checkbox"
          value={state.includeScreenshot}
          onChange={(value) => handleChange('includeScreenshot', value)}
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
      </>
    );
  }
};

export default IcpApi; 