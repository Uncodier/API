'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../utils';
import { API_KEYS } from '@/lib/api-keys';

// Props específicas para la API Básica de Análisis
export interface BasicAnalyzeApiProps {
  defaultUrl?: string;
  defaultMethod?: 'GET' | 'POST';
}

// Estado específico para la API Básica de Análisis
export interface BasicAnalyzeApiState {
  url: string;
  method: 'GET' | 'POST';
  apiKey: string;
  apiSecret: string;
  includeRawHtml: boolean;
}

// Configuración de la API Básica de Análisis
const BasicAnalyzeApi: BaseApiConfig = {
  id: 'basic-analyze',
  name: 'API Básica de Análisis',
  description: 'API simple para análisis de sitios web',
  defaultEndpoint: '/api/analyze',

  // Obtener el estado inicial
  getInitialState: (props: BasicAnalyzeApiProps): BasicAnalyzeApiState => {
    return {
      url: props.defaultUrl || '',
      method: props.defaultMethod || 'POST',
      apiKey: API_KEYS.local.key,
      apiSecret: API_KEYS.local.secret,
      includeRawHtml: false,
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: BasicAnalyzeApiState): Record<string, any> => {
    if (state.method === 'GET') {
      return {};
    }
    
    return { 
      url: state.url,
      includeRawHtml: state.includeRawHtml
    };
  },

  // Construir las cabeceras de la solicitud
  buildRequestHeaders: (state: BasicAnalyzeApiState): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': state.apiKey,
      'x-api-secret': state.apiSecret
    };

    return headers;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: BasicAnalyzeApiState;
    setState: (newState: Partial<BasicAnalyzeApiState> | ((prevState: BasicAnalyzeApiState) => BasicAnalyzeApiState)) => void;
    showJsonOption: boolean;
    showScreenshotOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof BasicAnalyzeApiState, value: any) => {
      setState({ [field]: value } as Partial<BasicAnalyzeApiState>);
    };
    
    return (
      <>
        <FormField
          label="URL"
          id="url"
          type="text"
          value={state.url}
          onChange={(value) => handleChange('url', value)}
          placeholder="https://example.com"
          required
        />
        
        <SectionLabel>Opciones adicionales</SectionLabel>
        
        <FormField
          label="Include Raw HTML"
          id="includeRawHtml"
          type="checkbox"
          value={state.includeRawHtml}
          onChange={(value) => handleChange('includeRawHtml', value)}
        />
      </>
    );
  },
};

export default BasicAnalyzeApi; 