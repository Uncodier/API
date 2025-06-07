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
  const [activeTab, setActiveTab] = useState<'request' | 'implementation' | 'result' | 'authorization'>('request');

  // Estado para el modo de editor libre
  const [freeEditorMode, setFreeEditorMode] = useState<boolean>(false);
  
  // Estado para el editor libre
  const [freeEditorState, setFreeEditorState] = useState({
    endpoint: defaultEndpoint || '/api',
    method: defaultMethod || 'POST',
    body: '{\n  "message": "Hello World"\n}'
  });

  // Estado para la autorización
  const [authConfig, setAuthConfig] = useState({
    apiKey: '',
    headerName: 'Authorization'
  });

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
      setFreeEditorMode(false);
      
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
      console.warn(`API not found for ${apiId || apiType}, enabling free editor mode`);
      setFreeEditorMode(true);
      setApiConfig(null);
      setError(null);
      
      // Inicializar el editor libre con valores por defecto
      setFreeEditorState({
        endpoint: defaultEndpoint || '/api',
        method: defaultMethod || 'POST',
        body: defaultMessage ? `{\n  "message": "${defaultMessage}"\n}` : '{\n  "message": "Hello World"\n}'
      });
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

  // Función para manejar cambios en el editor libre
  const handleFreeEditorChange = React.useCallback((field: string, value: string) => {
    setFreeEditorState(prev => ({ ...prev, [field]: value }));
  }, []);

  // Función para validar JSON
  const validateJSON = (jsonString: string): boolean => {
    try {
      JSON.parse(jsonString);
      return true;
    } catch {
      return false;
    }
  };

  // Función para enviar la solicitud a la API
  const handleSubmit = React.useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    
    setLoading(true);
    setError(null);
    setApiResponse(null);

    try {
      let requestBody: any = {};
      let headers: Record<string, string> = {};
      let method: string;
      let endpoint: string;

      if (freeEditorMode) {
        // Modo editor libre
        method = freeEditorState.method;
        endpoint = freeEditorState.endpoint;
        
        // Headers básicos para modo libre
        headers = {
          'Content-Type': 'application/json'
        };
        
        // Parsear body para métodos que lo requieren
        if (method !== 'GET' && method !== 'DELETE') {
          try {
            requestBody = JSON.parse(freeEditorState.body);
          } catch (error) {
            throw new Error('Invalid body: must be valid JSON');
          }
        }
      } else {
        // Modo configuración de API
        if (!apiConfig) {
          setError('No valid API has been selected.');
          return;
        }

        // Construir el cuerpo de la solicitud según la configuración de la API
        requestBody = apiConfig.buildRequestBody(formState);
        
        // Construir los encabezados según la configuración de la API
        headers = {
          'Content-Type': 'application/json',
        };
        
        // Si la API tiene una función para construir cabeceras, usarla
        if (apiConfig.buildRequestHeaders) {
          const customHeaders = apiConfig.buildRequestHeaders(formState);
          Object.assign(headers, customHeaders);
        }
        
        // Determine the method and prepare the endpoint
        method = formState.method || defaultMethod || 'POST';
        endpoint = formState.endpoint || defaultEndpoint || apiConfig.defaultEndpoint;

        // Use buildRequestUrl if it exists and it's a GET request
        if (method === 'GET' && apiConfig.buildRequestUrl) {
          endpoint = apiConfig.buildRequestUrl(formState, endpoint);
        }
      }

      // Agregar autorización si está configurada
      if (authConfig.apiKey) {
        headers[authConfig.headerName] = authConfig.apiKey;
      }

      // Configurar la solicitud
      const requestConfig: RequestInit = {
        method,
        headers
      };

      // Agregar body solo si no es GET o DELETE
      if (method !== 'GET' && method !== 'DELETE') {
        requestConfig.body = JSON.stringify(requestBody);
      }

      // Realizar la solicitud a la API
      const response = await fetch(endpoint, requestConfig);
      
      // Procesar la respuesta
      const data = await response.json();
      
      if (!response.ok) {
        // En lugar de lanzar un error, actualizamos el estado con el error
        setError(data.error?.message || data.message || 'Request error');
        setApiResponse(data);
        setActiveTab('result');
        return;
      }
      
      // Actualizar el estado con la respuesta
      setApiResponse(data);
      setError(null);
      setActiveTab('result');
    } catch (error: any) {
      console.error('Error al enviar la solicitud:', error);
      setError(error.message || 'Unknown error processing the request.');
    } finally {
      setLoading(false);
    }
  }, [apiConfig, formState, defaultEndpoint, defaultMethod, freeEditorMode, freeEditorState, authConfig]);

  // Renderizar el formulario del editor libre
  const renderFreeEditor = () => (
    <div className={styles.innerCard}>
      <h3 className={styles.implementationTitle}>Free API Editor</h3>
      <p style={{ marginBottom: '20px', color: '#666' }}>
        No configuration found for "{apiId || apiType}". Use this free editor to test your API.
      </p>
      
      <form onSubmit={handleSubmit} className={styles.formInCard}>
        <FormField
          label="Endpoint"
          id="endpoint"
          type="text"
          value={freeEditorState.endpoint}
          onChange={(value: string) => handleFreeEditorChange('endpoint', value)}
          placeholder="/api/endpoint"
          required
        />
        
        <FormField
          label="Method"
          id="method"
          type="select"
          value={freeEditorState.method}
          onChange={(value: string) => handleFreeEditorChange('method', value)}
          options={[
            { value: 'GET', label: 'GET' },
            { value: 'POST', label: 'POST' },
            { value: 'PUT', label: 'PUT' },
            { value: 'DELETE', label: 'DELETE' },
            { value: 'PATCH', label: 'PATCH' }
          ]}
        />
        
        {!['GET', 'DELETE'].includes(freeEditorState.method) && (
          <div className={styles.formGroup}>
            <label htmlFor="body" className={styles.label}>
              Body (JSON)
            </label>
            <textarea
              id="body"
              value={freeEditorState.body}
              onChange={(e) => handleFreeEditorChange('body', e.target.value)}
              className={`${styles.textarea} ${!validateJSON(freeEditorState.body) ? styles.textareaError : ''}`}
              rows={12}
              placeholder='{"message": "Hello World"}'
              style={{
                fontFamily: 'monospace',
                width: '100%',
                minHeight: '300px'
              }}
            />
            {!validateJSON(freeEditorState.body) && (
              <small style={{ color: 'red' }}>Invalid JSON in body</small>
            )}
          </div>
        )}
        
        <div className={styles.formActions}>
                     <button 
             type="submit" 
             className={styles.submitButton}
             disabled={loading || (!['GET', 'DELETE'].includes(freeEditorState.method) && !validateJSON(freeEditorState.body))}
           >
             {loading ? 'Sending...' : 'Send Request'}
           </button>
        </div>
      </form>
    </div>
  );

  // Renderizar la pestaña de autorización
  const renderAuthorizationTab = () => (
    <div className={styles.innerCard}>
      <h3 className={styles.implementationTitle}>Authorization Configuration</h3>
      <p style={{ marginBottom: '20px', color: '#666' }}>
        Configure authorization for your API requests.
      </p>
      
      <div className={styles.formInCard}>
        <FormField
          label="API Key"
          id="apiKey"
          type="text"
          value={authConfig.apiKey}
          onChange={(value: string) => setAuthConfig(prev => ({ ...prev, apiKey: value }))}
          placeholder="Enter your API key"
        />
        
        <FormField
          label="Header Name"
          id="headerName"
          type="text"
          value={authConfig.headerName}
          onChange={(value: string) => setAuthConfig(prev => ({ ...prev, headerName: value }))}
          placeholder="Authorization"
        />
        
        {authConfig.apiKey && (
          <div className={styles.previewSection}>
            <h4>Header preview:</h4>
            <code style={{ 
              backgroundColor: '#f8f9fa', 
              padding: '8px 12px', 
              borderRadius: '4px',
              display: 'block',
              marginTop: '8px'
            }}>
              {authConfig.headerName}: {authConfig.apiKey}
            </code>
          </div>
        )}
      </div>
    </div>
  );

  // Renderizar el componente de pestañas
  const renderTabContent = () => {
    switch (activeTab) {
      case 'request':
        if (freeEditorMode) {
          return renderFreeEditor();
        }
        
        if (!apiConfig) return null;
        
        return (
          <div className={styles.innerCard}>
            <h3 className={styles.implementationTitle}>Request</h3>
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
                  {loading ? 'Sending...' : 'Send Request'}
                </button>
              </div>
            </form>
          </div>
        );
      
      case 'authorization':
        return renderAuthorizationTab();
      
      case 'implementation':
        if (freeEditorMode) {
          // Mostrar implementación para el editor libre
          let implementationHeaders: Record<string, string> = {};
          let implementationBody: any = {};
          
          // Headers básicos para implementación en modo libre
          implementationHeaders = { 'Content-Type': 'application/json' };
          
          if (!['GET', 'DELETE'].includes(freeEditorState.method)) {
            try {
              implementationBody = JSON.parse(freeEditorState.body);
            } catch (error) {
              implementationBody = {};
            }
          }

          // Agregar autorización a los headers para la implementación
          if (authConfig.apiKey) {
            implementationHeaders[authConfig.headerName] = authConfig.apiKey;
          }
          
          return (
            <ApiImplementation 
              requestBody={implementationBody} 
              method={freeEditorState.method} 
              endpoint={freeEditorState.endpoint}
              headers={implementationHeaders}
            />
          );
        }
        
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

        // Agregar autorización a los headers para la implementación
        if (authConfig.apiKey) {
          headers[authConfig.headerName] = authConfig.apiKey;
        }
        
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
          className={`${styles.mainTabButton} ${activeTab === 'request' ? styles.mainActiveTab : ''}`}
          onClick={() => setActiveTab('request')}
        >
          {freeEditorMode ? 'Free Editor' : 'Request'}
        </button>
        <button 
          className={`${styles.mainTabButton} ${activeTab === 'authorization' ? styles.mainActiveTab : ''}`}
          onClick={() => setActiveTab('authorization')}
        >
          Authorization
        </button>
        <button 
          className={`${styles.mainTabButton} ${activeTab === 'implementation' ? styles.mainActiveTab : ''}`}
          onClick={() => setActiveTab('implementation')}
        >
          Implementation
        </button>
        <button 
          className={`${styles.mainTabButton} ${activeTab === 'result' ? styles.mainActiveTab : ''}`}
          onClick={() => setActiveTab('result')}
        >
          Result
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