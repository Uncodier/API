'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField, SectionLabel } from '../utils';

// Props específicas para la API de Sitio
export interface SiteApiProps {
  defaultUrl?: string;
  defaultAnalysisType?: 'complete' | 'structure';
  defaultMethod?: 'GET' | 'POST';
  defaultTimeout?: string;
  defaultDepth?: string;
  defaultModelType?: string;
  defaultModel?: string;
  showModelOptions?: boolean;
  showAnalysisTypeField?: boolean;
  defaultSiteId?: string;
  defaultUserId?: string;
  defaultSaveToDatabase?: boolean;
}

// Estado específico para la API de Sitio
export interface SiteApiState {
  siteUrl: string;
  method: 'GET' | 'POST';
  analysisType: 'complete' | 'structure';
  timeout: string;
  depth: string;
  userAgent: string;
  ignoreSSL: boolean;
  failOnError: boolean;
  safeSelectors: boolean;
  includeScreenshot: boolean;
  jsonResponse: boolean;
  htmlContent: string;
  modelType: ModelProviderType;
  modelId: string;
  site_id: string;
  user_id: string;
  saveToDatabase: boolean;
}

// Configuración de la API de Sitio
const SiteApi: BaseApiConfig = {
  id: 'site',
  name: 'API de Sitio',
  description: 'API para análisis de sitios web',
  defaultEndpoint: '/api/site/analyze',

  // Obtener el estado inicial
  getInitialState: (props: SiteApiProps): SiteApiState => {
    return {
      siteUrl: props.defaultUrl || '',
      method: props.defaultMethod || 'POST',
      analysisType: props.defaultAnalysisType || 'complete',
      timeout: props.defaultTimeout || '30000',
      depth: props.defaultDepth || '2',
      userAgent: '',
      ignoreSSL: false,
      failOnError: false,
      safeSelectors: true,
      includeScreenshot: false,
      jsonResponse: false,
      htmlContent: '',
      modelType: (props.defaultModelType as ModelProviderType) || 'openai',
      modelId: props.defaultModel || 'gpt-4o',
      site_id: props.defaultSiteId || '',
      user_id: props.defaultUserId || '',
      saveToDatabase: props.defaultSaveToDatabase || false
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: SiteApiState): Record<string, any> => {
    if (state.method === 'GET') {
      return {};
    }
    
    const body: Record<string, any> = { url: state.siteUrl };
    const options: Record<string, any> = {};
    
    // Add site_id and user_id if they exist
    if (state.site_id) body.site_id = state.site_id;
    if (state.user_id) body.user_id = state.user_id;
    
    if (state.analysisType === 'complete') {
      if (state.timeout) options.timeout = parseInt(state.timeout);
      if (state.userAgent) options.userAgent = state.userAgent;
      if (state.ignoreSSL) options.ignoreSSL = state.ignoreSSL;
      if (state.failOnError) options.failOnError = state.failOnError;
      if (!state.safeSelectors) options.safeSelectors = state.safeSelectors;
      if (state.includeScreenshot) options.includeScreenshot = state.includeScreenshot;
      if (state.modelType) options.provider = state.modelType;
      if (state.modelId) options.modelId = state.modelId;
      if (state.saveToDatabase) options.saveToDatabase = state.saveToDatabase;
    } 
    else if (state.analysisType === 'structure') {
      if (state.depth) options.depth = parseInt(state.depth);
      if (state.includeScreenshot) options.includeScreenshot = state.includeScreenshot;
      if (state.modelType) options.provider = state.modelType;
      if (state.modelId) options.modelId = state.modelId;
      if (state.saveToDatabase) options.saveToDatabase = state.saveToDatabase;
    }
    
    if (Object.keys(options).length > 0) {
      body.options = options;
    }
    
    if (state.htmlContent) body.htmlContent = state.htmlContent;
    
    return body;
  },

  // Construir las cabeceras de la solicitud
  buildRequestHeaders: (state: SiteApiState): Record<string, string> => {
    const headers: Record<string, string> = {};
    
    // Si se necesitan cabeceras específicas para la API de sitio,
    // se pueden agregar aquí
    
    return headers;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: SiteApiState;
    setState: React.Dispatch<React.SetStateAction<SiteApiState>>;
    showJsonOption: boolean;
    showScreenshotOption: boolean;
    showModelOptions: boolean;
    showAnalysisTypeField?: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption, showScreenshotOption, showModelOptions, showAnalysisTypeField = true } = props;
    
    const handleChange = (field: keyof SiteApiState, value: any) => {
      setState({ ...state, [field]: value });
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
        
        {showAnalysisTypeField && (
          <FormField
            label="Tipo de Análisis"
            id="analysisType"
            type="select"
            value={state.analysisType}
            onChange={(value) => handleChange('analysisType', value)}
            options={[
              { value: 'complete', label: 'Completo' },
              { value: 'structure', label: 'Solo Estructura' }
            ]}
          />
        )}
        
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
          placeholder="30000"
        />
        
        <FormField
          label="Profundidad de Análisis"
          id="depth"
          type="number"
          value={state.depth}
          onChange={(value) => handleChange('depth', value)}
          placeholder="2"
          min={1}
          max={5}
        />
        
        <FormField
          label="User Agent (opcional)"
          id="userAgent"
          type="text"
          value={state.userAgent}
          onChange={(value) => handleChange('userAgent', value)}
          placeholder="Mozilla/5.0..."
        />
        
        <SectionLabel>Database Storage Options</SectionLabel>
        
        <FormField
          label="Site ID (UUID)"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value) => handleChange('site_id', value)}
          placeholder="UUID of the site"
        />
        
        <FormField
          label="User ID (UUID)"
          id="user_id"
          type="text"
          value={state.user_id}
          onChange={(value) => handleChange('user_id', value)}
          placeholder="UUID of the user"
        />
        
        <FormField
          label="Save to Database"
          id="saveToDatabase"
          type="checkbox"
          value={state.saveToDatabase}
          onChange={(value) => handleChange('saveToDatabase', value)}
        />
        
        {(showJsonOption || showScreenshotOption || showModelOptions) && (
          <>
            <SectionLabel>Advanced Options</SectionLabel>
            
            {showScreenshotOption && (
              <FormField
                label="Include Screenshot"
                id="includeScreenshot"
                type="checkbox"
                value={state.includeScreenshot}
                onChange={(value) => handleChange('includeScreenshot', value)}
              />
            )}
            
            <FormField
              label="Ignore SSL Errors"
              id="ignoreSSL"
              type="checkbox"
              value={state.ignoreSSL}
              onChange={(value) => handleChange('ignoreSSL', value)}
            />
            
            <FormField
              label="Fail on Error"
              id="failOnError"
              type="checkbox"
              value={state.failOnError}
              onChange={(value) => handleChange('failOnError', value)}
            />
            
            <FormField
              label="Safe Selectors"
              id="safeSelectors"
              type="checkbox"
              value={state.safeSelectors}
              onChange={(value) => handleChange('safeSelectors', value)}
            />
            
            {showJsonOption && (
              <FormField
                label="JSON Response Format"
                id="jsonResponse"
                type="checkbox"
                value={state.jsonResponse}
                onChange={(value) => handleChange('jsonResponse', value)}
              />
            )}
          </>
        )}
        
        <SectionLabel>HTML Content (Optional)</SectionLabel>
        <FormField
          label="HTML Content"
          id="htmlContent"
          type="textarea"
          value={state.htmlContent}
          onChange={(value) => handleChange('htmlContent', value)}
          placeholder="<html>...</html>"
          rows={5}
        />
      </>
    );
  }
};

export default SiteApi; 