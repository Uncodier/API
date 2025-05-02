import React from 'react';
import { BaseApiConfig } from '../types';

interface FormFieldProps {
  label: string;
  id: string;
  type: string;
  value: any;
  onChange: (value: any) => void;
  placeholder?: string;
  required?: boolean;
  rows?: number;
  options?: Array<{value: string, label: string}>;
  readOnly?: boolean;
}

// Componente FormField simplificado
const FormField: React.FC<FormFieldProps> = ({ 
  label, 
  id, 
  type, 
  value, 
  onChange, 
  placeholder, 
  required,
  rows = 3,
  options = [],
  readOnly = false
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    onChange(e.target.value);
  };

  return (
    <div style={{ marginBottom: '16px' }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: '4px', fontWeight: 'medium' }}>
        {label} {required && <span style={{ color: 'red' }}>*</span>}
      </label>
      
      {type === 'textarea' ? (
        <textarea
          id={id}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          required={required}
          rows={rows}
          readOnly={readOnly}
          style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
        />
      ) : type === 'select' ? (
        <select
          id={id}
          value={value}
          onChange={handleChange}
          required={required}
          disabled={readOnly}
          style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          required={required}
          readOnly={readOnly}
          style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
        />
      )}
    </div>
  );
};

interface SalesApiStateProps {
  state: Record<string, any>;
  setState: (updatedFields: Record<string, any>) => void;
  showJsonOption?: boolean;
  showScreenshotOption?: boolean;
  showModelOptions?: boolean;
  showAnalysisTypeField?: boolean;
  showSiteUrlField?: boolean;
  showUrlField?: boolean;
  additionalFields?: any[];
}

interface ApiDefaults {
  defaultMethod?: string;
  defaultEndpoint?: string;
  [key: string]: any;
}

const SalesApi: BaseApiConfig = {
  id: 'sales',
  name: 'Sales API',
  description: 'API para gestionar operaciones de ventas como generación de leads',
  defaultEndpoint: '/api/agents/sales/lead-generation',

  getInitialState: (defaults: ApiDefaults) => {
    return {
      method: defaults.defaultMethod || 'POST',
      endpoint: defaults.defaultEndpoint || '/api/agents/sales/lead-generation',
      siteId: '',
      websiteUrl: '',
      agent_id: '',
      leadCaptureMechanism: 'form',
      maxGenerationCount: 3,
      priority: 'medium'
    };
  },

  buildRequestBody: (state: Record<string, any>) => {
    let requestBody: Record<string, any> = {
      siteId: state.siteId,
      websiteUrl: state.websiteUrl
    };

    // Añadir campos opcionales solo si tienen valor
    if (state.agent_id) requestBody.agent_id = state.agent_id;
    if (state.leadCaptureMechanism) requestBody.leadCaptureMechanism = state.leadCaptureMechanism;
    if (state.maxGenerationCount) requestBody.maxGenerationCount = Number(state.maxGenerationCount);
    if (state.priority) requestBody.priority = state.priority;

    return requestBody;
  },

  renderFields: ({ state, setState }: SalesApiStateProps) => {
    return (
      <>
        <FormField
          label="Site ID"
          id="siteId"
          type="text"
          value={state.siteId}
          onChange={(value) => setState({ siteId: value })}
          placeholder="ID del sitio web"
          required
        />

        <FormField
          label="Website URL"
          id="websiteUrl"
          type="text"
          value={state.websiteUrl}
          onChange={(value) => setState({ websiteUrl: value })}
          placeholder="URL del sitio web"
          required
        />

        <FormField
          label="Agent ID"
          id="agent_id"
          type="text"
          value={state.agent_id}
          onChange={(value) => setState({ agent_id: value })}
          placeholder="ID del agente para manejar la generación (opcional)"
        />

        <FormField
          label="Lead Capture Mechanism"
          id="leadCaptureMechanism"
          type="select"
          value={state.leadCaptureMechanism}
          onChange={(value) => setState({ leadCaptureMechanism: value })}
          options={[
            { value: 'form', label: 'Form' },
            { value: 'chatbot', label: 'Chatbot' },
            { value: 'popup', label: 'Popup' },
            { value: 'embedded', label: 'Embedded Widget' },
            { value: 'landing_page', label: 'Landing Page' }
          ]}
        />

        <FormField
          label="Max Generation Count"
          id="maxGenerationCount"
          type="number"
          value={state.maxGenerationCount}
          onChange={(value) => setState({ maxGenerationCount: value })}
          placeholder="Número máximo de elementos a generar"
        />
        
        <FormField
          label="Priority"
          id="priority"
          type="select"
          value={state.priority}
          onChange={(value) => setState({ priority: value })}
          options={[
            { value: 'high', label: 'High' },
            { value: 'medium', label: 'Medium' },
            { value: 'low', label: 'Low' }
          ]}
        />
      </>
    );
  }
};

export default SalesApi; 