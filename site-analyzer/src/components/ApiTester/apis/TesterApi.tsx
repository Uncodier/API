'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField } from '../utils';

// Props específicas para la API de Tester
export interface TesterApiProps {
  defaultTestType?: 'success' | 'error' | 'partial' | 'timeout';
  defaultDelay?: number;
  defaultModelType?: string;
  defaultModel?: string;
  showModelOptions?: boolean;
  defaultResponseSize?: 'small' | 'medium' | 'large';
}

// Estado específico para la API de Tester
export interface TesterApiState {
  testType: 'success' | 'error' | 'partial' | 'timeout';
  delay: number;
  modelType: ModelProviderType;
  modelId: string;
  simulateError: boolean;
  errorCode: number;
  errorMessage: string;
  responseSize: 'small' | 'medium' | 'large';
  customData: string; // JSON string para datos personalizados
}

// Configuración de la API de Tester
const TesterApi: BaseApiConfig = {
  id: 'tester',
  name: 'API Tester',
  description: 'API para probar diferentes escenarios de respuesta',
  defaultEndpoint: '/api/site/tester',

  // Obtener el estado inicial
  getInitialState: (props: TesterApiProps): TesterApiState => {
    return {
      testType: props.defaultTestType || 'success',
      delay: props.defaultDelay || 0,
      modelType: (props.defaultModelType as ModelProviderType) || 'anthropic',
      modelId: props.defaultModel || 'claude-3-5-sonnet-20240620',
      simulateError: false,
      errorCode: 500,
      errorMessage: 'Error simulado para pruebas',
      responseSize: props.defaultResponseSize || 'medium',
      customData: '{}'
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: TesterApiState): Record<string, any> => {
    const body: Record<string, any> = {
      testType: state.testType,
      delay: state.delay,
      simulateError: state.simulateError,
      responseSize: state.responseSize
    };
    
    if (state.modelType) body.aiProvider = state.modelType;
    if (state.modelId) body.aiModel = state.modelId;
    
    // Agregar campos específicos para errores si se solicita
    if (state.simulateError) {
      body.errorCode = state.errorCode;
      if (state.errorMessage) body.errorMessage = state.errorMessage;
    }
    
    // Intentar parsear los datos personalizados
    try {
      if (state.customData && state.customData !== '{}') {
        body.customData = JSON.parse(state.customData);
      }
    } catch (error) {
      console.error('Error parsing custom data:', error);
      // Si hay un error, no incluir los datos personalizados
    }
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: TesterApiState;
    setState: React.Dispatch<React.SetStateAction<TesterApiState>>;
    showModelOptions?: boolean;
  }) => {
    const { state, setState, showModelOptions } = props;
    
    const handleChange = (field: keyof TesterApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
        <FormField
          label="Tipo de Prueba"
          id="testType"
          type="select"
          value={state.testType}
          onChange={(value) => handleChange('testType', value)}
          options={[
            { value: 'success', label: 'Éxito' },
            { value: 'error', label: 'Error' },
            { value: 'partial', label: 'Parcial' },
            { value: 'timeout', label: 'Timeout' }
          ]}
        />
        
        <FormField
          label="Retraso (ms)"
          id="delay"
          type="number"
          value={state.delay}
          onChange={(value) => handleChange('delay', value)}
          placeholder="0"
          min={0}
          max={10000}
        />
        
        <FormField
          label="Tamaño de Respuesta"
          id="responseSize"
          type="select"
          value={state.responseSize}
          onChange={(value) => handleChange('responseSize', value)}
          options={[
            { value: 'small', label: 'Pequeño' },
            { value: 'medium', label: 'Mediano' },
            { value: 'large', label: 'Grande' }
          ]}
        />
        
        <div style={{ marginBottom: '1rem' }}>
          <label>Opciones de Error</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <FormField
              label="Simular Error"
              id="simulateError"
              type="checkbox"
              value={state.simulateError}
              onChange={(value) => handleChange('simulateError', value)}
            />
            
            {state.simulateError && (
              <>
                <FormField
                  label="Código de Error"
                  id="errorCode"
                  type="number"
                  value={state.errorCode}
                  onChange={(value) => handleChange('errorCode', value)}
                  placeholder="500"
                  min={400}
                  max={599}
                />
                
                <FormField
                  label="Mensaje de Error"
                  id="errorMessage"
                  type="text"
                  value={state.errorMessage}
                  onChange={(value) => handleChange('errorMessage', value)}
                  placeholder="Error simulado para pruebas"
                />
              </>
            )}
          </div>
        </div>
        
        <FormField
          label="Datos Personalizados (JSON)"
          id="customData"
          type="textarea"
          value={state.customData}
          onChange={(value) => handleChange('customData', value)}
          placeholder="{}"
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

export default TesterApi; 