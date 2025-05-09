'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Custom styles for the intervention form
const styles = {
  formContainer: {
    border: '1px solid #adb5bd',
    borderRadius: '6px',
    padding: '16px',
    marginBottom: '16px',
    backgroundColor: '#f8f9fa'
  },
  darkModeContainer: {
    border: '1px solid #495057',
    backgroundColor: '#212529'
  }
};

// Props for InterventionApi
export interface InterventionApiProps {
  defaultAgentId?: string;
  defaultConversationId?: string;
  defaultMessage?: string;
  defaultUserId?: string;
  defaultConversationTitle?: string;
  defaultLeadId?: string;
  defaultVisitorId?: string;
  defaultSiteId?: string;
}

// State for InterventionApi
export interface InterventionApiState {
  agentId: string;
  conversationId: string;
  message: string;
  user_id: string;
  conversation_title: string;
  lead_id: string;
  visitor_id: string;
  site_id: string;
  jsonResponse: boolean;
  showResponse: boolean;
  loading: boolean;
  error: string | null;
  response: any;
  responseStatus: number;
}

// Configuration for InterventionApi
const InterventionApi: BaseApiConfig = {
  id: 'intervention',
  name: 'Intervention API',
  description: 'API to record team member interventions in agent conversations.',
  defaultEndpoint: '/api/agents/chat/intervention',

  // Get initial state
  getInitialState: (props: InterventionApiProps): InterventionApiState => {
    return {
      agentId: props.defaultAgentId || '',
      conversationId: props.defaultConversationId || '',
      message: props.defaultMessage || '',
      user_id: props.defaultUserId || '',
      conversation_title: props.defaultConversationTitle || '',
      lead_id: props.defaultLeadId || '',
      visitor_id: props.defaultVisitorId || '',
      site_id: props.defaultSiteId || '',
      jsonResponse: false,
      showResponse: false,
      loading: false,
      error: null,
      response: null,
      responseStatus: 0
    };
  },

  // Build request body
  buildRequestBody: (state: InterventionApiState): Record<string, any> => {
    const body: Record<string, any> = {
      message: state.message,
      agentId: state.agentId,
      user_id: state.user_id
    };

    if (state.conversationId) {
      body.conversationId = state.conversationId;
    }
    
    if (state.conversation_title) {
      body.conversation_title = state.conversation_title;
    }
    
    if (state.lead_id) {
      body.lead_id = state.lead_id;
    }
    
    if (state.visitor_id) {
      body.visitor_id = state.visitor_id;
    }
    
    if (state.site_id) {
      body.site_id = state.site_id;
    }

    return body;
  },

  // Render form fields
  renderFields: (props: {
    state: InterventionApiState;
    setState: React.Dispatch<React.SetStateAction<InterventionApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption } = props;
    
    const handleChange = (field: keyof InterventionApiState, value: string | boolean) => {
      setState(prev => ({ ...prev, [field]: value }));
    };

    // Check if we're in dark mode
    const isDarkMode = typeof window !== 'undefined' && 
      document.documentElement.classList.contains('dark');
    
    const containerStyle = {
      ...styles.formContainer,
      ...(isDarkMode ? styles.darkModeContainer : {})
    };
    
    return (
      <div style={containerStyle}>
        <SectionLabel>Required Fields</SectionLabel>
        
        <FormField
          label="User ID"
          id="user_id"
          type="text"
          value={state.user_id}
          placeholder="00000000-0000-0000-0000-000000000000"
          onChange={(value: string) => handleChange('user_id', value)}
          required
        />
        
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
          label="Team Member Message"
          id="message"
          type="textarea"
          value={state.message}
          placeholder="Let me help with your marketing strategy. We could focus on digital campaigns for Q3."
          onChange={(value: string) => handleChange('message', value)}
          required
        />
        
        <FormField
          label="Conversation ID"
          id="conversationId"
          type="text"
          value={state.conversationId}
          placeholder="conv_123456"
          onChange={(value: string) => handleChange('conversationId', value)}
          required
        />
        
        <SectionLabel>Optional Fields</SectionLabel>
        
        <FormField
          label="Conversation Title"
          id="conversation_title"
          type="text"
          value={state.conversation_title}
          placeholder="Marketing Strategy Assistance"
          onChange={(value: string) => handleChange('conversation_title', value)}
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
        
        <FormField
          label="Site ID"
          id="site_id"
          type="text"
          value={state.site_id}
          placeholder="site_abc123"
          onChange={(value: string) => handleChange('site_id', value)}
        />
      </div>
    );
  }
};

export default InterventionApi; 