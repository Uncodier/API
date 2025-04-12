'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props específicas para la API de Copywriter
export interface CopywriterApiProps {
  defaultSiteId?: string;
  defaultSegmentId?: string;
  defaultCampaignId?: string;
  defaultUserId?: string;
  defaultAgentId?: string;
  defaultTimeframe?: string;
  defaultContentType?: string;
  defaultTargetAudience?: string;
  defaultGoals?: string;
  defaultKeywords?: string;
}

// Estado específico para la API de Copywriter
export interface CopywriterApiState {
  siteId: string;
  segmentId: string;
  campaignId: string;
  userId: string;
  agent_id: string;
  timeframe: string;
  contentType: string;
  targetAudience: string;
  goals: string;
  keywords: string;
}

// Configuración de la API de Copywriter
const CopywriterApi: BaseApiConfig = {
  id: 'copywriter',
  name: 'Content Calendar API',
  description: 'API para generar calendarios de contenido utilizando IA.',
  defaultEndpoint: '/api/agents/copywriter/content-calendar',

  // Obtener el estado inicial
  getInitialState: (props: CopywriterApiProps): CopywriterApiState => {
    return {
      siteId: props.defaultSiteId || '',
      segmentId: props.defaultSegmentId || '',
      campaignId: props.defaultCampaignId || '',
      userId: props.defaultUserId || '',
      agent_id: props.defaultAgentId || '',
      timeframe: props.defaultTimeframe || '',
      contentType: props.defaultContentType || '',
      targetAudience: props.defaultTargetAudience || '',
      goals: props.defaultGoals || '',
      keywords: props.defaultKeywords || ''
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: CopywriterApiState): Record<string, any> => {
    const body: Record<string, any> = {
      siteId: state.siteId,
    };
    
    // Add optional parameters if they have values
    if (state.segmentId) body.segmentId = state.segmentId;
    if (state.campaignId) body.campaignId = state.campaignId;
    if (state.userId) body.userId = state.userId;
    if (state.agent_id) body.agent_id = state.agent_id;
    if (state.timeframe) body.timeframe = state.timeframe;
    if (state.contentType) body.contentType = state.contentType;
    if (state.targetAudience) body.targetAudience = state.targetAudience;
    
    // Parse arrays
    if (state.goals) {
      try {
        body.goals = state.goals.split(',').map(g => g.trim());
      } catch (err) {
        body.goals = [state.goals];
      }
    }
    
    if (state.keywords) {
      try {
        body.keywords = state.keywords.split(',').map(k => k.trim());
      } catch (err) {
        body.keywords = [state.keywords];
      }
    }
    
    return body;
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: CopywriterApiState;
    setState: React.Dispatch<React.SetStateAction<CopywriterApiState>>;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    const handleChange = (field: keyof CopywriterApiState, value: string | boolean) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
        <SectionLabel>Required Fields</SectionLabel>
        
        <FormField
          label="Site ID"
          id="siteId"
          type="text"
          value={state.siteId}
          placeholder="site_123"
          onChange={(value: string) => handleChange('siteId', value)}
          required
        />
        
        <SectionLabel>Optional Fields</SectionLabel>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <FormField
            label="Segment ID"
            id="segmentId"
            type="text"
            value={state.segmentId}
            placeholder="segment_456"
            onChange={(value: string) => handleChange('segmentId', value)}
          />
          
          <FormField
            label="Campaign ID"
            id="campaignId"
            type="text"
            value={state.campaignId}
            placeholder="campaign_789"
            onChange={(value: string) => handleChange('campaignId', value)}
          />
        </div>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <FormField
            label="User ID"
            id="userId"
            type="text"
            value={state.userId}
            placeholder="user_123"
            onChange={(value: string) => handleChange('userId', value)}
          />
          
          <FormField
            label="Agent ID"
            id="agent_id"
            type="text"
            value={state.agent_id}
            placeholder="agent_copywriter_123"
            onChange={(value: string) => handleChange('agent_id', value)}
          />
        </div>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <FormField
            label="Timeframe"
            id="timeframe"
            type="text"
            value={state.timeframe}
            placeholder="week, month, quarter"
            onChange={(value: string) => handleChange('timeframe', value)}
          />
          
          <FormField
            label="Content Type"
            id="contentType"
            type="text"
            value={state.contentType}
            placeholder="blog, social, email"
            onChange={(value: string) => handleChange('contentType', value)}
          />
        </div>
        
        <FormField
          label="Target Audience"
          id="targetAudience"
          type="text"
          value={state.targetAudience}
          placeholder="small business owners"
          onChange={(value: string) => handleChange('targetAudience', value)}
        />
        
        <FormField
          label="Goals (comma-separated)"
          id="goals"
          type="text"
          value={state.goals}
          placeholder="increase engagement, drive traffic"
          onChange={(value: string) => handleChange('goals', value)}
        />
        
        <FormField
          label="Keywords (comma-separated)"
          id="keywords"
          type="text"
          value={state.keywords}
          placeholder="marketing, business, productivity"
          onChange={(value: string) => handleChange('keywords', value)}
        />
      </>
    );
  }
};

export default CopywriterApi; 