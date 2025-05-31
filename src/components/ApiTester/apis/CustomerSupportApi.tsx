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
  defaultVisitorId?: string;
  defaultLeadId?: string;
  defaultName?: string;
  defaultEmail?: string;
  defaultPhone?: string;
  defaultLeadNotification?: string;
}

// State for CustomerSupportApi
export interface CustomerSupportApiState {
  userId: string;
  agentId: string;
  conversationId: string;
  message: string;
  site_id: string;
  visitor_id: string;
  lead_id: string;
  name: string;
  email: string;
  phone: string;
  lead_notification: string;
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
      site_id: props.defaultSiteId || '',
      visitor_id: props.defaultVisitorId || '',
      lead_id: props.defaultLeadId || '',
      name: props.defaultName || '',
      email: props.defaultEmail || '',
      phone: props.defaultPhone || '',
      lead_notification: props.defaultLeadNotification || 'none'
    };
  },

  // Build request body
  buildRequestBody: (state: CustomerSupportApiState): Record<string, any> => {
    const body: Record<string, any> = {
      message: state.message
    };

    // Solo añadir userId si tiene valor
    if (state.userId) {
      body.userId = state.userId;
    }

    if (state.conversationId) {
      body.conversationId = state.conversationId;
    }
    
    if (state.agentId) {
      body.agentId = state.agentId;
    }

    if (state.site_id) {
      body.site_id = state.site_id;
    }

    if (state.visitor_id) {
      body.visitor_id = state.visitor_id;
    }

    if (state.lead_id) {
      body.lead_id = state.lead_id;
    }

    // Agregar campos de información de lead
    if (state.name) {
      body.name = state.name;
    }

    if (state.email) {
      body.email = state.email;
    }

    if (state.phone) {
      body.phone = state.phone;
    }

    // Agregar lead_notification si no es 'none'
    if (state.lead_notification && state.lead_notification !== 'none') {
      body.lead_notification = state.lead_notification;
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
        // Construir body del request
        const requestBody: Record<string, any> = {
          message: state.message
        };

        // Solo añadir campos que tienen valor
        if (state.userId) requestBody.userId = state.userId;
        if (state.visitor_id) requestBody.visitor_id = state.visitor_id;
        if (state.lead_id) requestBody.lead_id = state.lead_id;
        if (state.conversationId) requestBody.conversationId = state.conversationId;
        if (state.agentId) requestBody.agentId = state.agentId;
        if (state.site_id) requestBody.site_id = state.site_id;
        if (state.name) requestBody.name = state.name;
        if (state.email) requestBody.email = state.email;
        if (state.phone) requestBody.phone = state.phone;
        if (state.lead_notification && state.lead_notification !== 'none') {
          requestBody.lead_notification = state.lead_notification;
        }

        // Validar que userId sea requerido
        if (!requestBody.userId) {
          setState(prev => ({
            ...prev,
            loading: false,
            error: 'El campo User ID es requerido',
            showResponse: false
          }));
          return;
        }

        const response = await fetch('/api/agents/customerSupport/message', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
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
          label="Message"
          id="message"
          type="textarea"
          value={state.message}
          placeholder="I need help with my recent order"
          onChange={(value: string) => handleChange('message', value)}
          required
        />

        <FormField
          label="User ID"
          id="userId"
          type="text"
          value={state.userId}
          placeholder="user_123"
          onChange={(value: string) => handleChange('userId', value)}
          required
        />

        <SectionLabel>Identification (optional)</SectionLabel>

        <FormField
          label="Visitor ID"
          id="visitor_id"
          type="text"
          value={state.visitor_id}
          placeholder="visitor_123456"
          onChange={(value: string) => handleChange('visitor_id', value)}
        />
        
        <FormField
          label="Lead ID"
          id="lead_id"
          type="text"
          value={state.lead_id}
          placeholder="lead_123456"
          onChange={(value: string) => handleChange('lead_id', value)}
        />

        <SectionLabel>Lead Information (for lead creation/lookup)</SectionLabel>

        <FormField
          label="Name"
          id="name"
          type="text"
          value={state.name}
          placeholder="John Doe"
          onChange={(value: string) => handleChange('name', value)}
        />

        <FormField
          label="Email"
          id="email"
          type="text"
          value={state.email}
          placeholder="john.doe@example.com"
          onChange={(value: string) => handleChange('email', value)}
        />

        <FormField
          label="Phone"
          id="phone"
          type="text"
          value={state.phone}
          placeholder="+1234567890"
          onChange={(value: string) => handleChange('phone', value)}
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

        <FormField
          label="Lead Notification"
          id="lead_notification"
          type="select"
          value={state.lead_notification}
          onChange={(value: string) => handleChange('lead_notification', value)}
          options={[
            { value: 'none', label: 'None (no notifications)' },
            { value: 'email', label: 'Email notification' }
          ]}
        />
      </>
    );
  }
};

export default CustomerSupportApi; 