import React from 'react';
import { BaseApiConfig } from '../types';

interface FormFieldProps {
  label: string;
  id: string;
  type: string;
  value: any;
  onChange: (value: any) => void;
  placeholder?: string;
  required?: boolean;
  rows?: number;
  options?: Array<{value: string, label: string}>;
  readOnly?: boolean;
}

// Componente FormField simplificado
const FormField: React.FC<FormFieldProps> = ({ 
  label, 
  id, 
  type, 
  value, 
  onChange, 
  placeholder, 
  required,
  rows = 3,
  options = [],
  readOnly = false
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    onChange(e.target.value);
  };

  return (
    <div style={{ marginBottom: '16px' }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: '4px', fontWeight: 'medium' }}>
        {label} {required && <span style={{ color: 'red' }}>*</span>}
      </label>
      
      {type === 'textarea' ? (
        <textarea
          id={id}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          required={required}
          rows={rows}
          readOnly={readOnly}
          style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
        />
      ) : type === 'select' ? (
        <select
          id={id}
          value={value}
          onChange={handleChange}
          required={required}
          disabled={readOnly}
          style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          required={required}
          readOnly={readOnly}
          style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
        />
      )}
    </div>
  );
};

interface SalesApiStateProps {
  state: Record<string, any>;
  setState: (updatedFields: Record<string, any>) => void;
  showJsonOption?: boolean;
  showScreenshotOption?: boolean;
  showModelOptions?: boolean;
  showAnalysisTypeField?: boolean;
  showSiteUrlField?: boolean;
  showUrlField?: boolean;
  additionalFields?: any[];
}

interface ApiDefaults {
  defaultMethod?: string;
  defaultEndpoint?: string;
  [key: string]: any;
}

