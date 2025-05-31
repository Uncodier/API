'use client';

import React from 'react';
import { BaseApiConfig, ModelProviderType, MODEL_OPTIONS } from '../types';
import { FormField } from '../components/FormComponents';

// Estilos CSS en línea para los checkboxes y selects
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
  },
  selectGroup: {
    marginBottom: '15px',
  },
  selectLabel: {
    display: 'block',
    fontWeight: 'bold',
    marginBottom: '8px',
  },
  select: {
    width: '100%',
    padding: '8px',
    borderRadius: '4px',
    border: '1px solid #ccc',
  }
};

// Props específicas para la API de Requisitos
export interface RequirementsApiProps {
  defaultUrl?: string;
  defaultSegmentId?: string;
  defaultModelType?: string;
  defaultModel?: string;
  showModelOptions?: boolean;
  defaultLimit?: number;
  defaultRequirementTypes?: string[];
  defaultPriorityLevel?: string;
  defaultDeviceType?: string;
  defaultTimeout?: string;
  defaultIncludeImplementation?: boolean;
  defaultIncludeConformity?: boolean;
}

// Estado específico para la API de Requisitos
export interface RequirementsApiState {
  url: string;
  segment_id: string;
  requirement_types: string[];
  limit: number;
  priority_level: string;
  device_type: string;
  modelType: ModelProviderType;
  modelId: string;
  includeScreenshot: boolean;
  user_id?: string;
  site_id?: string;
  timeout: number;
  include_implementation: boolean;
  include_conformity: boolean;
}

// Opciones para los tipos de requisitos
const requirementTypeOptions = [
  { value: 'technical', label: 'Técnicos' },
  { value: 'functional', label: 'Funcionales' },
  { value: 'accessibility', label: 'Accesibilidad' },
  { value: 'performance', label: 'Rendimiento' },
  { value: 'usability', label: 'Usabilidad' },
  { value: 'content', label: 'Contenido' }
];

// Opciones para los niveles de prioridad
const priorityLevelOptions = [
  { value: 'all', label: 'Todos los niveles' },
  { value: 'critical', label: 'Crítico' },
  { value: 'high', label: 'Alto' },
  { value: 'medium', label: 'Medio' },
  { value: 'low', label: 'Bajo' }
];

// Opciones para los tipos de dispositivos
const deviceTypeOptions = [
  { value: 'all', label: 'Todos los dispositivos' },
  { value: 'mobile', label: 'Móvil' },
  { value: 'desktop', label: 'Desktop' },
  { value: 'tablet', label: 'Tablet' }
];

