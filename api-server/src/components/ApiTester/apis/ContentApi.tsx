'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField } from '../components/FormComponents';

// Estilos CSS en línea para los checkboxes
const styles: Record<string, React.CSSProperties> = {
  checkboxGroup: {
    marginBottom: '15px',
  },
  checkboxLabel: {
    display: 'block',
    fontWeight: 'bold',
    marginBottom: '8px',
  },
  checkboxOptions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    paddingLeft: '8px',
  },
  checkboxOption: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  checkboxInput: {
    margin: '0',
    cursor: 'pointer',
  },
  checkboxText: {
    cursor: 'pointer',
  }
};

// Props específicas para la API de Contenido
export interface ContentApiProps {
  defaultUrl?: string;
  defaultSegmentId?: string;
  defaultModelType?: string;
  defaultModel?: string;
  showModelOptions?: boolean;
  defaultLimit?: number;
  defaultContentTypes?: string[];
  defaultFunnelStage?: string;
  defaultSortBy?: string;
}

// Estado específico para la API de Contenido
export interface ContentApiState {
  url: string;
  segment_id: string;
  content_types: string[];
  limit: number;
  funnel_stage: string;
  modelType: ModelProviderType;
  modelId: string;
  includeScreenshot: boolean;
  user_id?: string;
  site_id?: string;
  timeout: number;
  include_metadata: boolean;
  sort_by: string;
  topics?: string[];
}

// Definir un tipo específico para los temas
type Topic = string;

