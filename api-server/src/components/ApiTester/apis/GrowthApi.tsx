'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props for GrowthApi
export interface GrowthApiProps {
  defaultSiteId?: string;
  defaultAgentId?: string;
  defaultUserId?: string;
  defaultTotalBudget?: number;
  defaultPriority?: string;
  defaultGoals?: string[];
}

// State for GrowthApi
export interface GrowthApiState {
  siteId: string;
  agent_id: string;
  userId: string;
  totalBudget: number;
  currency: string;
  priority: string;
  goals: string;
  segmentIds: string;
  timeframe: string;
  channels: string;
  industries: string;
  competitors: string;
  previousResults: string;
  requirements: string;
  jsonResponse: boolean;
  showResponse: boolean;
  loading: boolean;
  error: string | null;
  response: any;
  responseStatus: number;
}

// Configuration for GrowthApi
const GrowthApi: BaseApiConfig = {
  id: 'growth',
  name: 'Growth Marketing API',
  description: 'API to create and manage marketing campaigns.',
  defaultEndpoint: '/api/agents/growth/campaigns',

  // Get initial state
  getInitialState: (props: GrowthApiProps): GrowthApiState => {
    return {
      showResponse: false,
      jsonResponse: true,
      loading: false,
      error: null,
      response: null,
      responseStatus: 0,
      siteId: props.defaultSiteId || '',
      agent_id: props.defaultAgentId || 'agent_growth_123',
      userId: props.defaultUserId || '',
      totalBudget: props.defaultTotalBudget || 5000,
      currency: 'USD',
      priority: props.defaultPriority || 'high',
      goals: props.defaultGoals ? JSON.stringify(props.defaultGoals) : '["lead_generation", "brand_awareness"]',
      segmentIds: '',
      timeframe: JSON.stringify({
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      }),
      channels: '',
      industries: '',
      competitors: '',
      previousResults: '',
      requirements: ''
    };
  },

  // Build request body
  buildRequestBody: (state: GrowthApiState): Record<string, any> => {
    const body: Record<string, any> = {
      siteId: state.siteId,
      totalBudget: Number(state.totalBudget),
      goals: JSON.parse(state.goals)
    };

    if (state.agent_id) {
      body.agent_id = state.agent_id;
    }

    if (state.userId) {
      body.userId = state.userId;
    }

    if (state.currency) {
      body.currency = state.currency;
    }

    if (state.priority) {
      body.priority = state.priority;
    }

    if (state.segmentIds) {
      try {
        body.segmentIds = JSON.parse(state.segmentIds);
      } catch {
        // Si no es JSON válido, asumimos que es una lista separada por comas
        body.segmentIds = state.segmentIds.split(',').map(id => id.trim());
      }
    }

    if (state.timeframe) {
      try {
        body.timeframe = JSON.parse(state.timeframe);
      } catch {
        // Si no es JSON válido, lo dejamos como está
        body.timeframe = state.timeframe;
      }
    }

    if (state.channels) {
      try {
        body.channels = JSON.parse(state.channels);
      } catch {
        // Si no es JSON válido, asumimos que es una lista separada por comas
        body.channels = state.channels.split(',').map(channel => channel.trim());
      }
    }

    if (state.industries) {
      try {
        body.industries = JSON.parse(state.industries);
      } catch {
        // Si no es JSON válido, asumimos que es una lista separada por comas
        body.industries = state.industries.split(',').map(industry => industry.trim());
      }
    }

    if (state.competitors) {
      try {
        body.competitors = JSON.parse(state.competitors);
      } catch {
        // Si no es JSON válido, asumimos que es una lista separada por comas
        body.competitors = state.competitors.split(',').map(competitor => competitor.trim());
      }
    }

    if (state.previousResults) {
      try {
        body.previousResults = JSON.parse(state.previousResults);
      } catch {
        // Si no es JSON válido, lo dejamos como está
        body.previousResults = state.previousResults;
      }
    }

    if (state.requirements) {
      try {
        body.requirements = JSON.parse(state.requirements);
      } catch {
        // Si no es JSON válido, lo dejamos como está
        body.requirements = state.requirements;
      }
    }

    return body;
  },

  // Render form fields
  renderFields: (props: {
    state: GrowthApiState;
    setState: React.Dispatch<React.SetStateAction<GrowthApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption } = props;
    
    const handleChange = (field: keyof GrowthApiState, value: string | number | boolean) => {
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
          placeholder="site_123456"
          onChange={(value: string) => handleChange('siteId', value)}
          required
        />
        
        <FormField
          label="Total Budget"
          id="totalBudget"
          type="number"
          value={state.totalBudget.toString()}
          placeholder="5000"
          onChange={(value: string) => handleChange('totalBudget', Number(value))}
          required
        />
        
        <FormField
          label="Goals (JSON Array)"
          id="goals"
          type="textarea"
          value={state.goals}
          placeholder='["lead_generation", "brand_awareness"]'
          onChange={(value: string) => handleChange('goals', value)}
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
          placeholder="user_123456"
          onChange={(value: string) => handleChange('userId', value)}
        />
        
        <FormField
          label="Currency"
          id="currency"
          type="text"
          value={state.currency}
          placeholder="USD"
          onChange={(value: string) => handleChange('currency', value)}
        />
        
        <FormField
          label="Priority"
          id="priority"
          type="select"
          value={state.priority}
          options={[
            { value: 'high', label: 'High' },
            { value: 'medium', label: 'Medium' },
            { value: 'low', label: 'Low' }
          ]}
          onChange={(value: string) => handleChange('priority', value)}
        />
        
        <FormField
          label="Segment IDs (JSON Array or comma-separated)"
          id="segmentIds"
          type="text"
          value={state.segmentIds}
          placeholder='["seg_123", "seg_456"] or seg_123,seg_456'
          onChange={(value: string) => handleChange('segmentIds', value)}
        />
        
        <FormField
          label="Timeframe (JSON Object)"
          id="timeframe"
          type="textarea"
          value={state.timeframe}
          placeholder='{"startDate": "2023-08-01", "endDate": "2023-08-31"}'
          onChange={(value: string) => handleChange('timeframe', value)}
        />
        
        <FormField
          label="Channels (JSON Array or comma-separated)"
          id="channels"
          type="text"
          value={state.channels}
          placeholder='["social", "email", "search_ads"] or social,email,search_ads'
          onChange={(value: string) => handleChange('channels', value)}
        />
        
        <FormField
          label="Industries (JSON Array or comma-separated)"
          id="industries"
          type="text"
          value={state.industries}
          placeholder='["software", "b2b"] or software,b2b'
          onChange={(value: string) => handleChange('industries', value)}
        />
        
        <FormField
          label="Competitors (JSON Array or comma-separated)"
          id="competitors"
          type="text"
          value={state.competitors}
          placeholder='["competitor1.com", "competitor2.com"] or competitor1.com,competitor2.com'
          onChange={(value: string) => handleChange('competitors', value)}
        />
        
        <FormField
          label="Previous Results (JSON Object)"
          id="previousResults"
          type="textarea"
          value={state.previousResults}
          placeholder='{"avg_cpc": 1.85, "conversion_rate": 2.3, "email_open_rate": 22.5}'
          onChange={(value: string) => handleChange('previousResults', value)}
        />
        
        <FormField
          label="Requirements (JSON Array)"
          id="requirements"
          type="textarea"
          value={state.requirements}
          placeholder='[{"title": "Product Launch", "description": "Focus on new product", "instructions": "Highlight features", "budget": 1500}]'
          onChange={(value: string) => handleChange('requirements', value)}
        />
      </>
    );
  }
};

export default GrowthApi; 