// Configuración de la API de Requisitos
const RequirementsApi: BaseApiConfig = {
  id: 'requirements',
  name: 'API de Requisitos para Segmentos',
  description: 'Obtiene requisitos técnicos y funcionales específicos para segmentos de audiencia',
  defaultEndpoint: '/api/site/requirements',

  // Obtener el estado inicial basado en las props
  getInitialState: (props: RequirementsApiProps) => {
    return {
      url: props.defaultUrl || 'https://ejemplo.com',
      segment_id: props.defaultSegmentId || 'seg_content_creators',
      requirement_types: props.defaultRequirementTypes || ['technical', 'functional'],
      limit: props.defaultLimit || 15,
      priority_level: props.defaultPriorityLevel || 'all',
      device_type: props.defaultDeviceType || 'all',
      modelType: (props.defaultModelType || 'anthropic') as ModelProviderType,
      modelId: props.defaultModel || 'claude-3-5-sonnet-20240620',
      includeScreenshot: true,
      timeout: parseInt(props.defaultTimeout || '30000'),
      include_implementation: props.defaultIncludeImplementation !== undefined ? props.defaultIncludeImplementation : true,
      include_conformity: props.defaultIncludeConformity !== undefined ? props.defaultIncludeConformity : true,
      user_id: '',
      site_id: ''
    };
  },

  // Construir el cuerpo de la solicitud basado en el estado
  buildRequestBody: (state: RequirementsApiState) => {
    const body: Record<string, any> = {
      url: state.url,
      segment_id: state.segment_id,
      requirement_types: state.requirement_types,
      limit: state.limit,
      priority_level: state.priority_level,
      device_type: state.device_type,
      provider: state.modelType,
      modelId: state.modelId,
      timeout: state.timeout,
      include_implementation: state.include_implementation,
      include_conformity: state.include_conformity,
      includeScreenshot: state.includeScreenshot
    };

    // Añadir campos opcionales si tienen valor
    if (state.user_id) body.user_id = state.user_id;
    if (state.site_id) body.site_id = state.site_id;

    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: any) => {
    const { state, setState } = props;

    // Función para manejar cambios en el estado
    const handleChange = (field: string, value: any) => {
      setState({ ...state, [field]: value });
    };

    // Manejar cambios en los checkboxes de tipos de requisitos
    const handleRequirementTypeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      const isChecked = e.target.checked;
      
      let updatedTypes = [...state.requirement_types];
      
      if (isChecked && !updatedTypes.includes(value)) {
        updatedTypes.push(value);
      } else if (!isChecked && updatedTypes.includes(value)) {
        updatedTypes = updatedTypes.filter(type => type !== value);
      }
      
      handleChange('requirement_types', updatedTypes);
    };

    // Renderizar campos adicionales específicos para esta API
    const renderAdditionalFields = () => {
      return (
        <>
          {/* Tipos de requisitos */}
          <div style={styles.checkboxGroup}>
            <label style={styles.checkboxLabel}>Tipos de requisitos:</label>
            <div style={styles.checkboxOptions}>
              {requirementTypeOptions.map(option => (
                <div key={option.value} style={styles.checkboxOption}>
                  <input
                    type="checkbox"
                    id={`requirement-type-${option.value}`}
                    value={option.value}
                    checked={state.requirement_types.includes(option.value)}
                    onChange={handleRequirementTypeChange}
                    style={styles.checkboxInput}
                  />
                  <label 
                    htmlFor={`requirement-type-${option.value}`}
                    style={styles.checkboxText}
                  >
                    {option.label}
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Nivel de prioridad */}
          <div style={styles.selectGroup}>
            <label style={styles.selectLabel}>Nivel de prioridad mínimo:</label>
            <select
              value={state.priority_level}
              onChange={(e) => handleChange('priority_level', e.target.value)}
              style={styles.select}
            >
              {priorityLevelOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Tipo de dispositivo */}
          <div style={styles.selectGroup}>
            <label style={styles.selectLabel}>Tipo de dispositivo:</label>
            <select
              value={state.device_type}
              onChange={(e) => handleChange('device_type', e.target.value)}
              style={styles.select}
            >
              {deviceTypeOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Incluir implementación */}
          <div style={styles.checkboxOption}>
            <input
              type="checkbox"
              id="include-implementation"
              checked={state.include_implementation}
              onChange={(e) => handleChange('include_implementation', e.target.checked)}
              style={styles.checkboxInput}
            />
            <label 
              htmlFor="include-implementation"
              style={styles.checkboxText}
            >
              Incluir guía de implementación
            </label>
          </div>

          {/* Incluir conformidad */}
          <div style={styles.checkboxOption}>
            <input
              type="checkbox"
              id="include-conformity"
              checked={state.include_conformity}
              onChange={(e) => handleChange('include_conformity', e.target.checked)}
              style={styles.checkboxInput}
            />
            <label 
              htmlFor="include-conformity"
              style={styles.checkboxText}
            >
              Incluir evaluación de conformidad
            </label>
          </div>

          {/* Incluir screenshot */}
          <div style={styles.checkboxOption}>
            <input
              type="checkbox"
              id="include-screenshot"
              checked={state.includeScreenshot}
              onChange={(e) => handleChange('includeScreenshot', e.target.checked)}
              style={styles.checkboxInput}
            />
            <label 
              htmlFor="include-screenshot"
              style={styles.checkboxText}
            >
              Incluir captura de pantalla
            </label>
          </div>

          {/* ID de Usuario (opcional) */}
          <FormField
            id="user_id"
            label="ID de Usuario (opcional)"
            type="text"
            value={state.user_id || ''}
            onChange={(value) => handleChange('user_id', value)}
            placeholder="user_123456"
          />

          {/* ID del Sitio (opcional) */}
          <FormField
            id="site_id"
            label="ID del Sitio (opcional)"
            type="text"
            value={state.site_id || ''}
            onChange={(value) => handleChange('site_id', value)}
            placeholder="site_789012"
          />
        </>
      );
    };

    // Renderizar campos predeterminados
    const renderDefaultFields = () => {
      return (
        <>
          {/* URL del sitio */}
          <FormField
            id="url"
            label="URL del sitio"
            type="text"
            value={state.url}
            onChange={(value) => handleChange('url', value)}
            placeholder="https://ejemplo.com"
            required
          />

          {/* ID del segmento */}
          <FormField
            id="segment_id"
            label="ID del Segmento"
            type="text"
            value={state.segment_id}
            onChange={(value) => handleChange('segment_id', value)}
            placeholder="seg_content_creators"
            required
          />

          {/* Límite de resultados */}
          <FormField
            id="limit"
            label="Número máximo de requisitos"
            type="number"
            value={state.limit}
            onChange={(value) => handleChange('limit', parseInt(value))}
            min={1}
            max={50}
          />

          {/* Timeout */}
          <FormField
            id="timeout"
            label="Timeout (ms)"
            type="number"
            value={state.timeout}
            onChange={(value) => handleChange('timeout', parseInt(value))}
            min={5000}
            max={120000}
          />

          {/* Opciones de modelo de IA */}
          {props.showModelOptions && (
            <>
              <div style={styles.selectGroup}>
                <label style={styles.selectLabel}>Proveedor de IA:</label>
                <select
                  value={state.modelType}
                  onChange={(e) => handleChange('modelType', e.target.value)}
                  style={styles.select}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Google Gemini</option>
                </select>
              </div>

              <div style={styles.selectGroup}>
                <label style={styles.selectLabel}>Modelo de IA:</label>
                <select
                  value={state.modelId}
                  onChange={(e) => handleChange('modelId', e.target.value)}
                  style={styles.select}
                >
                  {MODEL_OPTIONS[state.modelType as ModelProviderType].map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </>
      );
    };

    return (
      <div>
        {renderDefaultFields()}
        {renderAdditionalFields()}
      </div>
    );
  }
};

export default RequirementsApi; 