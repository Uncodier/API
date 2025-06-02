'use client';

import React, { useState, useEffect } from 'react';
import apiRegistry from './apis/index';
import { codeExamples, BaseApiConfig } from './types';
import { generateUUID } from './utilsComponents';
import { formatJsonWithSyntax, highlightCode } from './utilsComponents';
import { FormField } from './components/FormComponents';
import ApiResults from './components/ApiResults';
import ApiImplementation from './components/ApiImplementation';
import styles from '../ApiTester.module.css';

// Definimos la interfaz de props
export interface UnifiedApiTesterProps {
  apiType?: 'general' | 'ai' | 'site' | 'segments' | 'tester' | 'icp' | 'content';
  apiId?: string;  // For direct API selection by ID
  title?: string;
  description?: string;
  defaultEndpoint?: string;
  defaultMessage?: string;
  defaultConversationId?: string;
  defaultContext?: string;
  defaultQuery?: string;
  defaultModel?: string;
  defaultModelType?: string;
  showModelOptions?: boolean;
  defaultAnalysisType?: 'complete' | 'structure';
  defaultMethod?: 'GET' | 'POST';
  defaultTimeout?: string;
  defaultDepth?: string;
  defaultSegmentCount?: number;
  defaultUrl?: string;
  defaultTestType?: 'success' | 'error' | 'partial' | 'timeout';
  defaultDelay?: number;
  defaultResponseSize?: 'small' | 'medium' | 'large';
  defaultSegmentId?: string;
  defaultMode?: 'analyze' | 'create' | 'update';
  defaultLimit?: number;
  showSiteUrlField?: boolean;
  showUrlField?: boolean;
  showJsonOption?: boolean;
  showScreenshotOption?: boolean;
  showAnalysisTypeField?: boolean;
  additionalFields?: any[];
}

/**
 * Componente para probar APIs
 */
