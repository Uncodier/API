'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props específicas para la API General
export interface GeneralApiProps {
  defaultMessage?: string;
  defaultConversationId?: string;
  defaultContext?: string;
  defaultModelType?: string;
  defaultModel?: string;
  showModelOptions?: boolean;
  defaultUrl?: string;
  showSiteUrlField?: boolean;
  showUrlField?: boolean;
  defaultMethod?: 'GET' | 'POST';
}

// Estado específico para la API General
export interface GeneralApiState {
  method: 'GET' | 'POST';
  message: string;
  modelType: ModelProviderType;
  modelId: string;
  url: string;
  conversationId?: string;
  context?: string;
  includeScreenshot: boolean;
  jsonResponse: boolean;
}

// Configuración de la API General
const GeneralApi: BaseApiConfig = {
  id: 'general',
  name: 'API General',
  description: 'API para conversaciones generales',
  defaultEndpoint: '/api/conversation',

  // Obtener el estado inicial
  getInitialState: (props: GeneralApiProps): GeneralApiState => {
    return {
      method: props.defaultMethod || 'POST',
      message: props.defaultMessage || '',
      modelType: (props.defaultModelType as ModelProviderType) || 'anthropic',
      modelId: props.defaultModel || 'claude-3-5-sonnet-20240620',
      url: props.defaultUrl || '',
      conversationId: props.defaultConversationId || '',
      context: props.defaultContext || '',
      includeScreenshot: false,
      jsonResponse: false
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: GeneralApiState): Record<string, any> => {
    const body: Record<string, any> = { 
      messages: [
        { role: 'user', content: state.message }
      ],
      modelType: state.modelType,
      modelId: state.modelId
    };
    
    if (state.url) body.url = state.url;
    if (state.conversationId) body.conversationId = state.conversationId;
    
    if (state.context) {
      try {
        body.context = JSON.parse(state.context);
      } catch (e) {
        body.context = state.context;
      }
    }
    
    if (state.jsonResponse) body.responseFormat = 'json';
    if (state.includeScreenshot) body.includeScreenshot = state.includeScreenshot;
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: GeneralApiState;
    setState: React.Dispatch<React.SetStateAction<GeneralApiState>>;
    showModelOptions: boolean;
    showSiteUrlField: boolean;
    showUrlField?: boolean;
    showJsonOption: boolean;
    showScreenshotOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showModelOptions, showSiteUrlField, showUrlField, showJsonOption, showScreenshotOption } = props;
    
    const handleChange = (field: keyof GeneralApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    // Show the URL field if either showSiteUrlField or showUrlField is true
    const shouldShowUrlField = showSiteUrlField || showUrlField;
    
    return (
      <>
        <FormField
          label="Mensaje"
          id="message"
          type="textarea"
          value={state.message}
          onChange={(value) => handleChange('message', value)}
          placeholder="Escribe tu mensaje aquí..."
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
        
        {shouldShowUrlField && (
          <FormField
            label="URL del Sitio (opcional)"
            id="url"
            type="text"
            value={state.url}
            onChange={(value) => handleChange('url', value)}
            placeholder="https://ejemplo.com"
          />
        )}
        
        <FormField
          label="ID de Conversación (opcional)"
          id="conversationId"
          type="text"
          value={state.conversationId}
          onChange={(value) => handleChange('conversationId', value)}
          placeholder="conv_123456789"
        />
        
        <FormField
          label="Contexto (JSON, opcional)"
          id="context"
          type="textarea"
          value={state.context}
          onChange={(value) => handleChange('context', value)}
          placeholder='{"siteAnalysis": "...", "userPreferences": "..."}'
          rows={4}
        />
        
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

export default GeneralApi; 