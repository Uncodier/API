'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props específicas para la API de Apps de Agentes
export interface AgentsIntegrationsApiProps {
  defaultCategory?: string;
  defaultStatus?: string;
}

// Estado específico para la API de Apps de Agentes
export interface AgentsIntegrationsApiState {
  category: string;
  status: string;
  jsonResponse: boolean;
}

// Configuración de la API de Apps de Agentes
const AgentsIntegrationsApi: BaseApiConfig = {
  id: 'agents-apps',
  name: 'Apps API',
  description: 'API to list available apps for agents',
  defaultEndpoint: '/api/agents/apps/list',

  // Obtener el estado inicial
  getInitialState: (props: AgentsIntegrationsApiProps): AgentsIntegrationsApiState => {
    return {
      category: props.defaultCategory || '',
      status: props.defaultStatus || '',
      jsonResponse: false
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: AgentsIntegrationsApiState): Record<string, any> => {
    // For GET requests, we don't need a request body
    return {};
  },

  // Build the request URL with query parameters
  buildRequestUrl: (state: AgentsIntegrationsApiState, endpoint: string): string => {
    const params = new URLSearchParams();
    
    if (state.category) params.append('category', state.category);
    if (state.status) params.append('status', state.status);
    
    const queryString = params.toString();
    return queryString ? `${endpoint}?${queryString}` : endpoint;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: AgentsIntegrationsApiState;
    setState: React.Dispatch<React.SetStateAction<AgentsIntegrationsApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption } = props;
    
    const handleChange = (field: keyof AgentsIntegrationsApiState, value: string | boolean) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
        <SectionLabel>Filter Options</SectionLabel>
        
        <FormField
          label="Category"
          id="category"
          type="select"
          value={state.category}
          onChange={(value: string) => handleChange('category', value)}
          options={[
            { value: '', label: 'All Categories' },
            { value: 'analytics', label: 'Analytics' },
            { value: 'crm', label: 'CRM' },
            { value: 'communication', label: 'Communication' },
            { value: 'marketing', label: 'Marketing' }
          ]}
        />
        
        <FormField
          label="Status"
          id="status"
          type="select"
          value={state.status}
          onChange={(value: string) => handleChange('status', value)}
          options={[
            { value: '', label: 'All Statuses' },
            { value: 'active', label: 'Active' },
            { value: 'beta', label: 'Beta' },
            { value: 'deprecated', label: 'Deprecated' }
          ]}
        />
      </>
    );
  }
};

export default AgentsIntegrationsApi; 