// Configuración de la API de Contenido
const ContentApi: BaseApiConfig = {
  id: 'content',
  name: 'API de Contenido para Segmentos',
  description: 'API para obtener recomendaciones de contenido personalizadas basadas en segmentos de audiencia',
  defaultEndpoint: '/api/site/content',

  // Obtener el estado inicial
  getInitialState: (props: ContentApiProps): ContentApiState => {
    return {
      url: props.defaultUrl || 'https://ejemplo.com',
      segment_id: props.defaultSegmentId || 'seg_content_creators',
      content_types: props.defaultContentTypes || ['posts', 'videos'],
      limit: props.defaultLimit || 10,
      funnel_stage: props.defaultFunnelStage || 'all',
      modelType: (props.defaultModelType as ModelProviderType) || 'anthropic',
      modelId: props.defaultModel || 'claude-3-5-sonnet-20240620',
      includeScreenshot: false,
      user_id: '',
      site_id: '',
      timeout: 30000,
      include_metadata: true,
      sort_by: props.defaultSortBy || 'relevance',
      topics: []
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: ContentApiState): Record<string, any> => {
    const body: Record<string, any> = {
      url: state.url,
      segment_id: state.segment_id,
      content_types: state.content_types,
      limit: state.limit,
      funnel_stage: state.funnel_stage,
      timeout: state.timeout,
      include_metadata: state.include_metadata,
      sort_by: state.sort_by,
      includeScreenshot: state.includeScreenshot
    };
    
    if (state.modelType) body.provider = state.modelType;
    if (state.modelId) body.modelId = state.modelId;
    if (state.user_id) body.user_id = state.user_id;
    if (state.site_id) body.site_id = state.site_id;
    if (state.topics && state.topics.length > 0) body.topics = state.topics;
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: ContentApiState;
    setState: React.Dispatch<React.SetStateAction<ContentApiState>>;
    showModelOptions?: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showModelOptions, additionalFields } = props;
    
    // Función para manejar cambios en los campos
    const handleChange = (field: string, value: any) => {
      setState((prev: any) => ({
        ...prev,
        [field]: value
      }));
    };

    // Verificar si tenemos additionalFields para usar
    const hasAdditionalFields = additionalFields && additionalFields.length > 0;
    
    // Procesar los campos adicionales si están presentes
    const renderAdditionalFields = () => {
      if (!hasAdditionalFields) return null;
      
      // Crear un mapa de nombres de campos ya renderizados
      const renderedFields = new Set<string>();
      
      return additionalFields.map((field: any, index: number) => {
        // Marcar este campo como renderizado
        renderedFields.add(field.name);
        
        // Manejar el caso especial de tipos de contenido (select múltiple)
        if (field.name === 'content_types') {
          return (
            <div key={index} style={styles.checkboxGroup}>
              <label style={styles.checkboxLabel}>{field.label}</label>
              <div style={styles.checkboxOptions}>
                {field.options.map((option: any, i: number) => (
                  <div key={i} style={styles.checkboxOption}>
                    <input
                      type="checkbox"
                      id={`content-type-${option.value}`}
                      checked={state.content_types.includes(option.value)}
                      onChange={(e) => {
                        const newValue = [...state.content_types];
                        if (e.target.checked) {
                          if (!newValue.includes(option.value)) {
                            newValue.push(option.value);
                          }
                        } else {
                          const index = newValue.indexOf(option.value);
                          if (index !== -1) {
                            newValue.splice(index, 1);
                          }
                        }
                        handleChange('content_types', newValue);
                      }}
                      style={styles.checkboxInput}
                    />
                    <label htmlFor={`content-type-${option.value}`} style={styles.checkboxText}>{option.label}</label>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        
        // Para el resto de los campos usar el FormField normal
        return (
          <FormField
            key={index}
            label={field.label}
            id={field.name}
            type={field.type}
            value={(state as any)[field.name] !== undefined ? (state as any)[field.name] : field.defaultValue}
            onChange={(value: any) => handleChange(field.name, value)}
            options={field.options}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            required={field.required}
          />
        );
      });
    };
    
    // Renderizar campos predeterminados solo si no hay campos adicionales
    const renderDefaultFields = () => {
      if (hasAdditionalFields) return null;
      
      return (
        <>
          <FormField
            label="URL del Sitio"
            id="url"
            type="text"
            value={state.url}
            onChange={(value: any) => handleChange('url', value)}
            placeholder="https://ejemplo.com"
            required
          />
          
          <FormField
            label="ID del Segmento"
            id="segment_id"
            type="text"
            value={state.segment_id}
            onChange={(value: any) => handleChange('segment_id', value)}
            placeholder="ID del segmento en la base de datos"
            required
          />
          
          <div style={styles.checkboxGroup}>
            <label style={styles.checkboxLabel}>Tipos de contenido</label>
            <div style={styles.checkboxOptions}>
              {[
                { value: "posts", label: "Artículos/Posts" },
                { value: "videos", label: "Videos" },
                { value: "podcasts", label: "Podcasts" },
                { value: "ads", label: "Anuncios" },
                { value: "social", label: "Contenido Social" },
                { value: "downloads", label: "Descargables" }
              ].map((option, i) => (
                <div key={i} style={styles.checkboxOption}>
                  <input
                    type="checkbox"
                    id={`content-type-default-${option.value}`}
                    checked={state.content_types.includes(option.value)}
                    onChange={(e) => {
                      const newValue = [...state.content_types];
                      if (e.target.checked) {
                        if (!newValue.includes(option.value)) {
                          newValue.push(option.value);
                        }
                      } else {
                        const index = newValue.indexOf(option.value);
                        if (index !== -1) {
                          newValue.splice(index, 1);
                        }
                      }
                      handleChange('content_types', newValue);
                    }}
                    style={styles.checkboxInput}
                  />
                  <label htmlFor={`content-type-default-${option.value}`} style={styles.checkboxText}>{option.label}</label>
                </div>
              ))}
            </div>
          </div>
          
          <FormField
            label="Número máximo de resultados"
            id="limit"
            type="number"
            value={state.limit}
            onChange={(value: any) => handleChange('limit', value)}
            min={1}
            max={50}
          />
          
          <FormField
            label="Etapa del funnel"
            id="funnel_stage"
            type="select"
            value={state.funnel_stage}
            onChange={(value: any) => handleChange('funnel_stage', value)}
            options={[
              { value: "all", label: "Todas las etapas" },
              { value: "awareness", label: "Conocimiento (Awareness)" },
              { value: "consideration", label: "Consideración" },
              { value: "decision", label: "Decisión" },
              { value: "retention", label: "Retención" }
            ]}
          />
          
          <FormField
            label="Temas (separados por comas)"
            id="topics"
            type="text"
            value={state.topics?.join(', ') || ''}
            onChange={(value: any) => handleChange('topics', value.split(',').map((topic: string) => topic.trim()).filter((topic: string) => topic !== ''))}
            placeholder="marketing digital, redes sociales, ..."
          />
          
          <FormField
            label="Criterio de ordenación"
            id="sort_by"
            type="select"
            value={state.sort_by}
            onChange={(value: any) => handleChange('sort_by', value)}
            options={[
              { value: "relevance", label: "Relevancia" },
              { value: "date", label: "Fecha" },
              { value: "popularity", label: "Popularidad" }
            ]}
          />

          <FormField
            label="ID de Usuario (opcional)"
            id="user_id"
            type="text"
            value={state.user_id}
            onChange={(value: any) => handleChange('user_id', value)}
            placeholder="user_123456"
          />
          
          <FormField
            label="ID del Sitio (opcional)"
            id="site_id"
            type="text"
            value={state.site_id}
            onChange={(value: any) => handleChange('site_id', value)}
            placeholder="site_789012"
          />
        </>
      );
    };
    
    return (
      <>
        {renderDefaultFields()}
        {renderAdditionalFields()}
        
        {/* Estos campos siempre se renderizan independientemente de additionalFields */}
        {showModelOptions && (
          <>
            <FormField
              label="Proveedor IA"
              id="modelType"
              type="select"
              value={state.modelType}
              onChange={(value: any) => handleChange('modelType', value)}
              options={[
                { value: "anthropic", label: "Anthropic" },
                { value: "openai", label: "OpenAI" },
                { value: "gemini", label: "Google Gemini" }
              ]}
            />
            
            <FormField
              label="Modelo IA"
              id="modelId"
              type="select"
              value={state.modelId}
              onChange={(value: any) => handleChange('modelId', value)}
              options={MODEL_OPTIONS[state.modelType] || []}
            />
          </>
        )}
        
        {/* Solo renderizar timeout si no está ya incluido en additionalFields */}
        {!hasAdditionalFields || !additionalFields.some(field => field.name === 'timeout') ? (
          <FormField
            label="Timeout (ms)"
            id="timeout"
            type="number"
            value={state.timeout}
            onChange={(value: any) => handleChange('timeout', value)}
            min={5000}
            max={120000}
          />
        ) : null}
        
        {/* Solo renderizar includeScreenshot si no está ya incluido en additionalFields */}
        {!hasAdditionalFields || !additionalFields.some(field => field.name === 'includeScreenshot') ? (
          <FormField
            label="Incluir captura de pantalla"
            id="includeScreenshot"
            type="checkbox"
            value={state.includeScreenshot}
            onChange={(value: any) => handleChange('includeScreenshot', value)}
          />
        ) : null}
        
        {/* Solo renderizar include_metadata si no está ya incluido en additionalFields */}
        {!hasAdditionalFields || !additionalFields.some(field => field.name === 'include_metadata') ? (
          <FormField
            label="Incluir metadatos detallados"
            id="include_metadata"
            type="checkbox"
            value={state.include_metadata}
            onChange={(value: any) => handleChange('include_metadata', value)}
          />
        ) : null}
      </>
    );
  }
};

export default ContentApi; 