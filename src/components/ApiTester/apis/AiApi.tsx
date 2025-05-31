'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props específicas para la API de IA
export interface AiApiProps {
  defaultQuery?: string;
  defaultModelType?: string;
  defaultModel?: string;
  showModelOptions?: boolean;
  defaultUrl?: string;
  showSiteUrlField?: boolean;
}

// Estado específico para la API de IA
export interface AiApiState {
  query: string;
  modelType: ModelProviderType;
  modelId: string;
  siteUrl: string;
  includeScreenshot: boolean;
  jsonResponse: boolean;
}

// Configuración de la API de IA
const AiApi: BaseApiConfig = {
  id: 'ai',
  name: 'API de IA',
  description: 'API para consultas de inteligencia artificial',
  defaultEndpoint: '/api/ai',

  // Obtener el estado inicial
  getInitialState: (props: AiApiProps): AiApiState => {
    return {
      query: props.defaultQuery || '',
      modelType: (props.defaultModelType as ModelProviderType) || 'anthropic',
      modelId: props.defaultModel || 'claude-3-5-sonnet-20240620',
      siteUrl: props.defaultUrl || '',
      includeScreenshot: false,
      jsonResponse: false
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: AiApiState): Record<string, any> => {
    const body: Record<string, any> = { 
      messages: [
        { role: 'user', content: state.query }
      ]
    };
    
    if (state.modelType) body.modelType = state.modelType;
    if (state.modelId) body.modelId = state.modelId;
    if (state.siteUrl) body.url = state.siteUrl;
    if (state.jsonResponse) body.responseFormat = 'json';
    if (state.includeScreenshot) body.includeScreenshot = state.includeScreenshot;
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: AiApiState;
    setState: React.Dispatch<React.SetStateAction<AiApiState>>;
    showModelOptions: boolean;
    showSiteUrlField: boolean;
    showJsonOption: boolean;
    showScreenshotOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showModelOptions, showSiteUrlField, showJsonOption, showScreenshotOption } = props;
    
    const handleChange = (field: keyof AiApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
        <FormField
          label="Consulta"
          id="query"
          type="textarea"
          value={state.query}
          onChange={(value) => handleChange('query', value)}
          placeholder="Escribe tu consulta aquí..."
          rows={4}
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
        
        {showSiteUrlField && (
          <FormField
            label="URL del Sitio (opcional)"
            id="siteUrl"
            type="text"
            value={state.siteUrl}
            onChange={(value) => handleChange('siteUrl', value)}
            placeholder="https://ejemplo.com"
          />
        )}
        
        {/* Opciones adicionales */}
        {(showJsonOption || showScreenshotOption) && (
          <>
            <SectionLabel>Opciones adicionales</SectionLabel>
            
            {showJsonOption && (
              <FormField
                label="Respuesta en formato JSON"
                id="jsonResponse"
                type="checkbox"
                value={state.jsonResponse}
                onChange={(value) => handleChange('jsonResponse', value)}
              />
            )}
            
            {showScreenshotOption && (
              <FormField
                label="Incluir captura"
                id="includeScreenshot"
                type="checkbox"
                value={state.includeScreenshot}
                onChange={(value) => handleChange('includeScreenshot', value)}
              />
            )}
          </>
        )}
      </>
    );
  }
};

export default AiApi; 