const SalesApi: BaseApiConfig = {
  id: 'sales',
  name: 'Sales API',
  description: 'API para gestionar operaciones de ventas como generación de leads y seguimiento',
  defaultEndpoint: '/api/agents/sales/leadFollowUp',

  getInitialState: (defaults: ApiDefaults) => {
    const endpoint = defaults.defaultEndpoint || '/api/agents/sales/leadFollowUp';
    const isLeadFollowUp = endpoint.includes('leadFollowUp');
    
    if (isLeadFollowUp) {
      return {
        method: defaults.defaultMethod || 'POST',
        endpoint: endpoint,
        siteId: '',
        leadId: '',
        userId: '',
        agent_id: '',
        visitorId: '',
        followUpType: '',
        leadStage: '',
        previousInteractions: '',
        leadData: '',
        productInterest: '',
        followUpInterval: '',
        phone_number: ''
      };
    } else {
      // Legacy support for leadGeneration endpoint
      return {
        method: defaults.defaultMethod || 'POST',
        endpoint: endpoint,
        siteId: '',
        websiteUrl: '',
        agent_id: '',
        leadCaptureMechanism: 'form',
        maxGenerationCount: 3,
        priority: 'medium'
      };
    }
  },

  buildRequestBody: (state: Record<string, any>) => {
    const isLeadFollowUp = state.endpoint?.includes('leadFollowUp') || false;
    
    if (isLeadFollowUp) {
      let requestBody: Record<string, any> = {
        siteId: state.siteId,
        leadId: state.leadId
      };

      // Add optional fields only if they have values
      if (state.userId) requestBody.userId = state.userId;
      if (state.agent_id) requestBody.agent_id = state.agent_id;
      if (state.visitorId) requestBody.visitorId = state.visitorId;
      if (state.followUpType) requestBody.followUpType = state.followUpType;
      if (state.leadStage) requestBody.leadStage = state.leadStage;
      if (state.followUpInterval) requestBody.followUpInterval = state.followUpInterval;
      if (state.phone_number) requestBody.phone_number = state.phone_number;

      // Parse JSON fields if provided
      if (state.previousInteractions) {
        try {
          requestBody.previousInteractions = typeof state.previousInteractions === 'string' 
            ? JSON.parse(state.previousInteractions) 
            : state.previousInteractions;
        } catch (e) {
          // If parsing fails, try as array string
          if (state.previousInteractions.trim().startsWith('[')) {
            requestBody.previousInteractions = JSON.parse(state.previousInteractions);
          }
        }
      }

      if (state.leadData) {
        try {
          requestBody.leadData = typeof state.leadData === 'string' 
            ? JSON.parse(state.leadData) 
            : state.leadData;
        } catch (e) {
          // If parsing fails, ignore
        }
      }

      if (state.productInterest) {
        try {
          requestBody.productInterest = typeof state.productInterest === 'string' 
            ? JSON.parse(state.productInterest) 
            : state.productInterest;
        } catch (e) {
          // If parsing fails, try as array string
          if (state.productInterest.trim().startsWith('[')) {
            requestBody.productInterest = JSON.parse(state.productInterest);
          }
        }
      }

      return requestBody;
    } else {
      // Legacy support for leadGeneration endpoint
      let requestBody: Record<string, any> = {
        siteId: state.siteId,
        websiteUrl: state.websiteUrl
      };

      if (state.agent_id) requestBody.agent_id = state.agent_id;
      if (state.leadCaptureMechanism) requestBody.leadCaptureMechanism = state.leadCaptureMechanism;
      if (state.maxGenerationCount) requestBody.maxGenerationCount = Number(state.maxGenerationCount);
      if (state.priority) requestBody.priority = state.priority;

      return requestBody;
    }
  },

  renderFields: ({ state, setState }: SalesApiStateProps) => {
    const isLeadFollowUp = state.endpoint?.includes('leadFollowUp') || false;
    
    if (isLeadFollowUp) {
      return (
        <>
          <FormField
            label="Site ID"
            id="siteId"
            type="text"
            value={state.siteId}
            onChange={(value) => setState({ siteId: value })}
            placeholder="UUID of the website where the lead originated"
            required
          />

          <FormField
            label="Lead ID"
            id="leadId"
            type="text"
            value={state.leadId}
            onChange={(value) => setState({ leadId: value })}
            placeholder="UUID of the lead to follow up with"
            required
          />

          <FormField
            label="User ID"
            id="userId"
            type="text"
            value={state.userId}
            onChange={(value) => setState({ userId: value })}
            placeholder="UUID of the sales representative (optional)"
          />

          <FormField
            label="Agent ID"
            id="agent_id"
            type="text"
            value={state.agent_id}
            onChange={(value) => setState({ agent_id: value })}
            placeholder="UUID of the agent to handle the follow-up (optional)"
          />

          <FormField
            label="Visitor ID"
            id="visitorId"
            type="text"
            value={state.visitorId}
            onChange={(value) => setState({ visitorId: value })}
            placeholder="UUID of the visitor (optional)"
          />

          <FormField
            label="Follow-up Type"
            id="followUpType"
            type="text"
            value={state.followUpType}
            onChange={(value) => setState({ followUpType: value })}
            placeholder="Type of follow-up (e.g., email, call, meeting)"
          />

          <FormField
            label="Lead Stage"
            id="leadStage"
            type="text"
            value={state.leadStage}
            onChange={(value) => setState({ leadStage: value })}
            placeholder="Current stage of the lead in the sales pipeline"
          />

          <FormField
            label="Previous Interactions"
            id="previousInteractions"
            type="textarea"
            value={state.previousInteractions}
            onChange={(value) => setState({ previousInteractions: value })}
            placeholder='Array of previous interactions (JSON format, e.g., [{"date": "2024-04-15", "type": "email", "summary": "Initial contact"}]'
            rows={4}
          />

          <FormField
            label="Lead Data"
            id="leadData"
            type="textarea"
            value={state.leadData}
            onChange={(value) => setState({ leadData: value })}
            placeholder='Additional lead data (JSON format, e.g., {"name": "Jane Smith", "company": "Acme Inc.", "pain_points": ["time-consuming content creation"]})'
            rows={4}
          />

          <FormField
            label="Product Interest"
            id="productInterest"
            type="textarea"
            value={state.productInterest}
            onChange={(value) => setState({ productInterest: value })}
            placeholder='Array of products or services (JSON format, e.g., ["content automation", "analytics dashboard"])'
            rows={3}
          />

          <FormField
            label="Follow-up Interval"
            id="followUpInterval"
            type="text"
            value={state.followUpInterval}
            onChange={(value) => setState({ followUpInterval: value })}
            placeholder="Desired interval for follow-ups (e.g., 3 days, 1 week)"
          />

          <FormField
            label="Phone Number"
            id="phone_number"
            type="text"
            value={state.phone_number}
            onChange={(value) => setState({ phone_number: value })}
            placeholder="Phone number for WhatsApp (optional, must be valid with at least 7 digits)"
          />
        </>
      );
    } else {
      // Legacy support for leadGeneration endpoint
      return (
        <>
          <FormField
            label="Site ID"
            id="siteId"
            type="text"
            value={state.siteId}
            onChange={(value) => setState({ siteId: value })}
            placeholder="ID del sitio web"
            required
          />

          <FormField
            label="Website URL"
            id="websiteUrl"
            type="text"
            value={state.websiteUrl}
            onChange={(value) => setState({ websiteUrl: value })}
            placeholder="URL del sitio web"
            required
          />

          <FormField
            label="Agent ID"
            id="agent_id"
            type="text"
            value={state.agent_id}
            onChange={(value) => setState({ agent_id: value })}
            placeholder="ID del agente para manejar la generación (opcional)"
          />

          <FormField
            label="Lead Capture Mechanism"
            id="leadCaptureMechanism"
            type="select"
            value={state.leadCaptureMechanism}
            onChange={(value) => setState({ leadCaptureMechanism: value })}
            options={[
              { value: 'form', label: 'Form' },
              { value: 'chatbot', label: 'Chatbot' },
              { value: 'popup', label: 'Popup' },
              { value: 'embedded', label: 'Embedded Widget' },
              { value: 'landing_page', label: 'Landing Page' }
            ]}
          />

          <FormField
            label="Max Generation Count"
            id="maxGenerationCount"
            type="number"
            value={state.maxGenerationCount}
            onChange={(value) => setState({ maxGenerationCount: value })}
            placeholder="Número máximo de elementos a generar"
          />
          
          <FormField
            label="Priority"
            id="priority"
            type="select"
            value={state.priority}
            onChange={(value) => setState({ priority: value })}
            options={[
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Low' }
            ]}
          />
        </>
      );
    }
  }
};

export default SalesApi; 