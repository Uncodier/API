'use client';

import React, { useState, useRef, useEffect } from 'react';
import styles from './ApiTester.module.css';

export interface UnifiedApiTesterProps {
  // Common props
  defaultEndpoint?: string;
  title?: string;
  description?: string;
  
  // API type
  apiType?: 'general' | 'ai' | 'site';
  
  // General API props
  defaultMessage?: string;
  defaultConversationId?: string;
  defaultContext?: string;
  
  // AI API props
  defaultQuery?: string;
  defaultModel?: string;
  defaultModelType?: string;
  showModelOptions?: boolean;
  
  // Site API props
  defaultAnalysisType?: 'complete' | 'structure';
  defaultMethod?: 'GET' | 'POST';
  defaultTimeout?: string;
  defaultDepth?: string;
  
  // Common options
  defaultUrl?: string;
  showJsonOption?: boolean;
  showScreenshotOption?: boolean;
  showSiteUrlField?: boolean;
  
  // Additional customization
  additionalFields?: {
    name: string;
    label: string;
    type: 'text' | 'checkbox' | 'select' | 'textarea' | 'number';
    options?: { value: string; label: string }[];
    defaultValue?: string | boolean | number;
    min?: number;
    max?: number;
  }[];
}

// Definir tipo para modelType
type ModelProviderType = 'anthropic' | 'openai' | 'gemini';

