'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

export interface SegmentsApiProps {
  defaultSiteId?: string;
  defaultAgentId?: string;
  defaultUserId?: string;
  defaultSegmentCount?: number;
  defaultSegmentIds?: string[];
}

export interface SegmentsApiState {
  siteId: string;
  agent_id: string;
  userId: string;
  segmentData: {
    segmentCount: number;
  };
  segmentIds: string[];
  apiMode: 'create' | 'icp';
  endpoint: string;
  jsonResponse: boolean;
  showResponse: boolean;
  loading: boolean;
  error: string | null;
  response: any;
  responseStatus: number;
}

// Configuración para la API de Segments
const SegmentsApi: BaseApiConfig = {
  id: 'segments',
  name: 'Segments API',
  description: 'API para crear segmentos de audiencia y realizar análisis ICP con agentes Growth Marketer',
  defaultEndpoint: '/api/agents/growth/segments',
  
  // Inicializar el estado del formulario
  getInitialState: (props: SegmentsApiProps = {}): SegmentsApiState => {
    return {
      siteId: props.defaultSiteId || '',
      agent_id: props.defaultAgentId || '',
      userId: props.defaultUserId || '',
      segmentData: {
        segmentCount: props.defaultSegmentCount || 5
      },
      segmentIds: props.defaultSegmentIds || [],
      apiMode: 'create',
      endpoint: '/api/agents/growth/segments',
      jsonResponse: false,
      showResponse: false,
      loading: false,
      error: null,
      response: null,
      responseStatus: 0
    };
  },
  
  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: SegmentsApiState): Record<string, any> => {
    const body: Record<string, any> = {
      siteId: state.siteId
    };
    
    // Agregamos campos opcionales si existen
    if (state.agent_id) body.agent_id = state.agent_id;
    if (state.userId) body.userId = state.userId;
    
    if (state.apiMode === 'create') {
      body.segmentData = state.segmentData;
    } else if (state.apiMode === 'icp') {
      body.segmentIds = state.segmentIds;
    }
    
    return body;
  },
  
  // Renderizar campos del formulario
  renderFields: (props: {
    state: SegmentsApiState;
    setState: React.Dispatch<React.SetStateAction<SegmentsApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    // Función para actualizar el estado del formulario
    const handleChange = (field: keyof SegmentsApiState, value: any) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    // Función para actualizar el objeto segmentData
    const handleSegmentDataChange = (field: keyof SegmentsApiState['segmentData'], value: any) => {
      setState(prev => ({
        ...prev,
        segmentData: {
          ...prev.segmentData,
          [field]: value
        }
      }));
    };
    
    // Función para actualizar segmentIds
    const handleSegmentIdsChange = (value: string) => {
      const segmentIds = value.split(',').map(id => id.trim()).filter(id => id.length > 0);
      handleChange('segmentIds', segmentIds);
    };

    const handleModeChange = (value: string) => {
      handleChange('apiMode', value as 'create' | 'icp');
      
      // Update endpoint based on mode
      setState(prev => ({
        ...prev,
        apiMode: value as 'create' | 'icp',
        endpoint: value === 'icp' ? '/api/agents/growth/segments/icp' : '/api/agents/growth/segments'
      }));
    };

    const handleSegmentCountChange = (value: number) => {
      handleSegmentDataChange('segmentCount', value);
    };
    
    return (
      <>
        <SectionLabel>API Mode</SectionLabel>
        
        <FormField
          label="API Mode"
          id="apiMode"
          type="select"
          value={state.apiMode}
          options={[
            { value: 'create', label: 'Create Segments' },
            { value: 'icp', label: 'ICP Analysis' }
          ]}
          onChange={handleModeChange}
          required
        />
        
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
        
        {state.apiMode === 'icp' && (
          <FormField
            label="Segment IDs (comma separated)"
            id="segmentIds"
            type="text"
            value={state.segmentIds.join(', ')}
            placeholder="seg_123, seg_456, seg_789"
            onChange={handleSegmentIdsChange}
            required
          />
        )}
        
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
        
        {state.apiMode === 'create' && (
          <FormField
            label="Segment Count"
            id="segmentCount"
            type="number"
            value={state.segmentData.segmentCount}
            placeholder="5"
            onChange={handleSegmentCountChange}
            min={1}
            max={20}
          />
        )}
      </>
    );
  }
};

export default SegmentsApi; 