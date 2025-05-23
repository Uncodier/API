'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../components/FormComponents';

// Custom styles for the contact-human form
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

// Props for ContactHumanApi
export interface ContactHumanApiProps {
  defaultConversationId?: string;
  defaultAgentId?: string;
  defaultMessage?: string;
  defaultPriority?: string;
  defaultSummary?: string;
  defaultName?: string;
  defaultEmail?: string;
}

// State for ContactHumanApi
export interface ContactHumanApiState {
  conversation_id: string;
  agent_id: string;
  message: string;
  priority: string;
  summary: string;
  name: string;
  email: string;
  jsonResponse: boolean;
  showResponse: boolean;
  loading: boolean;
  error: string | null;
  response: any;
  responseStatus: number;
}

// Configuration for ContactHumanApi
const ContactHumanApi: BaseApiConfig = {
  id: 'contact-human' as any,
  name: 'Contact Human API',
  description: 'API to request human intervention in conversations with team notifications.',
  defaultEndpoint: '/api/agents/tools/contact-human',

  // Get initial state
  getInitialState: (props: ContactHumanApiProps): ContactHumanApiState => {
    return {
      conversation_id: props.defaultConversationId || '',
      agent_id: props.defaultAgentId || '',
      message: props.defaultMessage || 'El usuario necesita ayuda especializada que no puedo proporcionar',
      priority: props.defaultPriority || 'normal',
      summary: props.defaultSummary || '',
      name: props.defaultName || '',
      email: props.defaultEmail || '',
      jsonResponse: false,
      showResponse: false,
      loading: false,
      error: null,
      response: null,
      responseStatus: 0
    };
  },

  // Build request body
  buildRequestBody: (state: ContactHumanApiState): Record<string, any> => {
    const body: Record<string, any> = {
      conversation_id: state.conversation_id,
      message: state.message,
      priority: state.priority
    };

    // Add optional fields if they have values
    if (state.agent_id.trim()) {
      body.agent_id = state.agent_id;
    }
    
    if (state.summary.trim()) {
      body.summary = state.summary;
    }
    
    if (state.name.trim()) {
      body.name = state.name;
    }
    
    if (state.email.trim()) {
      body.email = state.email;
    }

    return body;
  },

  // Render form fields
  renderFields: (props: {
    state: ContactHumanApiState;
    setState: React.Dispatch<React.SetStateAction<ContactHumanApiState>>;
    showJsonOption: boolean;
    additionalFields?: any[];
  }) => {
    const { state, setState, showJsonOption } = props;
    
    const handleChange = (field: keyof ContactHumanApiState, value: string | boolean) => {
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
          label="Conversation ID"
          id="conversation_id"
          type="text"
          value={state.conversation_id}
          placeholder="89a9e1f8-d23f-499d-ab42-606e9bb2c71b"
          onChange={(value: string) => handleChange('conversation_id', value)}
          required
        />
        
        <FormField
          label="Message"
          id="message"
          type="textarea"
          value={state.message}
          placeholder="El usuario tiene problemas técnicos complejos que requieren intervención humana especializada."
          onChange={(value: string) => handleChange('message', value)}
          required
        />
        
        <FormField
          label="Priority"
          id="priority"
          type="select"
          value={state.priority}
          onChange={(value: string) => handleChange('priority', value)}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'normal', label: 'Normal' },
            { value: 'high', label: 'High' },
            { value: 'urgent', label: 'Urgent' }
          ]}
          required
        />
        
        <SectionLabel>Optional Fields</SectionLabel>
        
        <FormField
          label="Agent ID"
          id="agent_id"
          type="text"
          value={state.agent_id}
          placeholder="a6c4e791-8c6d-4a04-b912-9fd71bf4d9c3"
          onChange={(value: string) => handleChange('agent_id', value)}
        />
        
        <FormField
          label="Summary"
          id="summary"
          type="textarea"
          value={state.summary}
          placeholder="Cliente Premium con problemas recurrentes en la API de pagos. Ha intentado las soluciones básicas sin éxito."
          onChange={(value: string) => handleChange('summary', value)}
        />
        
        <FormField
          label="Contact Name"
          id="name"
          type="text"
          value={state.name}
          placeholder="María González"
          onChange={(value: string) => handleChange('name', value)}
        />
        
        <FormField
          label="Contact Email"
          id="email"
          type="text"
          value={state.email}
          placeholder="maria.gonzalez@empresa.com"
          onChange={(value: string) => handleChange('email', value)}
        />

        <div style={{ marginTop: '20px', padding: '12px', backgroundColor: isDarkMode ? '#495057' : '#e9ecef', borderRadius: '4px', fontSize: '14px' }}>
          <strong>💡 Note:</strong> This endpoint will notify all team members who have email notifications enabled in their profile settings (profile.notifications.email === true). 
          Admin users without notification settings will be included by default.
        </div>

        <div style={{ marginTop: '16px', padding: '12px', backgroundColor: isDarkMode ? '#1e3a5f' : '#cff4fc', borderRadius: '4px', fontSize: '14px' }}>
          <strong>📧 Email Behavior:</strong>
          <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>
            <li>Uses SendGrid service for email delivery</li>
            <li>Creates internal notifications in the system</li>
            <li>Generates HTML email with intervention details</li>
            <li>Returns statistics of notifications and emails sent</li>
          </ul>
        </div>
      </div>
    );
  }
};

export default ContactHumanApi; 