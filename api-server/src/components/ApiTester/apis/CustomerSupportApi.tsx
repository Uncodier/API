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
}

// State for CustomerSupportApi
export interface CustomerSupportApiState {
  userId: string;
  agentId: string;
  conversationId: string;
  message: string;
  jsonResponse: boolean;
  showLogs: boolean;
}

// Configuration for CustomerSupportApi
const CustomerSupportApi: BaseApiConfig = {
  id: 'customer-support',
  name: 'Customer Support API',
  description: 'API to handle customer support interactions. Enable "Show logs" and check browser console (F12) to see request details.',
  defaultEndpoint: '/api/agents/customerSupport/message',

  // Get initial state
  getInitialState: (props: CustomerSupportApiProps): CustomerSupportApiState => {
    return {
      userId: props.defaultUserId || '',
      agentId: props.defaultAgentId || '',
      conversationId: props.defaultConversationId || '',
      message: props.defaultMessage || '',
      jsonResponse: false,
      showLogs: true
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

    // Log the request body
    if (state.showLogs) {
      console.log('Customer Support API Request:', body);
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
          label="Show request logs in console (F12)"
          id="showLogs"
          type="checkbox"
          value={state.showLogs}
          onChange={(value: boolean) => handleChange('showLogs', value)}
        />
      </>
    );
  }
};

export default CustomerSupportApi; 