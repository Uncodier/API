'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField, SectionLabel } from '../utils';

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
  defaultMethod?: 'GET' | 'POST';
}

// Estado específico para la API General
export interface GeneralApiState {
  method: 'GET' | 'POST';
  siteUrl: string;
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
      siteUrl: props.defaultUrl || '',
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
    
    if (state.siteUrl) body.url = state.siteUrl;
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
    showJsonOption: boolean;
    showScreenshotOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showModelOptions, showSiteUrlField, showJsonOption, showScreenshotOption } = props;
    
    const handleChange = (field: keyof GeneralApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
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