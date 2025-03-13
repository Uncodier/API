'use client';

import React, { useState, useEffect } from 'react';
import apiRegistry from './apis';
import { codeExamples } from './types';
import { formatJsonWithSyntax, highlightCode } from './utils';
import ApiResults from './components/ApiResults';
import ApiImplementation from './components/ApiImplementation';
import styles from '../ApiTester.module.css';

// Definimos la interfaz de props
export interface UnifiedApiTesterProps {
  apiType?: 'general' | 'ai' | 'site' | 'segments' | 'tester' | 'icp' | 'content';
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
  additionalFields?: any[];
}

/**
 * Componente para probar APIs
 */
const UnifiedApiTester = (props: UnifiedApiTesterProps) => {
  const {
    apiType = 'general',
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

  // Efecto para cargar la configuración de la API seleccionada
  useEffect(() => {
    const config = apiRegistry.get(apiType);
    
    if (config) {
      setApiConfig(config);
      
      try {
        // Inicializar el estado del formulario
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
          additionalFields
        });
        
        setFormState(initialState);
      } catch (error) {
        console.error('Error initializing form state:', error);
        setError('Error al inicializar el formulario. Consulta la consola para más detalles.');
      }
    } else {
      console.error('API type not found:', apiType);
    }
  }, [apiType]);

  // Función para manejar cambios en el formulario
  const handleFormChange = (newState: any) => {
    setFormState(newState);
  };

  // Función para enviar la solicitud a la API
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!apiConfig) return;
    
    setLoading(true);
    setError(null);
    
    try {
      // Construir el cuerpo de la solicitud
      const requestBody = apiConfig.buildRequestBody(formState);
      
      // Realizar la solicitud
      const response = await fetch(formState.endpoint || defaultEndpoint || apiConfig.defaultEndpoint, {
        method: formState.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      
      if (!response.ok) {
        throw new Error(`Error HTTP: ${response.status}`);
      }
      
      const data = await response.json();
      setApiResponse(data);
      
      // Cambiar automáticamente a la pestaña de resultados después de una solicitud exitosa
      setActiveTab('result');
    } catch (err: any) {
      setError(err.message || 'Error al realizar la solicitud');
    } finally {
      setLoading(false);
    }
  };

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
          <p><strong>Error:</strong> No se pudo cargar la configuración para el tipo de API: "{apiType}"</p>
          <p>Asegúrate de que el tipo de API sea válido y que esté registrado correctamente.</p>
          <p>Tipos de API disponibles: {apiRegistry.getAll().map(api => `"${api.id}"`).join(', ')}</p>
        </div>
      </div>
    );
  }

  // Renderizar el componente de pestañas
  const renderTabContent = () => {
    switch (activeTab) {
      case 'request':
        return (
          <div className={styles.innerCard}>
            <h3>Configuración de la API</h3>
            <form onSubmit={handleSubmit}>
              {apiConfig.renderFields({ 
                state: formState, 
                setState: handleFormChange,
                showModelOptions,
                showSiteUrlField,
                showUrlField,
                showJsonOption,
                showScreenshotOption,
                additionalFields
              })}
              
              <div style={{ marginTop: '20px' }}>
                <button 
                  type="submit" 
                  disabled={loading}
                  className={`${styles.button} ${styles.primary}`}
                >
                  {loading ? (
                    <>
                      <div className={styles.loadingSpinner}></div>
                      <span>Enviando...</span>
                    </>
                  ) : (
                    <span>Enviar solicitud</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        );
      case 'implementation':
        return (
          <ApiImplementation
            requestBody={apiConfig.buildRequestBody(formState)}
            method={formState.method || 'POST'}
            endpoint={formState.endpoint || defaultEndpoint || apiConfig.defaultEndpoint}
          />
        );
      case 'result':
        return (
          <ApiResults
            loading={loading}
            error={error}
            apiResponse={apiResponse}
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