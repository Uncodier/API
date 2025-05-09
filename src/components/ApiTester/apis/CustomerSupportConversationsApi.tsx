'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props for CustomerSupportConversationsApi
export interface CustomerSupportConversationsApiProps {
  defaultLeadId?: string;
  defaultVisitorId?: string;
  defaultUserId?: string;
  defaultSiteId?: string;
  defaultLimit?: string;
  defaultOffset?: string;
  defaultMethod?: string;
}

// State for CustomerSupportConversationsApi
export interface CustomerSupportConversationsApiState {
  lead_id: string;
  visitor_id: string;
  user_id: string;
  site_id: string;
  limit: string;
  offset: string;
  method: string;
  jsonResponse: boolean;
  showResponse: boolean;
  loading: boolean;
  error: string | null;
  response: any;
  responseStatus: number;
}

// Configuration for CustomerSupportConversationsApi
const CustomerSupportConversationsApi: BaseApiConfig = {
  id: 'customer-support-conversations',
  name: 'Customer Support Conversations API',
  description: 'API to retrieve customer support conversations by lead ID, visitor ID, or user ID.',
  defaultEndpoint: '/api/agents/customerSupport/conversations',

  // Get initial state
  getInitialState: (props: CustomerSupportConversationsApiProps): CustomerSupportConversationsApiState => {
    return {
      showResponse: false,
      jsonResponse: true,
      loading: false,
      error: null,
      response: null,
      responseStatus: 0,
      lead_id: props.defaultLeadId || '',
      visitor_id: props.defaultVisitorId || '',
      user_id: props.defaultUserId || '',
      site_id: props.defaultSiteId || '',
      limit: props.defaultLimit || '10',
      offset: props.defaultOffset || '0',
      method: props.defaultMethod || 'GET'
    };
  },

  // Build request body - not used for GET requests but required by interface
  buildRequestBody: (state: CustomerSupportConversationsApiState): Record<string, any> => {
    return {};
  },

  // Build request URL with query parameters
  buildRequestUrl: (state: CustomerSupportConversationsApiState, baseUrl: string): string => {
    const params = new URLSearchParams();
    
    if (state.lead_id) {
      params.append('lead_id', state.lead_id);
    }
    
    if (state.visitor_id) {
      params.append('visitor_id', state.visitor_id);
    }
    
    if (state.user_id) {
      params.append('user_id', state.user_id);
    }
    
    if (state.site_id) {
      params.append('site_id', state.site_id);
    }
    
    if (state.limit) {
      params.append('limit', state.limit);
    }
    
    if (state.offset) {
      params.append('offset', state.offset);
    }
    
    return `${baseUrl}?${params.toString()}`;
  },

  // Render form fields
  renderFields: (props: {
    state: CustomerSupportConversationsApiState;
    setState: React.Dispatch<React.SetStateAction<CustomerSupportConversationsApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption } = props;
    
    const handleChange = (field: keyof CustomerSupportConversationsApiState, value: string | boolean) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    const handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      setState(prev => ({ ...prev, loading: true, error: null, showResponse: false }));

      try {
        // Build the URL with query parameters
        let url = '/api/agents/customerSupport/conversations';
        const params = new URLSearchParams();
        
        if (state.lead_id) {
          params.append('lead_id', state.lead_id);
        }
        
        if (state.visitor_id) {
          params.append('visitor_id', state.visitor_id);
        }
        
        if (state.user_id) {
          params.append('user_id', state.user_id);
        }
        
        if (state.site_id) {
          params.append('site_id', state.site_id);
        }
        
        if (state.limit) {
          params.append('limit', state.limit);
        }
        
        if (state.offset) {
          params.append('offset', state.offset);
        }
        
        url = `${url}?${params.toString()}`;
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          }
        });

        const data = await response.json();
        
        setState(prev => ({
          ...prev,
          loading: false,
          response: data,
          showResponse: true,
          responseStatus: response.status
        }));
      } catch (error) {
        console.error('Error al obtener conversaciones:', error);
        setState(prev => ({
          ...prev,
          loading: false,
          error: 'Error al obtener las conversaciones',
          showResponse: false
        }));
      }
    };

    return (
      <>
        <SectionLabel>Filter by (at least one required)</SectionLabel>
        
        <FormField
          label="Lead ID"
          id="lead_id"
          type="text"
          value={state.lead_id}
          placeholder="lead_123456"
          onChange={(value: string) => handleChange('lead_id', value)}
        />
        
        <FormField
          label="Visitor ID"
          id="visitor_id"
          type="text"
          value={state.visitor_id}
          placeholder="visitor_123456"
          onChange={(value: string) => handleChange('visitor_id', value)}
        />
        
        <FormField
          label="User ID"
          id="user_id"
          type="text"
          value={state.user_id}
          placeholder="user_123456"
          onChange={(value: string) => handleChange('user_id', value)}
        />
        
        <FormField
          label="Site ID"
          id="site_id"
          type="text"
          value={state.site_id}
          placeholder="site_123456"
          onChange={(value: string) => handleChange('site_id', value)}
        />
        
        <SectionLabel>Pagination</SectionLabel>
        
        <FormField
          label="Limit"
          id="limit"
          type="number"
          value={state.limit}
          placeholder="10"
          onChange={(value: string) => handleChange('limit', value)}
        />
        
        <FormField
          label="Offset"
          id="offset"
          type="number"
          value={state.offset}
          placeholder="0"
          onChange={(value: string) => handleChange('offset', value)}
        />
      </>
    );
  }
};

export default CustomerSupportConversationsApi; 