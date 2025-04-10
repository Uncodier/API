'use client';

import React from 'react';
import { BaseApiConfig } from '../types';

// Props específicas para la API de Apps de Agentes
export interface AgentsAppsApiProps {
  defaultCategory?: string;
  defaultStatus?: string;
}

// Estado específico para la API de Apps de Agentes
export interface AgentsAppsApiState {
  category: string;
  status: string;
  jsonResponse: boolean;
}

// Configuración de la API de Apps de Agentes
const AgentsAppsApi: BaseApiConfig = {
  id: 'agents-apps',
  name: 'Apps API',
  description: 'API to list available apps for agents',
  defaultEndpoint: '/api/agents/apps/list',

  // Obtener el estado inicial
  getInitialState: (props: AgentsAppsApiProps): AgentsAppsApiState => {
    return {
      category: props.defaultCategory || '',
      status: props.defaultStatus || '',
      jsonResponse: false
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: AgentsAppsApiState): Record<string, any> => {
    // For GET requests, we don't need a request body
    return {};
  },

  // Build the request URL with query parameters
  buildRequestUrl: (state: AgentsAppsApiState, endpoint: string): string => {
    const params = new URLSearchParams();
    
    if (state.category) params.append('category', state.category);
    if (state.status) params.append('status', state.status);
    
    const queryString = params.toString();
    return queryString ? `${endpoint}?${queryString}` : endpoint;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: AgentsAppsApiState;
    setState: React.Dispatch<React.SetStateAction<AgentsAppsApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption } = props;
    
    const handleChange = (field: keyof AgentsAppsApiState, value: string | boolean) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
        <div>
          <label className="block text-sm font-medium mb-1">Filter Options</label>
        </div>
        
        <div className="mb-4">
          <label htmlFor="category" className="block text-sm font-medium mb-1">Category</label>
          <select
            id="category"
            value={state.category}
            onChange={(e) => handleChange('category', e.target.value)}
            className="w-full p-2 border rounded"
          >
            <option value="">All Categories</option>
            <option value="analytics">Analytics</option>
            <option value="crm">CRM</option>
            <option value="communication">Communication</option>
            <option value="marketing">Marketing</option>
          </select>
        </div>
        
        <div className="mb-4">
          <label htmlFor="status" className="block text-sm font-medium mb-1">Status</label>
          <select
            id="status"
            value={state.status}
            onChange={(e) => handleChange('status', e.target.value)}
            className="w-full p-2 border rounded"
          >
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="beta">Beta</option>
            <option value="deprecated">Deprecated</option>
          </select>
        </div>
      </>
    );
  }
};

export default AgentsAppsApi; 