'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Interfaces
export interface GrowthApiProps {
  defaultSiteId?: string;
  defaultAgentId?: string;
  defaultUserId?: string;
  defaultSegmentIds?: string[];
}

export interface GrowthApiState {
  siteId: string;
  agent_id: string;
  userId: string;
  campaignData: {
    segmentIds: string[];
  };
  jsonResponse: boolean;
  showResponse: boolean;
  loading: boolean;
  error: string | null;
  response: any;
  responseStatus: number;
}

// Configuración para la API de Growth
const GrowthApi: BaseApiConfig = {
  id: 'growth',
  name: 'Growth API',
  description: 'API para trabajar con campañas de marketing y estrategias de crecimiento',
  defaultEndpoint: '/api/agents/growth/campaigns',
  
  // Inicializar el estado del formulario
  getInitialState: (props: GrowthApiProps = {}): GrowthApiState => {
    return {
      siteId: props.defaultSiteId || '',
      agent_id: props.defaultAgentId || '',
      userId: props.defaultUserId || '',
      campaignData: {
        segmentIds: props.defaultSegmentIds || []
      },
      jsonResponse: false,
      showResponse: false,
      loading: false,
      error: null,
      response: null,
      responseStatus: 0
    };
  },
  
  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: GrowthApiState): Record<string, any> => {
    const body: Record<string, any> = {
      siteId: state.siteId,
      campaignData: state.campaignData
    };
    
    // Agregamos campos opcionales si existen
    if (state.agent_id) body.agent_id = state.agent_id;
    if (state.userId) body.userId = state.userId;
    
    return body;
  },
  
  // Renderizar campos del formulario
  renderFields: (props: {
    state: GrowthApiState;
    setState: React.Dispatch<React.SetStateAction<GrowthApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    // Función para actualizar el estado del formulario
    const handleChange = (field: keyof GrowthApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    // Función para actualizar el objeto campaignData
    const handleCampaignDataChange = (field: keyof GrowthApiState['campaignData'], value: any) => {
      setState(prev => ({
        ...prev,
        campaignData: {
          ...prev.campaignData,
          [field]: value
        }
      }));
    };
    
    // Función para actualizar el valor de segmentIds
    const handleSegmentsChange = (value: string) => {
      const segmentsArray = value.split(',').map(segment => segment.trim());
      handleCampaignDataChange('segmentIds', segmentsArray);
    };
    
    return (
      <>
        <SectionLabel>Required Fields</SectionLabel>
        
        <FormField
          label="Site ID"
          id="siteId"
          type="text"
          value={state.siteId}
          placeholder="site_456"
          onChange={(value: string) => handleChange('siteId', value)}
          required
        />
        
        <SectionLabel>Optional Fields</SectionLabel>
        
        <FormField
          label="Agent ID"
          id="agent_id"
          type="text"
          value={state.agent_id}
          placeholder="agent_growth_123"
          onChange={(value: string) => handleChange('agent_id', value)}
        />
        
        <FormField
          label="User ID"
          id="userId"
          type="text"
          value={state.userId}
          placeholder="user_789"
          onChange={(value: string) => handleChange('userId', value)}
        />
        
        <FormField
          label="Segment IDs (comma separated)"
          id="segmentIds"
          type="text"
          value={state.campaignData.segmentIds.join(', ')}
          placeholder="seg_123, seg_456"
          onChange={(value: string) => handleSegmentsChange(value)}
        />
      </>
    );
  }
};

export default GrowthApi; 