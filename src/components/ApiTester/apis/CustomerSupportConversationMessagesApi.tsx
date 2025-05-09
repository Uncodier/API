'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props for CustomerSupportConversationMessagesApi
export interface CustomerSupportConversationMessagesApiProps {
  defaultConversationId?: string;
  defaultSiteId?: string;
  defaultLimit?: string;
  defaultOffset?: string;
  defaultMethod?: string;
}

// State for CustomerSupportConversationMessagesApi
export interface CustomerSupportConversationMessagesApiState {
  conversation_id: string;
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

// Configuration for CustomerSupportConversationMessagesApi
const CustomerSupportConversationMessagesApi: BaseApiConfig = {
  id: 'customer-support-conversation-messages',
  name: 'Customer Support Conversation Messages API',
  description: 'API to retrieve messages from a specific customer support conversation.',
  defaultEndpoint: '/api/agents/customerSupport/conversations/messages',

  // Get initial state
  getInitialState: (props: CustomerSupportConversationMessagesApiProps): CustomerSupportConversationMessagesApiState => {
    return {
      showResponse: false,
      jsonResponse: true,
      loading: false,
      error: null,
      response: null,
      responseStatus: 0,
      conversation_id: props.defaultConversationId || '',
      site_id: props.defaultSiteId || '',
      limit: props.defaultLimit || '50',
      offset: props.defaultOffset || '0',
      method: props.defaultMethod || 'GET'
    };
  },

  // Build request body - not used for GET requests but required by interface
  buildRequestBody: (state: CustomerSupportConversationMessagesApiState): Record<string, any> => {
    return {};
  },

  // Build request URL with query parameters
  buildRequestUrl: (state: CustomerSupportConversationMessagesApiState, baseUrl: string): string => {
    const params = new URLSearchParams();
    
    if (state.conversation_id) {
      params.append('conversation_id', state.conversation_id);
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
    state: CustomerSupportConversationMessagesApiState;
    setState: React.Dispatch<React.SetStateAction<CustomerSupportConversationMessagesApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption } = props;
    
    const handleChange = (field: keyof CustomerSupportConversationMessagesApiState, value: string | boolean) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    const handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      setState(prev => ({ ...prev, loading: true, error: null, showResponse: false }));

      try {
        // Build the URL with query parameters
        let url = '/api/agents/customerSupport/conversations/messages';
        const params = new URLSearchParams();
        
        if (state.conversation_id) {
          params.append('conversation_id', state.conversation_id);
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
        console.error('Error al obtener mensajes:', error);
        setState(prev => ({
          ...prev,
          loading: false,
          error: 'Error al obtener los mensajes de la conversación',
          showResponse: false
        }));
      }
    };

    return (
      <>
        <SectionLabel>Required Parameters</SectionLabel>
        
        <FormField
          label="Conversation ID"
          id="conversation_id"
          type="text"
          value={state.conversation_id}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          onChange={(value: string) => handleChange('conversation_id', value)}
        />
        
        <FormField
          label="Site ID"
          id="site_id"
          type="text"
          value={state.site_id}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          onChange={(value: string) => handleChange('site_id', value)}
        />
        
        <SectionLabel>Pagination</SectionLabel>
        
        <FormField
          label="Limit"
          id="limit"
          type="number"
          value={state.limit}
          placeholder="50"
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

export default CustomerSupportConversationMessagesApi; 