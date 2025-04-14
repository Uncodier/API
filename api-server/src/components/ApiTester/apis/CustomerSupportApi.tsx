'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props for CustomerSupportApi
export interface CustomerSupportApiProps {
  defaultUserId?: string;
  defaultAgentId?: string;
  defaultConversationId?: string;
  defaultMessage?: string;
  defaultSiteId?: string;
}

// State for CustomerSupportApi
export interface CustomerSupportApiState {
  userId: string;
  agentId: string;
  conversationId: string;
  message: string;
  site_id: string;
  jsonResponse: boolean;
  showResponse: boolean;
  loading: boolean;
  error: string | null;
  response: any;
  responseStatus: number;
}

// Configuration for CustomerSupportApi
const CustomerSupportApi: BaseApiConfig = {
  id: 'customer-support',
  name: 'Customer Support API',
  description: 'API to handle customer support interactions.',
  defaultEndpoint: '/api/agents/customerSupport/message',

  // Get initial state
  getInitialState: (props: CustomerSupportApiProps): CustomerSupportApiState => {
    return {
      showResponse: false,
      jsonResponse: true,
      loading: false,
      error: null,
      response: null,
      responseStatus: 0,
      userId: props.defaultUserId || '',
      agentId: props.defaultAgentId || 'default_customer_support_agent',
      conversationId: props.defaultConversationId || '',
      message: props.defaultMessage || '',
      site_id: props.defaultSiteId || ''
    };
  },

  // Build request body
  buildRequestBody: (state: CustomerSupportApiState): Record<string, any> => {
    const body: Record<string, any> = {
      userId: state.userId,
      message: state.message
    };

    if (state.conversationId) {
      body.conversationId = state.conversationId;
    }
    
    if (state.agentId) {
      body.agentId = state.agentId;
    }

    if (state.site_id) {
      body.site_id = state.site_id;
    }

    return body;
  },

  // Render form fields
  renderFields: (props: {
    state: CustomerSupportApiState;
    setState: React.Dispatch<React.SetStateAction<CustomerSupportApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption } = props;
    
    const handleChange = (field: keyof CustomerSupportApiState, value: string | boolean) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    const handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      setState(prev => ({ ...prev, loading: true, error: null, showResponse: false }));

      try {
        const response = await fetch('/api/agents/customerSupport/message', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: state.userId,
            agentId: state.agentId,
            conversationId: state.conversationId || undefined,
            message: state.message,
            site_id: state.site_id || undefined
          }),
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
        console.error('Error al enviar mensaje:', error);
        setState(prev => ({
          ...prev,
          loading: false,
          error: 'Error al enviar el mensaje',
          showResponse: false
        }));
      }
    };

    return (
      <>
        <SectionLabel>Required Fields</SectionLabel>
        
        <FormField
          label="User ID"
          id="userId"
          type="text"
          value={state.userId}
          placeholder="user_123"
          onChange={(value: string) => handleChange('userId', value)}
          required
        />
        
        <FormField
          label="Message"
          id="message"
          type="textarea"
          value={state.message}
          placeholder="I need help with my recent order"
          onChange={(value: string) => handleChange('message', value)}
          required
        />
        
        <SectionLabel>Optional Fields</SectionLabel>
        
        <FormField
          label="Agent ID"
          id="agentId"
          type="text"
          value={state.agentId}
          placeholder="agent_support_123"
          onChange={(value: string) => handleChange('agentId', value)}
        />
        
        <FormField
          label="Conversation ID"
          id="conversationId"
          type="text"
          value={state.conversationId}
          placeholder="conv_123456"
          onChange={(value: string) => handleChange('conversationId', value)}
        />
        
        <FormField
          label="Site ID"
          id="site_id"
          type="text"
          value={state.site_id}
          placeholder="site_123456"
          onChange={(value: string) => handleChange('site_id', value)}
        />
      </>
    );
  }
};

export default CustomerSupportApi; 