'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';
import { API_KEYS } from '@/lib/api-keys';

// Props específicas para la API de Análisis UX
export interface UxAnalysisApiProps {
  defaultSiteId?: string;
  defaultUserId?: string;
  defaultMethod?: 'GET' | 'POST';
}

// Estado específico para la API de Análisis UX
export interface UxAnalysisApiState {
  site_id: string;
  user_id: string;
  method: 'GET' | 'POST';
  apiKey: string;
  apiSecret: string;
  timeout: number;
  includeScreenshot: boolean;
  provider: 'anthropic' | 'openai' | 'gemini';
  modelId: string;
  updateBranding: boolean;
  language: 'en' | 'es';
}

// Opciones de modelos por proveedor
const MODEL_OPTIONS = {
  anthropic: [
    { value: 'claude-3-5-sonnet-20240620', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
    { value: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet' },
    { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' }
  ],
  openai: [
    { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-4', label: 'GPT-4' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
  ],
  gemini: [
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    { value: 'gemini-1.0-pro', label: 'Gemini 1.0 Pro' }
  ]
};

// Configuración de la API de Análisis UX
const UxAnalysisApi: BaseApiConfig = {
  id: 'ux-analysis',
  name: 'API de Análisis UX y Branding',
  description: 'Análisis integral de UX usando site_id y completado automático del objeto settings.branding',
  defaultEndpoint: '/api/agents/ux/analyze',

  // Obtener el estado inicial
  getInitialState: (props: UxAnalysisApiProps): UxAnalysisApiState => {
    return {
      site_id: props.defaultSiteId || '',
      user_id: props.defaultUserId || '',
      method: props.defaultMethod || 'POST',
      apiKey: API_KEYS.local.key,
      apiSecret: API_KEYS.local.secret,
      timeout: 30000,
      includeScreenshot: true,
      provider: 'anthropic',
      modelId: 'claude-3-5-sonnet-20240620',
      updateBranding: true,
      language: 'es'
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: UxAnalysisApiState): Record<string, any> => {
    if (state.method === 'GET') {
      return {};
    }
    
    return { 
      site_id: state.site_id,
      user_id: state.user_id,
      options: {
        timeout: state.timeout,
        includeScreenshot: state.includeScreenshot,
        provider: state.provider,
        modelId: state.modelId,
        updateBranding: state.updateBranding,
        language: state.language
      }
    };
  },

  // Construir las cabeceras de la solicitud
  buildRequestHeaders: (state: UxAnalysisApiState): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': state.apiKey,
      'x-api-secret': state.apiSecret
    };

    return headers;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: UxAnalysisApiState;
    setState: (newState: Partial<UxAnalysisApiState> | ((prevState: UxAnalysisApiState) => UxAnalysisApiState)) => void;
    showJsonOption: boolean;
    showScreenshotOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof UxAnalysisApiState, value: any) => {
      setState({ [field]: value } as Partial<UxAnalysisApiState>);
    };
    
    return (
      <>
        <SectionLabel>Parámetros Obligatorios</SectionLabel>
        
        <FormField
          label="Site ID (UUID)"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value) => handleChange('site_id', value)}
          placeholder="uuid-del-sitio"
          required
        />
        
        <SectionLabel>Parámetros Opcionales</SectionLabel>
        
        <FormField
          label="User ID (UUID)"
          id="user_id"
          type="text"
          value={state.user_id}
          onChange={(value) => handleChange('user_id', value)}
          placeholder="uuid-del-usuario (opcional, se obtiene del sitio)"
        />
        
        <SectionLabel>Configuración de IA</SectionLabel>
        
        <FormField
          label="Proveedor de IA"
          id="provider"
          type="select"
          value={state.provider}
          onChange={(value: string) => {
            handleChange('provider', value as 'anthropic' | 'openai' | 'gemini');
            // Actualizar modelo por defecto al cambiar proveedor
            const defaultModel = MODEL_OPTIONS[value as keyof typeof MODEL_OPTIONS][0].value;
            handleChange('modelId', defaultModel);
          }}
          options={[
            { value: 'anthropic', label: 'Anthropic (Claude)' },
            { value: 'openai', label: 'OpenAI (GPT)' },
            { value: 'gemini', label: 'Google (Gemini)' }
          ]}
        />
        
        <FormField
          label="Modelo de IA"
          id="modelId"
          type="select"
          value={state.modelId}
          onChange={(value: string) => handleChange('modelId', value)}
          options={MODEL_OPTIONS[state.provider]}
        />
        
        <SectionLabel>Opciones de Análisis</SectionLabel>
        
        <FormField
          label="Timeout (ms)"
          id="timeout"
          type="number"
          value={state.timeout}
          onChange={(value) => handleChange('timeout', parseInt(value as string) || 30000)}
          placeholder="30000"
          min={5000}
          max={60000}
        />
        
        <FormField
          label="Incluir Captura de Pantalla"
          id="includeScreenshot"
          type="checkbox"
          value={state.includeScreenshot}
          onChange={(value) => handleChange('includeScreenshot', value)}
        />
        
        <FormField
          label="Actualizar Branding en BD"
          id="updateBranding"
          type="checkbox"
          value={state.updateBranding}
          onChange={(value) => handleChange('updateBranding', value)}
        />
        
        <FormField
          label="Idioma del Análisis"
          id="language"
          type="select"
          value={state.language}
          onChange={(value: string) => handleChange('language', value as 'en' | 'es')}
          options={[
            { value: 'es', label: 'Español' },
            { value: 'en', label: 'English' }
          ]}
        />
      </>
    );
  },
};

export default UxAnalysisApi; 