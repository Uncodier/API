'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Props for ChatApi
export interface ChatApiProps {
  defaultAgentId?: string;
  defaultConversationId?: string;
  defaultMessage?: string;
  defaultLeadId?: string;
  defaultVisitorId?: string;
}

// State for ChatApi
export interface ChatApiState {
  agentId: string;
  conversationId: string;
  message: string;
  lead_id: string;
  visitor_id: string;
  jsonResponse: boolean;
  showResponse: boolean;
  loading: boolean;
  error: string | null;
  response: any;
  responseStatus: number;
}

// Configuration for ChatApi
const ChatApi: BaseApiConfig = {
  id: 'chat',
  name: 'Chat API',
  description: 'API to handle interactions with any agent type.',
  defaultEndpoint: '/api/agents/chat/message',

  // Get initial state
  getInitialState: (props: ChatApiProps): ChatApiState => {
    return {
      agentId: props.defaultAgentId || '',
      conversationId: props.defaultConversationId || '',
      message: props.defaultMessage || '',
      lead_id: props.defaultLeadId || '',
      visitor_id: props.defaultVisitorId || '',
      jsonResponse: false,
      showResponse: false,
      loading: false,
      error: null,
      response: null,
      responseStatus: 0
    };
  },

  // Build request body
  buildRequestBody: (state: ChatApiState): Record<string, any> => {
    const body: Record<string, any> = {
      message: state.message,
      agentId: state.agentId
    };

    if (state.conversationId) {
      body.conversationId = state.conversationId;
    }
    
    if (state.lead_id) {
      body.lead_id = state.lead_id;
    }
    
    if (state.visitor_id) {
      body.visitor_id = state.visitor_id;
    }

    return body;
  },

  // Render form fields
  renderFields: (props: {
    state: ChatApiState;
    setState: React.Dispatch<React.SetStateAction<ChatApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption } = props;
    
    const handleChange = (field: keyof ChatApiState, value: string | boolean) => {
      setState(prev => ({ ...prev, [field]: value }));
    };
    
    return (
      <>
        <SectionLabel>Required Fields</SectionLabel>
        
        <FormField
          label="Agent ID"
          id="agentId"
          type="text"
          value={state.agentId}
          placeholder="agent_marketing_123"
          onChange={(value: string) => handleChange('agentId', value)}
          required
        />
        
        <FormField
          label="Message"
          id="message"
          type="textarea"
          value={state.message}
          placeholder="Can you analyze this marketing data for me?"
          onChange={(value: string) => handleChange('message', value)}
          required
        />
        
        <SectionLabel>Optional Fields</SectionLabel>
        
        <FormField
          label="Conversation ID"
          id="conversationId"
          type="text"
          value={state.conversationId}
          placeholder="conv_123456"
          onChange={(value: string) => handleChange('conversationId', value)}
        />
        
        <FormField
          label="Lead ID"
          id="lead_id"
          type="text"
          value={state.lead_id}
          placeholder="lead_456"
          onChange={(value: string) => handleChange('lead_id', value)}
        />
        
        <FormField
          label="Visitor ID"
          id="visitor_id"
          type="text"
          value={state.visitor_id}
          placeholder="visitor_789"
          onChange={(value: string) => handleChange('visitor_id', value)}
        />
      </>
    );
  }
};

export default ChatApi; 