const UnifiedApiTester = (props: UnifiedApiTesterProps) => {
  const {
    apiType = 'general',
    apiId,
    title = 'API Tester',
    description = 'Este componente te permite probar diferentes endpoints de API.',
    defaultEndpoint = '',
    defaultMessage = '',
    defaultConversationId = '',
    defaultContext = '',
    defaultQuery = '',
    defaultModel = 'claude-3-5-sonnet-20240620',
    defaultModelType = 'anthropic',
    showModelOptions = true,
    defaultAnalysisType = 'complete',
    defaultMethod = 'POST',
    defaultTimeout = '30000',
    defaultDepth = '2',
    defaultSegmentCount = 10,
    defaultUrl = '',
    defaultTestType = 'success',
    defaultDelay = 0,
    defaultResponseSize = 'medium',
    defaultSegmentId = '',
    defaultMode = 'analyze',
    defaultLimit = 10,
    showSiteUrlField = true,
    showUrlField = true,
    showJsonOption = apiType !== 'segments',
    showScreenshotOption = true,
    showAnalysisTypeField = true,
    additionalFields = []
  } = props;

  // Estado para almacenar la configuración actual de la API
  const [apiConfig, setApiConfig] = useState<any>(null);
  
  // Estado para almacenar el estado del formulario
  const [formState, setFormState] = useState<any>({});
  
  // Estado para almacenar la respuesta de la API
  const [apiResponse, setApiResponse] = useState<any>(null);
  
  // Estado para almacenar el estado de carga
  const [loading, setLoading] = useState<boolean>(false);
  
  // Estado para almacenar errores
  const [error, setError] = useState<string | null>(null);

  // Estado para controlar la pestaña activa
  const [activeTab, setActiveTab] = useState<'request' | 'implementation' | 'result'>('request');

  const initialEndpoint = React.useMemo(() => {
    return defaultEndpoint || (apiConfig?.defaultEndpoint ?? '/api');
  }, [defaultEndpoint, apiConfig]);

  // Asegurarnos de que el endpoint siempre esté correcto en el formState
  React.useEffect(() => {
    if (apiConfig && formState && (formState.endpoint !== initialEndpoint || formState.method !== (defaultMethod || 'POST'))) {
      setFormState((prevState: Record<string, any>) => ({
        ...prevState,
        endpoint: initialEndpoint,
        method: formState.method || defaultMethod || 'POST'
      }));
    }
  }, [initialEndpoint, defaultMethod, apiConfig]);

  // Efecto para cargar la configuración de la API seleccionada
  useEffect(() => {
    // First try to load API by ID if provided, otherwise fall back to apiType
    const config = apiId ? apiRegistry.get(apiId) : apiRegistry.get(apiType);
    
    if (config) {
      setApiConfig(config);
      
      try {
        // Inicializar el estado del formulario con los valores por defecto
        const initialState = config.getInitialState({
          defaultUrl,
          defaultMessage,
          defaultConversationId,
          defaultContext,
          defaultQuery,
          defaultModel,
          defaultModelType,
          showModelOptions,
          defaultAnalysisType,
          defaultMethod,
          defaultTimeout,
          defaultDepth,
          defaultSegmentCount,
          showSiteUrlField,
          showUrlField,
          showJsonOption,
          showScreenshotOption,
          showAnalysisTypeField,
          additionalFields
        });
        
        // No modificamos el objeto initialState directamente para evitar bucles de renderizado
        setFormState({ 
          ...initialState, 
          endpoint: initialEndpoint,
          method: defaultMethod || initialState.method || 'POST'
        });
        
        // Limpiar cualquier error previo
        setError(null);
      } catch (error) {
        console.error(`Error initializing API form state for ${apiId || apiType}:`, error);
        setError('Error al inicializar el formulario. Consulta la consola para más detalles.');
      }
    } else {
      console.warn(`API not found for ${apiId || apiType}`);
      setError(`No se encontró la configuración para la API: "${apiId || apiType}". Verifica que el ID o tipo de API sea válido.`);
    }
    // Incluimos solo las dependencias mínimas necesarias
  }, [apiId, apiType]);

  // Función para manejar cambios en el formulario
  const handleFormChange = React.useCallback((newState: any) => {
    setFormState((prevState: Record<string, any>) => {
      const updatedState = { ...prevState, ...newState };
      
      // Manejo especial para la API de sesiones de visitantes
      if (apiId === 'visitor_session' && 'method' in newState) {
        const newMethod = newState.method;
        // Si cambiamos a GET o PUT y no hay un session_id, generamos uno
        if ((newMethod === 'GET' || newMethod === 'PUT') && !prevState.session_id) {
          updatedState.session_id = crypto.randomUUID();
        }
      }
      
      return updatedState;
    });
  }, [apiId]);

  // Función para manejar cambios en los campos de la API
  const handleApiFieldChange = React.useCallback((updatedFields: Record<string, any>) => {
    // Check if updatedFields is a function (for APIs that use prev => ({ ...prev, ... })
    if (typeof updatedFields === 'function') {
      setFormState((prevState: Record<string, any>) => updatedFields(prevState));
    } else {
      // Handle case where updatedFields is a partial object (for APIs that use { field: value })
      setFormState((prevState: Record<string, any>) => ({ ...prevState, ...updatedFields }));
    }
  }, []);

  // Función para enviar la solicitud a la API
  const handleSubmit = React.useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    
    if (!apiConfig) {
      setError('No se ha seleccionado una API válida.');
      return;
    }

    setLoading(true);
    setError(null);
    setApiResponse(null);

    try {
      // Construir el cuerpo de la solicitud según la configuración de la API
      const requestBody = apiConfig.buildRequestBody(formState);
      
      // Construir los encabezados según la configuración de la API
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      
      // Si la API tiene una función para construir cabeceras, usarla
      if (apiConfig.buildRequestHeaders) {
        const customHeaders = apiConfig.buildRequestHeaders(formState);
        Object.assign(headers, customHeaders);
      }
      
      // Determine the method and prepare the endpoint
      const method = formState.method || defaultMethod || 'POST';
      let endpoint = formState.endpoint || defaultEndpoint || apiConfig.defaultEndpoint;

      // Use buildRequestUrl if it exists and it's a GET request
      if (method === 'GET' && apiConfig.buildRequestUrl) {
        endpoint = apiConfig.buildRequestUrl(formState, endpoint);
        
        // Realizar la solicitud GET a la API
        const response = await fetch(endpoint, {
          method,
          headers
        });
        
        // Procesar la respuesta
        const data = await response.json();
        
        if (!response.ok) {
          throw new Error(data.message || 'Error en la solicitud');
        }
        
        // Actualizar el estado con la respuesta
        setApiResponse(data);
        setActiveTab('result');
      } else {
        // Realizar la solicitud POST/PUT/DELETE a la API con body
        const response = await fetch(endpoint, {
          method,
          headers,
          body: JSON.stringify(requestBody)
        });
        
        // Procesar la respuesta
        const data = await response.json();
        
        if (!response.ok) {
          // En lugar de lanzar un error, actualizamos el estado con el error
          setError(data.error?.message || data.message || 'Error en la solicitud');
          setApiResponse(data);
          setActiveTab('result');
          return;
        }
        
        // Actualizar el estado con la respuesta
        setApiResponse(data);
        setError(null);
        setActiveTab('result');
      }
    } catch (error: any) {
      console.error('Error al enviar la solicitud:', error);
      setError(error.message || 'Error desconocido al procesar la solicitud.');
    } finally {
      setLoading(false);
    }
  }, [apiConfig, formState, defaultEndpoint, defaultMethod]);

  // Si no hay configuración de API, mostrar un mensaje
  if (!apiConfig) {
    return (
      <div className={styles.card}>
        <h2>{title}</h2>
        <p>{description}</p>
        <div style={{ 
          padding: '10px', 
          backgroundColor: '#ffebee', 
          color: '#c62828', 
          borderRadius: '4px',
          marginTop: '10px'
        }}>
          <p><strong>Error:</strong> {error || `No se pudo cargar la configuración para la API: "${apiId || apiType}"`}</p>
          <p>Asegúrate de que el ID o tipo de API sea válido y que esté registrado correctamente.</p>
          <p>APIs disponibles: {apiRegistry.getAll().map((api: BaseApiConfig) => `"${api.id}"`).join(', ')}</p>
        </div>
      </div>
    );
  }

  // Renderizar el componente de pestañas
  const renderTabContent = () => {
    if (!apiConfig) return null;
    
    // Construir el cuerpo de la solicitud para mostrar en la implementación
    const requestBody = apiConfig.buildRequestBody(formState);
    
    // Construir las cabeceras para mostrar en la implementación
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // Si la API tiene una función para construir cabeceras, usarla
    if (apiConfig.buildRequestHeaders) {
      const customHeaders = apiConfig.buildRequestHeaders(formState);
      Object.assign(headers, customHeaders);
    }
    
    switch (activeTab) {
      case 'request':
        return (
          <div className={styles.innerCard}>
            <h3 className={styles.implementationTitle}>Solicitud</h3>
            <form onSubmit={handleSubmit} className={styles.formInCard}>
              {/* Campos comunes */}
              <FormField
                label="Endpoint"
                id="endpoint"
                type="text"
                value={formState.endpoint || defaultEndpoint || apiConfig.defaultEndpoint}
                onChange={(value: string) => {/* No hacemos nada, es de solo lectura */}}
                placeholder="/api/endpoint"
                required
                readOnly={true}
              />
              
              <FormField
                label="Method"
                id="method"
                type="select"
                value={formState.method || defaultMethod || 'POST'}
                onChange={(value: string) => handleFormChange({ method: value })}
                options={[
                  { value: 'GET', label: 'GET' },
                  { value: 'POST', label: 'POST' },
                  { value: 'PUT', label: 'PUT' },
                  { value: 'DELETE', label: 'DELETE' },
                ]}
              />
              
              {/* Renderizar los campos específicos de la API */}
              {apiConfig.renderFields({
                state: formState,
                setState: handleApiFieldChange,
                showJsonOption,
                showScreenshotOption,
                showModelOptions,
                showAnalysisTypeField,
                showSiteUrlField,
                showUrlField,
                additionalFields
              })}
              
              <div className={styles.formActions}>
                <button 
                  type="submit" 
                  className={styles.submitButton}
                  disabled={loading}
                >
                  {loading ? 'Enviando...' : 'Enviar solicitud'}
                </button>
              </div>
            </form>
          </div>
        );
      
      case 'implementation':
        // Get the method and endpoint
        const method = formState.method || 'POST';
        let implementationEndpoint = formState.endpoint || defaultEndpoint || apiConfig.defaultEndpoint;
        
        // Use buildRequestUrl for GET requests if available
        if (method === 'GET' && apiConfig.buildRequestUrl) {
          implementationEndpoint = apiConfig.buildRequestUrl(formState, implementationEndpoint);
        }
        
        return (
          <ApiImplementation 
            requestBody={requestBody} 
            method={method} 
            endpoint={implementationEndpoint}
            headers={headers}
          />
        );
      
      case 'result':
        return (
          <ApiResults 
            apiResponse={apiResponse} 
            error={error} 
            loading={loading}
          />
        );
      
      default:
        return null;
    }
  };

  return (
    <div className={styles.apiTester}>
      <h2>{title}</h2>
      <p>{description}</p>
      
      <div className={styles.tabs}>
        <button 
          className={`${styles.tabButton} ${activeTab === 'request' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('request')}
        >
          Solicitud
        </button>
        <button 
          className={`${styles.tabButton} ${activeTab === 'implementation' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('implementation')}
        >
          Implementación
        </button>
        <button 
          className={`${styles.tabButton} ${activeTab === 'result' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('result')}
        >
          Resultado
        </button>
      </div>
      
      <div className={styles.tabContent}>
        {renderTabContent()}
      </div>
    </div>
  );
};

// Exportamos el componente como default y también como named export
export default UnifiedApiTester;
export { UnifiedApiTester }; 