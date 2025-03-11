'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField } from '../utils';

// Props específicas para la API de Sitio
export interface SiteApiProps {
  defaultUrl?: string;
  defaultAnalysisType?: 'complete' | 'structure';
  defaultMethod?: 'GET' | 'POST';
  defaultTimeout?: string;
  defaultDepth?: string;
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
      htmlContent: ''
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: SiteApiState): Record<string, any> => {
    if (state.method === 'GET') {
      return {};
    }
    
    const body: Record<string, any> = { url: state.siteUrl };
    
    if (state.analysisType === 'complete') {
      if (state.timeout) body.timeout = parseInt(state.timeout);
      if (state.userAgent) body.userAgent = state.userAgent;
      if (state.ignoreSSL) body.ignoreSSL = state.ignoreSSL;
      if (state.failOnError) body.failOnError = state.failOnError;
      if (!state.safeSelectors) body.safeSelectors = state.safeSelectors;
      if (state.includeScreenshot) body.includeScreenshot = state.includeScreenshot;
    } 
    else if (state.analysisType === 'structure') {
      if (state.depth) body.depth = parseInt(state.depth);
      if (state.includeScreenshot) body.includeScreenshot = state.includeScreenshot;
      if (state.htmlContent) body.html = state.htmlContent;
    }
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: SiteApiState;
    setState: React.Dispatch<React.SetStateAction<SiteApiState>>;
    showJsonOption: boolean;
    showScreenshotOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption, showScreenshotOption } = props;
    
    const handleChange = (field: keyof SiteApiState, value: any) => {
      setState(prev => {
        const newState = { ...prev, [field]: value };
        
        // Actualizar el endpoint cuando cambia el tipo de análisis
        if (field === 'analysisType') {
          // No necesitamos actualizar el endpoint aquí, se manejará en el componente principal
        }
        
        return newState;
      });
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
          label="Método"
          id="method"
          type="select"
          value={state.method}
          onChange={(value) => handleChange('method', value)}
          options={[
            { value: 'GET', label: 'GET' },
            { value: 'POST', label: 'POST' }
          ]}
        />
        
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
        
        <div style={{ marginBottom: '1rem' }}>
          <label>Opciones adicionales</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {showScreenshotOption && (
              <FormField
                label="Incluir captura"
                id="includeScreenshot"
                type="checkbox"
                value={state.includeScreenshot}
                onChange={(value) => handleChange('includeScreenshot', value)}
              />
            )}
            
            <FormField
              label="Ignorar errores SSL"
              id="ignoreSSL"
              type="checkbox"
              value={state.ignoreSSL}
              onChange={(value) => handleChange('ignoreSSL', value)}
            />
            
            <FormField
              label="Fallar en error"
              id="failOnError"
              type="checkbox"
              value={state.failOnError}
              onChange={(value) => handleChange('failOnError', value)}
            />
            
            <FormField
              label="Selectores seguros"
              id="safeSelectors"
              type="checkbox"
              value={state.safeSelectors}
              onChange={(value) => handleChange('safeSelectors', value)}
            />
            
            {showJsonOption && (
              <FormField
                label="Respuesta en formato JSON"
                id="jsonResponse"
                type="checkbox"
                value={state.jsonResponse}
                onChange={(value) => handleChange('jsonResponse', value)}
              />
            )}
          </div>
        </div>
        
        <FormField
          label="Contenido HTML (opcional)"
          id="htmlContent"
          type="textarea"
          value={state.htmlContent}
          onChange={(value) => handleChange('htmlContent', value)}
          placeholder="<html>...</html>"
          rows={4}
        />
      </>
    );
  }
};

export default SiteApi; 