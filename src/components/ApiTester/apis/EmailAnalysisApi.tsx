'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props específicas para la API de Análisis de Email
export interface EmailAnalysisApiProps {
  defaultAgentId?: string;
  defaultSiteId?: string;
  defaultLimit?: number;
}

// Estado específico para la API de Análisis de Email
export interface EmailAnalysisApiState {
  agentId: string;
  site_id: string;
  limit?: number;
}

// Configuración de la API de Análisis de Email
const EmailAnalysisApi: BaseApiConfig = {
  id: 'email-analysis',
  name: 'API de Análisis de Email',
  description: 'API para análisis de emails utilizando agentes de IA',
  defaultEndpoint: '/api/agents/email',

  // Obtener el estado inicial
  getInitialState: (props: EmailAnalysisApiProps): EmailAnalysisApiState => {
    return {
      agentId: props.defaultAgentId || '',
      site_id: props.defaultSiteId || '',
      limit: props.defaultLimit || 10
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: EmailAnalysisApiState): Record<string, any> => {
    const body: Record<string, any> = {
      agentId: state.agentId,
      site_id: state.site_id
    };
    
    // Agregar campo opcional solo si tiene valor
    if (state.limit !== undefined) body.limit = state.limit;
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: EmailAnalysisApiState;
    setState: React.Dispatch<React.SetStateAction<EmailAnalysisApiState>>;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof EmailAnalysisApiState, value: string | number | boolean) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
        <SectionLabel>Campos Requeridos</SectionLabel>
        <FormField
          label="Agent ID"
          id="agentId"
          type="text"
          value={state.agentId}
          onChange={(value: string) => handleChange('agentId', value)}
          placeholder="agent_email_analyzer_123"
          required
        />
        
        <FormField
          label="Site ID"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value: string) => handleChange('site_id', value)}
          placeholder="site_abc123"
          required
        />
        
        <SectionLabel>Campos Opcionales</SectionLabel>
        
        <FormField
          label="Limit"
          id="limit"
          type="number"
          value={state.limit || 10}
          onChange={(value: string) => handleChange('limit', Number(value))}
          placeholder="Máximo número de emails (por defecto: 10)"
          min={1}
          max={50}
        />
      </>
    );
  }
};

export default EmailAnalysisApi; 