// Modelos disponibles por proveedor
const MODEL_OPTIONS: Record<ModelProviderType, Array<{value: string, label: string}>> = {
  anthropic: [
    { value: 'claude-3-5-sonnet-20240620', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
    { value: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet' },
    { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
    { value: 'claude-2.1', label: 'Claude 2.1' },
    { value: 'claude-2.0', label: 'Claude 2.0' },
    { value: 'claude-instant-1.2', label: 'Claude Instant 1.2' }
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-4', label: 'GPT-4' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
  ],
  gemini: [
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    { value: 'gemini-1.0-pro', label: 'Gemini 1.0 Pro' },
    { value: 'gemini-1.0-ultra', label: 'Gemini 1.0 Ultra' }
  ]
};

export function UnifiedApiTester({
  // Common props with defaults
  defaultEndpoint = '/api/conversation',
  title = 'API Tester',
  description = 'Este componente te permite probar diferentes endpoints de API.',
  
  // API type
  apiType = 'general',
  
  // General API props
  defaultMessage = '',
  defaultConversationId = '',
  defaultContext = '',
  
  // AI API props
  defaultQuery = '',
  defaultModel = 'claude-3-5-sonnet-20240620',
  defaultModelType = 'anthropic',
  showModelOptions = true,
  
  // Site API props
  defaultAnalysisType = 'complete',
  defaultMethod = 'POST',
  defaultTimeout = '30000',
  defaultDepth = '2',
  
  // Common options
  defaultUrl = '',
  showJsonOption = true,
  showScreenshotOption = true,
  showSiteUrlField = true,
  
  // Additional customization
  additionalFields = []
}: UnifiedApiTesterProps) {
  // Use client-side only rendering
  const [isClient, setIsClient] = useState(false);
  
  // Use refs to store initial values
  const initialPropsRef = useRef({
    defaultEndpoint,
    apiType,
    defaultMessage,
    defaultConversationId,
    defaultContext,
    defaultQuery,
    defaultModel,
    defaultModelType,
    defaultAnalysisType,
    defaultMethod,
    defaultTimeout,
    defaultDepth,
    defaultUrl,
    showScreenshotOption,
    showSiteUrlField
  });

  // Ref para controlar si ya se inicializaron los campos adicionales
  const additionalFieldsInitialized = useRef(false);
  
  // Common state
  const [apiUrl, setApiUrl] = useState(initialPropsRef.current.defaultEndpoint);
  const [response, setResponse] = useState('La respuesta aparecerá aquí...');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('request');
  const [requestBody, setRequestBody] = useState<Record<string, any>>({});
  const [responseStatus, setResponseStatus] = useState<{code: number, text: string} | null>(null);
  const [requestTime, setRequestTime] = useState<number | null>(null);
  const [siteUrl, setSiteUrl] = useState(initialPropsRef.current.defaultUrl);
  const [includeScreenshot, setIncludeScreenshot] = useState(initialPropsRef.current.showScreenshotOption);
  const [jsonResponse, setJsonResponse] = useState(false);
  
  // General API state
  const [message, setMessage] = useState(initialPropsRef.current.defaultMessage);
  const [conversationId, setConversationId] = useState(initialPropsRef.current.defaultConversationId);
  const [context, setContext] = useState(initialPropsRef.current.defaultContext);
  
  // AI API state
  const [query, setQuery] = useState(initialPropsRef.current.defaultQuery);
  const [modelType, setModelType] = useState<ModelProviderType>(initialPropsRef.current.defaultModelType as ModelProviderType);
  const [modelId, setModelId] = useState(initialPropsRef.current.defaultModel);
  
  // Site API state
  const [method, setMethod] = useState(initialPropsRef.current.defaultMethod);
  const [analysisType, setAnalysisType] = useState(initialPropsRef.current.defaultAnalysisType);
  const [timeout, setTimeout] = useState(initialPropsRef.current.defaultTimeout);
  const [ignoreSSL, setIgnoreSSL] = useState(false);
  const [userAgent, setUserAgent] = useState('');
  const [failOnError, setFailOnError] = useState(false);
  const [safeSelectors, setSafeSelectors] = useState(true);
  const [depth, setDepth] = useState(initialPropsRef.current.defaultDepth);
  const [htmlContent, setHtmlContent] = useState('');
  
  // Additional fields state
  const [additionalFieldValues, setAdditionalFieldValues] = useState<Record<string, any>>({});

  // Add state for copy button
  const [isCopied, setIsCopied] = useState(false);
  
  // Function to copy response to clipboard
  const copyToClipboard = () => {
    navigator.clipboard.writeText(response).then(() => {
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 2000);
    });
  };

  // Initialize default values for additional fields
  useEffect(() => {
    // Solo inicializar una vez
    if (!additionalFieldsInitialized.current && additionalFields.length > 0) {
      const initialValues: Record<string, any> = {};
      additionalFields.forEach(field => {
        initialValues[field.name] = field.defaultValue;
      });
      setAdditionalFieldValues(initialValues);
      additionalFieldsInitialized.current = true;
    }
  }, [additionalFields]);

  // Update API URL when analysis type changes (for site API)
  // Use a ref to track if this is the first render
  const isFirstRender = useRef(true);
  const previousAnalysisType = useRef(analysisType);
  const previousApiType = useRef(apiType);

  useEffect(() => {
    // Skip the first render to avoid potential loops
    if (isFirstRender.current) {
      isFirstRender.current = false;
      
      // Set initial API URL based on apiType and analysisType
      if (apiType === 'site') {
        if (analysisType === 'structure') {
          setApiUrl('/api/site/analyze/structure');
        } else {
          setApiUrl('/api/site/analyze');
        }
      } else if (apiType === 'ai') {
        setApiUrl('/api/ai');
      } else if (apiType === 'general') {
        setApiUrl('/api/conversation');
      }
      
      // Inicializar los valores previos
      previousAnalysisType.current = analysisType;
      previousApiType.current = apiType;
      return;
    }
    
    // Verificar si cambió el tipo de análisis o el tipo de API
    const analysisTypeChanged = previousAnalysisType.current !== analysisType;
    const apiTypeChanged = previousApiType.current !== apiType;
    
    if (apiTypeChanged) {
      // Si cambió el tipo de API, actualizar la URL
      if (apiType === 'site') {
        setApiUrl(analysisType === 'structure' ? '/api/site/analyze/structure' : '/api/site/analyze');
      } else if (apiType === 'ai') {
        setApiUrl('/api/ai');
      } else if (apiType === 'general') {
        setApiUrl('/api/conversation');
      }
      previousApiType.current = apiType;
    } else if (apiType === 'site' && analysisTypeChanged) {
      // Si solo cambió el tipo de análisis y estamos en API de sitio
      setApiUrl(analysisType === 'structure' ? '/api/site/analyze/structure' : '/api/site/analyze');
    }
    
    // Actualizar el valor previo del tipo de análisis
    if (analysisTypeChanged) {
      previousAnalysisType.current = analysisType;
    }
  }, [analysisType, apiType]); // Mantener constante el array de dependencias

  // Update request body in real time
  useEffect(() => {
    // Usamos un timeout para evitar múltiples actualizaciones rápidas
    const timeoutId = window.setTimeout(() => {
      let body: Record<string, any> = {};
      
      // Build request body based on API type
      if (apiType === 'general') {
        // General API (conversation)
        body = { 
          messages: [
            { role: 'user', content: message }
          ],
          modelType: modelType,
          modelId: modelId
        };
        
        if (siteUrl) body.url = siteUrl;
        if (conversationId) body.conversationId = conversationId;
        if (context) {
          try {
            body.context = JSON.parse(context);
          } catch (e) {
            body.context = context;
          }
        }
        if (jsonResponse) body.responseFormat = 'json';
        if (includeScreenshot) body.includeScreenshot = includeScreenshot;
      }
      else if (apiType === 'ai') {
        // AI API - Format messages array properly
        body = { 
          messages: [
            { role: 'user', content: message || query }
          ],
        };
        
        if (showModelOptions) {
          body.modelType = modelType;
          body.modelId = modelId;
        }
        if (jsonResponse) body.responseFormat = 'json';
      } 
      else if (apiType === 'site') {
        // Site API
        if (method === 'POST') {
          body = { url: siteUrl };
          
          if (analysisType === 'complete') {
            if (timeout) body.timeout = parseInt(timeout);
            if (userAgent) body.userAgent = userAgent;
            if (ignoreSSL) body.ignoreSSL = ignoreSSL;
            if (failOnError) body.failOnError = failOnError;
            if (!safeSelectors) body.safeSelectors = safeSelectors;
            if (includeScreenshot) body.includeScreenshot = includeScreenshot;
          } 
          else if (analysisType === 'structure') {
            if (depth) body.depth = parseInt(depth);
            if (includeScreenshot) body.includeScreenshot = includeScreenshot;
            if (htmlContent) body.html = htmlContent;
          }
        }
      }
      
      // Add additional fields to request body
      if (additionalFields.length > 0 && Object.keys(additionalFieldValues).length > 0) {
        additionalFields.forEach(field => {
          if (additionalFieldValues[field.name] !== undefined) {
            // Convert string values to numbers for number fields
            if (field.type === 'number') {
              body[field.name] = Number(additionalFieldValues[field.name]);
            } else {
              body[field.name] = additionalFieldValues[field.name];
            }
          }
        });
      }
      
      setRequestBody(body);
    }, 100); // Pequeño retraso para evitar múltiples actualizaciones

    // Limpieza del timeout
    return () => window.clearTimeout(timeoutId);
  }, [
    apiType, message, conversationId, context, query, siteUrl, modelType, modelId, includeScreenshot, 
    jsonResponse, method, analysisType, timeout, userAgent, ignoreSSL, 
    failOnError, safeSelectors, depth, htmlContent, additionalFieldValues,
    additionalFields, showModelOptions
  ]);

  const handleAdditionalFieldChange = (name: string, value: any) => {
    setAdditionalFieldValues(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    
    try {
      const startTime = performance.now();
      
      const response = await fetch(apiUrl, {
        method: apiType === 'site' ? method : 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      const endTime = performance.now();
      setRequestTime(endTime - startTime);
      
      setResponseStatus({
        code: response.status,
        text: response.statusText
      });
      
      const data = await response.json();
      
      // Siempre mostrar la respuesta, incluso si hay un error
      setResponse(JSON.stringify(data, null, 2));
      setActiveTab('response'); // Switch to response tab automatically
      
      if (!response.ok) {
        // Construir un mensaje de error más detallado
        let errorMessage = data.error || 'Error en la solicitud';
        
        // Añadir detalles adicionales si están disponibles
        if (data.message) {
          errorMessage += `: ${data.message}`;
        }
        
        // Añadir información sobre errores de validación si están disponibles
        if (data.validationErrors) {
          const validationErrors = Object.entries(data.validationErrors)
            .map(([field, message]) => `${field}: ${message}`)
            .join(', ');
          
          errorMessage += `. Errores de validación: ${validationErrors}`;
        }
        
        throw new Error(errorMessage);
      }
      
      // Save conversation ID if present
      if (data.conversationId) {
        setConversationId(data.conversationId);
      }
    } catch (error: any) {
      setError(`Error: ${error.message}`);
      // No limpiar la respuesta para que el usuario pueda ver los detalles del error
      // setResponse('');
    } finally {
      setIsLoading(false);
    }
  };

  const renderStatusBadge = () => {
    if (!responseStatus) return null;
    
    let badgeClass = '';
    
    if (responseStatus.code >= 200 && responseStatus.code < 300) {
      badgeClass = styles.successBadge;
    } else if (responseStatus.code >= 400 && responseStatus.code < 500) {
      badgeClass = styles.warningBadge;
    } else if (responseStatus.code >= 500) {
      badgeClass = styles.serverErrorBadge;
    } else {
      badgeClass = styles.infoBadge;
    }
    
    return (
      <span className={`${styles.statusBadge} ${badgeClass}`}>
        {responseStatus.code}
      </span>
    );
  };

  // Set isClient to true on mount
  useEffect(() => {
    setIsClient(true);
  }, []);
  
  // If not client-side yet, render a placeholder
  if (!isClient) {
    return (
      <div className={styles.apiTester}>
        <div className={styles.header}>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <div className={styles.loading}>Cargando componente...</div>
      </div>
    );
  }

  // Render form fields based on API type
  const renderFormFields = () => {
    return (
      <>
        {/* Common fields for all API types */}
        <div className={styles.formGroup}>
          <label htmlFor="apiUrl">URL del Endpoint</label>
          <input
            type="text"
            id="apiUrl"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            className={styles.formControl}
            placeholder="/api/endpoint"
            readOnly
            disabled
          />
        </div>
        
        {/* General API fields */}
        {apiType === 'general' && (
          <>
            <div className={styles.formGroup}>
              <label htmlFor="message">Mensaje</label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className={styles.formControl}
                placeholder="Escribe tu mensaje aquí..."
                rows={4}
              />
            </div>
            
            {showModelOptions && (
              <>
                <div className={styles.formGroup}>
                  <label htmlFor="modelType">Proveedor del Modelo</label>
                  <select
                    id="modelType"
                    value={modelType}
                    onChange={(e) => setModelType(e.target.value as ModelProviderType)}
                    className={styles.formControl}
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Google (Gemini)</option>
                  </select>
                </div>
                
                <div className={styles.formGroup}>
                  <label htmlFor="modelId">Modelo</label>
                  <select
                    id="modelId"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className={styles.formControl}
                  >
                    {MODEL_OPTIONS[modelType].map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            
            {showSiteUrlField && (
              <div className={styles.formGroup}>
                <label htmlFor="siteUrl">URL del Sitio (opcional)</label>
                <input
                  type="text"
                  id="siteUrl"
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                  className={styles.formControl}
                  placeholder="https://ejemplo.com"
                />
              </div>
            )}
            
            <div className={styles.formGroup}>
              <label htmlFor="conversationId">ID de Conversación (opcional)</label>
              <input
                type="text"
                id="conversationId"
                value={conversationId}
                onChange={(e) => setConversationId(e.target.value)}
                className={styles.formControl}
                placeholder="conv_123456789"
              />
            </div>
            
            <div className={styles.formGroup}>
              <label htmlFor="context">Contexto (JSON, opcional)</label>
              <textarea
                id="context"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                className={styles.formControl}
                placeholder='{"siteAnalysis": "...", "userPreferences": "..."}'
                rows={4}
              />
            </div>
            
            {(showJsonOption || showScreenshotOption) && (
              <div className={styles.formGroup}>
                <label>Opciones adicionales</label>
                <div className={styles.checkboxGroup}>
                  {showJsonOption && (
                    <div className={styles.checkboxWrapper}>
                      <input
                        type="checkbox"
                        id="jsonResponse"
                        checked={jsonResponse}
                        onChange={(e) => setJsonResponse(e.target.checked)}
                        className={styles.checkbox}
                      />
                      <label htmlFor="jsonResponse" className={styles.checkboxLabel}>
                        <span className={styles.checkboxText}>Respuesta en formato JSON</span>
                      </label>
                    </div>
                  )}
                  
                  {showScreenshotOption && (
                    <div className={styles.checkboxWrapper}>
                      <input
                        type="checkbox"
                        id="includeScreenshot"
                        checked={includeScreenshot}
                        onChange={(e) => setIncludeScreenshot(e.target.checked)}
                        className={styles.checkbox}
                      />
                      <label htmlFor="includeScreenshot" className={styles.checkboxLabel}>
                        <span className={styles.checkboxText}>Incluir captura</span>
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        
        {/* AI API fields */}
        {apiType === 'ai' && (
          <>
            <div className={styles.formGroup}>
              <label htmlFor="query">Consulta</label>
              <textarea
                id="query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className={styles.formControl}
                placeholder="Escribe tu consulta aquí..."
                rows={4}
              />
            </div>
            
            {showModelOptions && (
              <>
                <div className={styles.formGroup}>
                  <label htmlFor="modelType">Proveedor del Modelo</label>
                  <select
                    id="modelType"
                    value={modelType}
                    onChange={(e) => setModelType(e.target.value as ModelProviderType)}
                    className={styles.formControl}
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Google (Gemini)</option>
                  </select>
                </div>
                
                <div className={styles.formGroup}>
                  <label htmlFor="modelId">Modelo</label>
                  <select
                    id="modelId"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className={styles.formControl}
                  >
                    {MODEL_OPTIONS[modelType].map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            
            {showSiteUrlField && (
              <div className={styles.formGroup}>
                <label htmlFor="siteUrl">URL del Sitio (opcional)</label>
                <input
                  type="text"
                  id="siteUrl"
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                  className={styles.formControl}
                  placeholder="https://ejemplo.com"
                />
              </div>
            )}
            
            {(showJsonOption || showScreenshotOption) && (
              <div className={styles.formGroup}>
                <label>Opciones adicionales</label>
                <div className={styles.checkboxGroup}>
                  {showJsonOption && (
                    <div className={styles.checkboxWrapper}>
                      <input
                        type="checkbox"
                        id="jsonResponse"
                        checked={jsonResponse}
                        onChange={(e) => setJsonResponse(e.target.checked)}
                        className={styles.checkbox}
                      />
                      <label htmlFor="jsonResponse" className={styles.checkboxLabel}>
                        <span className={styles.checkboxText}>Respuesta en formato JSON</span>
                      </label>
                    </div>
                  )}
                  
                  {showScreenshotOption && (
                    <div className={styles.checkboxWrapper}>
                      <input
                        type="checkbox"
                        id="includeScreenshot"
                        checked={includeScreenshot}
                        onChange={(e) => setIncludeScreenshot(e.target.checked)}
                        className={styles.checkbox}
                      />
                      <label htmlFor="includeScreenshot" className={styles.checkboxLabel}>
                        <span className={styles.checkboxText}>Incluir captura</span>
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        
        {/* Site API fields */}
        {apiType === 'site' && (
          <>
            <div className={styles.formGroup}>
              <label htmlFor="siteUrl">URL del Sitio</label>
              <input
                type="text"
                id="siteUrl"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                className={styles.formControl}
                placeholder="https://ejemplo.com"
                required
              />
            </div>
            
            <div className={styles.formGroup}>
              <label htmlFor="method">Método</label>
              <select
                id="method"
                value={method}
                onChange={(e) => setMethod(e.target.value as 'GET' | 'POST')}
                className={styles.formControl}
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
            </div>
            
            <div className={styles.formGroup}>
              <label htmlFor="analysisType">Tipo de Análisis</label>
              <select
                id="analysisType"
                value={analysisType}
                onChange={(e) => setAnalysisType(e.target.value as 'complete' | 'structure')}
                className={styles.formControl}
              >
                <option value="complete">Completo</option>
                <option value="structure">Solo Estructura</option>
              </select>
            </div>
            
            <div className={styles.formGroup}>
              <label htmlFor="timeout">Timeout (ms)</label>
              <input
                type="number"
                id="timeout"
                value={timeout}
                onChange={(e) => setTimeout(e.target.value)}
                className={styles.formControl}
                placeholder="30000"
              />
            </div>
            
            <div className={styles.formGroup}>
              <label htmlFor="depth">Profundidad de Análisis</label>
              <input
                type="number"
                id="depth"
                value={depth}
                onChange={(e) => setDepth(e.target.value)}
                className={styles.formControl}
                placeholder="2"
                min="1"
                max="5"
              />
            </div>
            
            <div className={styles.formGroup}>
              <label htmlFor="userAgent">User Agent (opcional)</label>
              <input
                type="text"
                id="userAgent"
                value={userAgent}
                onChange={(e) => setUserAgent(e.target.value)}
                className={styles.formControl}
                placeholder="Mozilla/5.0..."
              />
            </div>
            
            {/* Group checkboxes together for better visual organization */}
            <div className={styles.formGroup}>
              <label>Opciones adicionales</label>
              <div className={styles.checkboxGroup}>
                <div className={styles.checkboxWrapper}>
                  <input
                    type="checkbox"
                    id="includeScreenshot"
                    checked={includeScreenshot}
                    onChange={(e) => setIncludeScreenshot(e.target.checked)}
                    className={styles.checkbox}
                  />
                  <label htmlFor="includeScreenshot" className={styles.checkboxLabel}>
                    <span className={styles.checkboxText}>Incluir captura</span>
                  </label>
                </div>
                
                <div className={styles.checkboxWrapper}>
                  <input
                    type="checkbox"
                    id="ignoreSSL"
                    checked={ignoreSSL}
                    onChange={(e) => setIgnoreSSL(e.target.checked)}
                    className={styles.checkbox}
                  />
                  <label htmlFor="ignoreSSL" className={styles.checkboxLabel}>
                    <span className={styles.checkboxText}>Ignorar errores SSL</span>
                  </label>
                </div>
                
                <div className={styles.checkboxWrapper}>
                  <input
                    type="checkbox"
                    id="failOnError"
                    checked={failOnError}
                    onChange={(e) => setFailOnError(e.target.checked)}
                    className={styles.checkbox}
                  />
                  <label htmlFor="failOnError" className={styles.checkboxLabel}>
                    <span className={styles.checkboxText}>Fallar en error</span>
                  </label>
                </div>
                
                <div className={styles.checkboxWrapper}>
                  <input
                    type="checkbox"
                    id="safeSelectors"
                    checked={safeSelectors}
                    onChange={(e) => setSafeSelectors(e.target.checked)}
                    className={styles.checkbox}
                  />
                  <label htmlFor="safeSelectors" className={styles.checkboxLabel}>
                    <span className={styles.checkboxText}>Selectores seguros</span>
                  </label>
                </div>
                
                {showJsonOption && (
                  <div className={styles.checkboxWrapper}>
                    <input
                      type="checkbox"
                      id="jsonResponse"
                      checked={jsonResponse}
                      onChange={(e) => setJsonResponse(e.target.checked)}
                      className={styles.checkbox}
                    />
                    <label htmlFor="jsonResponse" className={styles.checkboxLabel}>
                      <span className={styles.checkboxText}>Respuesta en formato JSON</span>
                    </label>
                  </div>
                )}
              </div>
            </div>
            
            <div className={styles.formGroup}>
              <label htmlFor="htmlContent">Contenido HTML (opcional)</label>
              <textarea
                id="htmlContent"
                value={htmlContent}
                onChange={(e) => setHtmlContent(e.target.value)}
                className={styles.formControl}
                placeholder="<html>...</html>"
                rows={4}
              />
            </div>
          </>
        )}
        
        {/* Additional fields */}
        {additionalFields.map((field) => (
          <div key={field.name} className={field.type === 'checkbox' ? styles.checkboxWrapper : styles.formGroup}>
            {field.type === 'checkbox' ? (
              <>
                <input
                  type="checkbox"
                  id={field.name}
                  checked={!!additionalFieldValues[field.name]}
                  onChange={(e) => handleAdditionalFieldChange(field.name, e.target.checked)}
                  className={styles.checkbox}
                />
                <label htmlFor={field.name} className={styles.checkboxLabel}>
                  <span className={styles.checkboxText}>{field.label}</span>
                </label>
              </>
            ) : field.type === 'select' ? (
              <>
                <label htmlFor={field.name}>{field.label}</label>
                <select
                  id={field.name}
                  value={additionalFieldValues[field.name] || ''}
                  onChange={(e) => handleAdditionalFieldChange(field.name, e.target.value)}
                  className={styles.formControl}
                >
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </>
            ) : field.type === 'textarea' ? (
              <>
                <label htmlFor={field.name}>{field.label}</label>
                <textarea
                  id={field.name}
                  value={additionalFieldValues[field.name] || ''}
                  onChange={(e) => handleAdditionalFieldChange(field.name, e.target.value)}
                  className={styles.formControl}
                  rows={4}
                />
              </>
            ) : field.type === 'number' ? (
              <>
                <label htmlFor={field.name}>{field.label}</label>
                <input
                  type="number"
                  id={field.name}
                  value={additionalFieldValues[field.name] || ''}
                  onChange={(e) => handleAdditionalFieldChange(field.name, Number(e.target.value))}
                  className={styles.formControl}
                  min={field.min}
                  max={field.max}
                />
              </>
            ) : (
              <>
                <label htmlFor={field.name}>{field.label}</label>
                <input
                  type="text"
                  id={field.name}
                  value={additionalFieldValues[field.name] || ''}
                  onChange={(e) => handleAdditionalFieldChange(field.name, e.target.value)}
                  className={styles.formControl}
                />
              </>
            )}
          </div>
        ))}
      </>
    );
  };

  // Render request preview
  const renderRequestPreview = () => {
    // Función para formatear JSON con resaltado de sintaxis
    const formatJsonWithSyntax = (json: any) => {
      const jsonString = JSON.stringify(json, null, 2);
      
      return jsonString.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
        let cls = 'number';
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'key';
          } else {
            cls = 'string';
          }
        } else if (/true|false/.test(match)) {
          cls = 'boolean';
        } else if (/null/.test(match)) {
          cls = 'null';
        }
        return `<span class="${styles[cls]}">${match}</span>`;
      });
    };
    
    return (
      <div className={styles.requestPreview}>
        <div className={styles.requestDetails}>
          <div className={styles.requestSection}>
            <h4>Detalles de la solicitud</h4>
            <div className={styles.requestMethod}>
              {method} {apiUrl}
            </div>
            <div className={styles.requestHeaders}>
              <strong>Headers:</strong>
              <pre className={`${styles.pre} ${styles.jsonResponse}`}>
                <code dangerouslySetInnerHTML={{ 
                  __html: formatJsonWithSyntax({
                    'Content-Type': 'application/json'
                  }) 
                }}></code>
              </pre>
            </div>
          </div>
          
          <div className={styles.requestSection}>
            <h4>Body:</h4>
            <pre className={`${styles.pre} ${styles.jsonResponse}`}>
              <code dangerouslySetInnerHTML={{ 
                __html: formatJsonWithSyntax(requestBody) 
              }}></code>
            </pre>
          </div>
        </div>
      </div>
    );
  };

  // Render response content
  const renderResponseContent = () => {
    // Check if response is valid JSON for syntax highlighting
    let formattedResponse = response;
    let isJsonResponse = false;
    
    try {
      if (response && (response.trim().startsWith('{') || response.trim().startsWith('['))) {
        const parsedJson = JSON.parse(response);
        formattedResponse = JSON.stringify(parsedJson, null, 2);
        isJsonResponse = true;
      }
    } catch (e) {
      // Not valid JSON, use the original response
    }
    
    // Function to add syntax highlighting to JSON
    const highlightJson = (json: string) => {
      // Primero asegurarse de que el JSON esté bien formateado con indentación
      try {
        const parsedJson = JSON.parse(json);
        json = JSON.stringify(parsedJson, null, 2);
      } catch (e) {
        // Si no es un JSON válido, mantener el original
      }
      
      // Reemplazar con regex para añadir spans con clases apropiadas
      return json
        .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
          let cls = 'number';
          if (/^"/.test(match)) {
            if (/:$/.test(match)) {
              cls = 'key';
            } else {
              cls = 'string';
            }
          } else if (/true|false/.test(match)) {
            cls = 'boolean';
          } else if (/null/.test(match)) {
            cls = 'null';
          }
          return `<span class="${styles[cls]}">${match}</span>`;
        });
    };
    
    return (
      <div className={styles.responseContainer}>
        {responseStatus && (
          <div className={styles.responseHeader}>
            {renderStatusBadge()}
            <div className={styles.responseActions}>
              {requestTime !== null && (
                <div className={styles.requestTime}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.timeIcon}>
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                  </svg>
                  {requestTime.toFixed(0)} ms
                </div>
              )}
              <button 
                className={styles.copyButton} 
                onClick={copyToClipboard}
                title="Copiar respuesta"
                aria-label="Copiar respuesta"
              >
                {isCopied ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                )}
              </button>
            </div>
          </div>
        )}
        <pre className={`${styles.pre} ${isJsonResponse ? styles.jsonResponse : ''}`}>
          {isLoading ? (
            <div className={styles.loadingIndicator}>
              <div className={styles.loadingSpinner}></div>
              <span>Procesando solicitud...</span>
            </div>
          ) : (
            isJsonResponse ? (
              <code dangerouslySetInnerHTML={{ __html: highlightJson(formattedResponse) }}></code>
            ) : (
              formattedResponse
            )
          )}
        </pre>
      </div>
    );
  };

  return (
    <div className={styles.apiTester}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        
        <div className={styles.tabs}>
          <button
            className={`${styles.tabButton} ${activeTab === 'request' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('request')}
          >
            Solicitud
          </button>
          <button
            className={`${styles.tabButton} ${activeTab === 'response' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('response')}
          >
            Respuesta {renderStatusBadge()}
          </button>
        </div>
        
        <div className={styles.tabContent}>
          {activeTab === 'request' ? (
            <div className={styles.formAndPreview}>
              <form onSubmit={handleSubmit} className={styles.form}>
                <div className={styles.formGrid}>
                  {renderFormFields()}
                </div>
                
                <div className={styles.buttonContainer}>
                  <button 
                    type="submit" 
                    className={`${styles.button} ${styles.primary}`}
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <>
                        <span className={styles.loadingSpinner}></span>
                        Enviando...
                      </>
                    ) : (
                      'Enviar Solicitud'
                    )}
                  </button>
                </div>
              </form>
              
              {renderRequestPreview()}
            </div>
          ) : (
            renderResponseContent()
          )}
        </div>
        
        {error && (
          <div className={styles.errorMessage}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
} 