'use client';

import React from 'react';
import { BaseApiConfig } from '../types';
import { FormField, SectionLabel } from '../utils';
import { v4 as generateUUID } from 'uuid';

// Props específicas para la API de Tracking de Visitantes
export interface VisitorTrackApiProps {
  defaultEndpoint?: string;
  defaultMethod?: 'POST';
  defaultSiteId?: string;
  defaultVisitorId?: string;
  defaultSessionId?: string;
  defaultUrl?: string;
  defaultEventType?: string;
  defaultEventName?: string;
}

// Estado específico para la API de Tracking de Visitantes
export interface VisitorTrackApiState {
  endpoint: string;
  method: 'POST';
  site_id: string;
  event_type: string;
  event_name: string;
  url: string;
  referrer: string;
  visitor_id: string;
  session_id: string;
  timestamp: string;
  properties: string;
  user_agent: string;
  ip: string;
  // Propiedades específicas por tipo de evento
  click_x: string;
  click_y: string;
  click_element_tag: string;
  click_element_class: string;
  click_element_id: string;
  click_element_text: string;
  mousemove_x: string;
  mousemove_y: string;
  mousemove_viewport_width: string;
  mousemove_viewport_height: string;
  scroll_x: string;
  scroll_y: string;
  scroll_max_scroll: string;
  scroll_viewport_height: string;
  scroll_document_height: string;
  scroll_percentage: string;
  keypress_key: string;
  keypress_key_code: string;
  keypress_element_tag: string;
  keypress_element_type: string;
  keypress_element_name: string;
  keypress_is_sensitive: boolean;
  resize_width: string;
  resize_height: string;
  resize_previous_width: string;
  resize_previous_height: string;
  resize_orientation: string;
  focus_element_tag: string;
  focus_element_type: string;
  focus_element_name: string;
  focus_element_placeholder: string;
  focus_duration: string;
  form_id: string;
  form_name: string;
  form_fields: string;
  form_completion_time: string;
  form_success: boolean;
  performance_load_time: string;
  performance_dom_content_loaded: string;
  performance_first_paint: string;
  performance_first_contentful_paint: string;
  performance_resources_total: string;
  performance_resources_images: string;
  performance_resources_scripts: string;
  performance_resources_stylesheets: string;
  performance_resources_fonts: string;
  performance_memory_used: string;
  performance_memory_total: string;
  error_type: string;
  error_message: string;
  error_stack: string;
  error_filename: string;
  error_line_number: string;
  error_column_number: string;
  error_browser: string;
  error_browser_version: string;
  recording_id: string;
  recording_start_time: string;
  recording_end_time: string;
  recording_duration: string;
  recording_events: string;
  recording_screen_size: string;
  recording_browser: string;
  recording_browser_version: string;
  recording_os: string;
  recording_device_type: string;
  activity_bulk_events: string;
}

// Configuración de la API de Tracking de Visitantes
const VisitorTrackApi: BaseApiConfig = {
  id: 'visitor_track',
  name: 'API de Tracking de Visitantes',
  description: 'API para registrar eventos de visitantes en un sitio web',
  defaultEndpoint: '/api/visitors/track',

  // Obtener el estado inicial
  getInitialState: (props: VisitorTrackApiProps): VisitorTrackApiState => {
    // Generar un site_id por defecto si no se proporciona uno
    const defaultSiteId = props.defaultSiteId || generateUUID();
    
    return {
      endpoint: props.defaultEndpoint || '/api/visitors/track',
      method: props.defaultMethod || 'POST',
      site_id: defaultSiteId,
      event_type: props.defaultEventType || 'pageview',
      event_name: props.defaultEventName || 'homepage_view',
      url: props.defaultUrl || 'https://example.com/products',
      referrer: 'https://google.com',
      visitor_id: props.defaultVisitorId || generateUUID(),
      session_id: props.defaultSessionId || generateUUID(),
      timestamp: Date.now().toString(),
      properties: JSON.stringify({
        page_title: "Product Catalog",
        screen_size: "1920x1080",
        locale: "en-US",
        user_type: "new",
        device_type: "desktop"
      }),
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      ip: '192.168.1.1',
      // Propiedades específicas por tipo de evento
      click_x: '500',
      click_y: '300',
      click_element_tag: 'button',
      click_element_class: 'add-to-cart',
      click_element_id: 'product-123',
      click_element_text: 'Add to Cart',
      mousemove_x: '750',
      mousemove_y: '450',
      mousemove_viewport_width: '1920',
      mousemove_viewport_height: '1080',
      scroll_x: '0',
      scroll_y: '500',
      scroll_max_scroll: '2000',
      scroll_viewport_height: '1080',
      scroll_document_height: '3080',
      scroll_percentage: '25',
      keypress_key: 'Enter',
      keypress_key_code: '13',
      keypress_element_tag: 'input',
      keypress_element_type: 'text',
      keypress_element_name: 'search',
      keypress_is_sensitive: false,
      resize_width: '1920',
      resize_height: '1080',
      resize_previous_width: '1366',
      resize_previous_height: '768',
      resize_orientation: 'landscape',
      focus_element_tag: 'input',
      focus_element_type: 'email',
      focus_element_name: 'email',
      focus_element_placeholder: 'Enter your email',
      focus_duration: '120000',
      form_id: 'contact-form',
      form_name: 'Contact Form',
      form_fields: JSON.stringify([
        { name: "name", type: "text", filled: true },
        { name: "email", type: "email", filled: true },
        { name: "message", type: "textarea", filled: true }
      ]),
      form_completion_time: '120000',
      form_success: true,
      performance_load_time: '1250',
      performance_dom_content_loaded: '850',
      performance_first_paint: '920',
      performance_first_contentful_paint: '980',
      performance_resources_total: '25',
      performance_resources_images: '10',
      performance_resources_scripts: '8',
      performance_resources_stylesheets: '4',
      performance_resources_fonts: '3',
      performance_memory_used: '150000000',
      performance_memory_total: '8589934592',
      error_type: 'javascript',
      error_message: 'Cannot read property price of undefined',
      error_stack: 'at calculateTotal (script.js:45:12)',
      error_filename: 'script.js',
      error_line_number: '45',
      error_column_number: '12',
      error_browser: 'Chrome',
      error_browser_version: '122.0.0.0',
      recording_id: `rec_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      recording_start_time: (Date.now() - 300000).toString(), // 5 minutes ago
      recording_end_time: Date.now().toString(),
      recording_duration: '300000',
      recording_events: JSON.stringify([
        { 
          type: "mousemove", 
          x: 100, 
          y: 200, 
          timestamp: Date.now() - 300000,
          viewport: {
            width: 1920,
            height: 1080
          }
        },
        { 
          type: "click", 
          x: 150, 
          y: 250, 
          timestamp: Date.now() - 299000, 
          element: { 
            tag: "button", 
            id: "add-to-cart",
            class: "btn-primary",
            text: "Add to Cart"
          }
        },
        { 
          type: "scroll", 
          x: 0, 
          y: 300, 
          timestamp: Date.now() - 298000, 
          percentage_scrolled: 25,
          document_height: 3080,
          viewport_height: 1080
        },
        { 
          type: "keypress", 
          key: "Enter", 
          timestamp: Date.now() - 297000, 
          key_code: 13,
          element: {
            tag: "input",
            type: "text",
            name: "search"
          }
        },
        {
          type: "resize",
          timestamp: Date.now() - 296000,
          width: 1920,
          height: 1080,
          previous_width: 1366,
          previous_height: 768,
          orientation: "landscape"
        },
        {
          type: "focus",
          timestamp: Date.now() - 295000,
          element: {
            tag: "input",
            type: "email",
            name: "email",
            placeholder: "Enter your email"
          }
        },
        {
          type: "form_change",
          timestamp: Date.now() - 294000,
          form_id: "contact-form",
          form_name: "Contact Form",
          field_name: "name",
          field_value: "John Doe",
          field_type: "text"
        },
        {
          type: "form_submit",
          timestamp: Date.now() - 293000,
          form_id: "contact-form",
          form_name: "Contact Form",
          fields: [
            { name: "name", type: "text", filled: true },
            { name: "email", type: "email", filled: true },
            { name: "message", type: "textarea", filled: true }
          ],
          completion_time: 120000,
          success: true
        }
      ]),
      recording_screen_size: '1920x1080',
      recording_browser: 'Chrome',
      recording_browser_version: '122.0.0.0',
      recording_os: 'MacOS',
      recording_device_type: 'desktop',
      activity_bulk_events: JSON.stringify([
        { 
          type: "mousemove", 
          x: 100, 
          y: 200, 
          timestamp: Date.now() - 300000,
          viewport: {
            width: 1920,
            height: 1080
          }
        },
        { 
          type: "click", 
          x: 150, 
          y: 250, 
          timestamp: Date.now() - 299000, 
          element: { 
            tag: "button", 
            id: "add-to-cart",
            class: "btn-primary",
            text: "Add to Cart"
          }
        },
        { 
          type: "scroll", 
          x: 0, 
          y: 300, 
          timestamp: Date.now() - 298000, 
          percentage_scrolled: 25,
          document_height: 3080,
          viewport_height: 1080
        },
        { 
          type: "keypress", 
          key: "Enter", 
          timestamp: Date.now() - 297000, 
          key_code: 13,
          element: {
            tag: "input",
            type: "text",
            name: "search"
          }
        }
      ])
    };
  },

  // Construir el cuerpo de la solicitud
  buildRequestBody: (state: VisitorTrackApiState): Record<string, any> => {
    const body: Record<string, any> = {
      site_id: state.site_id,
      event_type: state.event_type,
      url: state.url
    };

    // Añadir campos opcionales comunes
    if (state.referrer) body.referrer = state.referrer;
    if (state.visitor_id) body.visitor_id = state.visitor_id;
    if (state.session_id) body.session_id = state.session_id;
    if (state.timestamp) body.timestamp = parseInt(state.timestamp);
    if (state.user_agent) body.user_agent = state.user_agent;
    if (state.ip) body.ip = state.ip;

    // Añadir event_name para eventos personalizados y de acción
    if (state.event_type === 'custom' || state.event_type === 'action') {
      body.event_name = state.event_name;
    }

    // Construir properties según el tipo de evento
    let properties: Record<string, any> = {};

    switch (state.event_type) {
      case 'click':
        properties = {
          x: parseInt(state.click_x) || 0,
          y: parseInt(state.click_y) || 0,
          element: {
            tag: state.click_element_tag || undefined,
            class: state.click_element_class || undefined,
            id: state.click_element_id || undefined,
            text: state.click_element_text || undefined
          }
        };
        break;

      case 'mousemove':
        properties = {
          x: parseInt(state.mousemove_x) || 0,
          y: parseInt(state.mousemove_y) || 0,
          viewport: {
            width: parseInt(state.mousemove_viewport_width) || 0,
            height: parseInt(state.mousemove_viewport_height) || 0
          }
        };
        break;

      case 'scroll':
        properties = {
          scroll_x: parseInt(state.scroll_x) || 0,
          scroll_y: parseInt(state.scroll_y) || 0,
          max_scroll: parseInt(state.scroll_max_scroll) || 0,
          viewport_height: parseInt(state.scroll_viewport_height) || 0,
          document_height: parseInt(state.scroll_document_height) || 0,
          percentage_scrolled: parseInt(state.scroll_percentage) || 0
        };
        break;

      case 'keypress':
        properties = {
          key: state.keypress_key,
          key_code: parseInt(state.keypress_key_code) || 0,
          element: {
            tag: state.keypress_element_tag || undefined,
            type: state.keypress_element_type || undefined,
            name: state.keypress_element_name || undefined
          },
          is_sensitive: state.keypress_is_sensitive
        };
        break;

      case 'resize':
        properties = {
          width: parseInt(state.resize_width) || 0,
          height: parseInt(state.resize_height) || 0,
          previous_width: parseInt(state.resize_previous_width) || undefined,
          previous_height: parseInt(state.resize_previous_height) || undefined,
          orientation: state.resize_orientation || undefined
        };
        break;

      case 'focus':
        properties = {
          element: {
            tag: state.focus_element_tag || undefined,
            type: state.focus_element_type || undefined,
            name: state.focus_element_name || undefined,
            placeholder: state.focus_element_placeholder || undefined
          },
          focus_duration: parseInt(state.focus_duration) || undefined
        };
        break;

      case 'form_submit':
      case 'form_change':
      case 'form_error':
        properties = {
          form_id: state.form_id,
          form_name: state.form_name,
          completion_time: parseInt(state.form_completion_time) || undefined,
          success: state.form_success
        };
        if (state.form_fields) {
          try {
            properties.fields = JSON.parse(state.form_fields);
          } catch (e) {
            console.error('Error parsing form_fields JSON:', e);
          }
        }
        break;

      case 'performance':
        properties = {
          navigation: {
            load_time: parseInt(state.performance_load_time) || 0,
            dom_content_loaded: parseInt(state.performance_dom_content_loaded) || 0,
            first_paint: parseInt(state.performance_first_paint) || 0,
            first_contentful_paint: parseInt(state.performance_first_contentful_paint) || 0
          },
          resources: {
            total: parseInt(state.performance_resources_total) || 0,
            images: parseInt(state.performance_resources_images) || 0,
            scripts: parseInt(state.performance_resources_scripts) || 0,
            stylesheets: parseInt(state.performance_resources_stylesheets) || 0,
            fonts: parseInt(state.performance_resources_fonts) || 0
          },
          memory: {
            used: parseInt(state.performance_memory_used) || 0,
            total: parseInt(state.performance_memory_total) || 0
          }
        };
        break;

      case 'error':
        properties = {
          error_type: state.error_type,
          message: state.error_message,
          stack: state.error_stack || undefined,
          filename: state.error_filename || undefined,
          line_number: parseInt(state.error_line_number) || undefined,
          column_number: parseInt(state.error_column_number) || undefined,
          browser: state.error_browser || undefined,
          browser_version: state.error_browser_version || undefined
        };
        break;

      case 'session_recording':
        properties = {
          recording_id: state.recording_id,
          start_time: parseInt(state.recording_start_time) || 0,
          end_time: parseInt(state.recording_end_time) || 0,
          duration: parseInt(state.recording_duration) || 0,
          metadata: {
            screen_size: state.recording_screen_size,
            browser: state.recording_browser,
            browser_version: state.recording_browser_version,
            os: state.recording_os,
            device_type: state.recording_device_type
          }
        };
        if (state.recording_events) {
          try {
            const events = JSON.parse(state.recording_events);
            properties.events = events;
            properties.activity = events;
          } catch (e) {
            console.error('Error parsing recording_events JSON:', e);
          }
        }
        break;
    }

    // Añadir properties al body si no está vacío
    if (Object.keys(properties).length > 0) {
      body.properties = properties;
    }

    return body;
  },

  // Construir las cabeceras de la solicitud
  buildRequestHeaders: (state: VisitorTrackApiState): Record<string, string> => {
    return {
      'Content-Type': 'application/json',
      'X-SA-API-KEY': 'test-api-key-001'
    };
  },

  // Renderizar los campos del formulario
  renderFields: (props: {
    state: VisitorTrackApiState;
    setState: React.Dispatch<React.SetStateAction<VisitorTrackApiState>>;
    additionalFields?: any[];
  }) => {
    const { state, setState } = props;
    
    // Función para manejar los cambios en los campos del formulario
    const handleChange = (field: keyof VisitorTrackApiState, value: any) => {
      setState({ ...state, [field]: value });
    };

    // Función para renderizar campos específicos según el tipo de evento
    const renderEventSpecificFields = () => {
      switch (state.event_type) {
        case 'click':
          return (
            <>
              <SectionLabel>Propiedades del Click</SectionLabel>
              <FormField
                label="Coordenada X"
                id="click_x"
                type="number"
                value={state.click_x}
                onChange={(value) => handleChange('click_x', value)}
                placeholder="0"
              />
              <FormField
                label="Coordenada Y"
                id="click_y"
                type="number"
                value={state.click_y}
                onChange={(value) => handleChange('click_y', value)}
                placeholder="0"
              />
              <FormField
                label="Tag del Elemento"
                id="click_element_tag"
                type="text"
                value={state.click_element_tag}
                onChange={(value) => handleChange('click_element_tag', value)}
                placeholder="button"
              />
              <FormField
                label="Clase del Elemento"
                id="click_element_class"
                type="text"
                value={state.click_element_class}
                onChange={(value) => handleChange('click_element_class', value)}
                placeholder="btn-primary"
              />
              <FormField
                label="ID del Elemento"
                id="click_element_id"
                type="text"
                value={state.click_element_id}
                onChange={(value) => handleChange('click_element_id', value)}
                placeholder="submit-btn"
              />
              <FormField
                label="Texto del Elemento"
                id="click_element_text"
                type="text"
                value={state.click_element_text}
                onChange={(value) => handleChange('click_element_text', value)}
                placeholder="Submit"
              />
            </>
          );

        case 'mousemove':
          return (
            <>
              <SectionLabel>Propiedades del Movimiento del Mouse</SectionLabel>
              <FormField
                label="Coordenada X"
                id="mousemove_x"
                type="number"
                value={state.mousemove_x}
                onChange={(value) => handleChange('mousemove_x', value)}
                placeholder="0"
              />
              <FormField
                label="Coordenada Y"
                id="mousemove_y"
                type="number"
                value={state.mousemove_y}
                onChange={(value) => handleChange('mousemove_y', value)}
                placeholder="0"
              />
              <FormField
                label="Ancho del Viewport"
                id="mousemove_viewport_width"
                type="number"
                value={state.mousemove_viewport_width}
                onChange={(value) => handleChange('mousemove_viewport_width', value)}
                placeholder="1920"
              />
              <FormField
                label="Alto del Viewport"
                id="mousemove_viewport_height"
                type="number"
                value={state.mousemove_viewport_height}
                onChange={(value) => handleChange('mousemove_viewport_height', value)}
                placeholder="1080"
              />
            </>
          );

        case 'scroll':
          return (
            <>
              <SectionLabel>Propiedades del Scroll</SectionLabel>
              <FormField
                label="Scroll X"
                id="scroll_x"
                type="number"
                value={state.scroll_x}
                onChange={(value) => handleChange('scroll_x', value)}
                placeholder="0"
              />
              <FormField
                label="Scroll Y"
                id="scroll_y"
                type="number"
                value={state.scroll_y}
                onChange={(value) => handleChange('scroll_y', value)}
                placeholder="0"
              />
              <FormField
                label="Scroll Máximo"
                id="scroll_max_scroll"
                type="number"
                value={state.scroll_max_scroll}
                onChange={(value) => handleChange('scroll_max_scroll', value)}
                placeholder="2000"
              />
              <FormField
                label="Alto del Viewport"
                id="scroll_viewport_height"
                type="number"
                value={state.scroll_viewport_height}
                onChange={(value) => handleChange('scroll_viewport_height', value)}
                placeholder="1080"
              />
              <FormField
                label="Alto del Documento"
                id="scroll_document_height"
                type="number"
                value={state.scroll_document_height}
                onChange={(value) => handleChange('scroll_document_height', value)}
                placeholder="3080"
              />
              <FormField
                label="Porcentaje Scrolleado"
                id="scroll_percentage"
                type="number"
                value={state.scroll_percentage}
                onChange={(value) => handleChange('scroll_percentage', value)}
                placeholder="25"
              />
            </>
          );

        case 'keypress':
          return (
            <>
              <SectionLabel>Propiedades del Keypress</SectionLabel>
              <FormField
                label="Tecla"
                id="keypress_key"
                type="text"
                value={state.keypress_key}
                onChange={(value) => handleChange('keypress_key', value)}
                placeholder="Enter"
              />
              <FormField
                label="Código de Tecla"
                id="keypress_key_code"
                type="number"
                value={state.keypress_key_code}
                onChange={(value) => handleChange('keypress_key_code', value)}
                placeholder="13"
              />
              <FormField
                label="Tag del Elemento"
                id="keypress_element_tag"
                type="text"
                value={state.keypress_element_tag}
                onChange={(value) => handleChange('keypress_element_tag', value)}
                placeholder="input"
              />
              <FormField
                label="Tipo del Elemento"
                id="keypress_element_type"
                type="text"
                value={state.keypress_element_type}
                onChange={(value) => handleChange('keypress_element_type', value)}
                placeholder="text"
              />
              <FormField
                label="Nombre del Elemento"
                id="keypress_element_name"
                type="text"
                value={state.keypress_element_name}
                onChange={(value) => handleChange('keypress_element_name', value)}
                placeholder="email"
              />
              <FormField
                label="Es Sensible"
                id="keypress_is_sensitive"
                type="checkbox"
                value={state.keypress_is_sensitive}
                onChange={(value) => handleChange('keypress_is_sensitive', value)}
              />
            </>
          );

        case 'resize':
          return (
            <>
              <SectionLabel>Propiedades del Resize</SectionLabel>
              <FormField
                label="Ancho"
                id="resize_width"
                type="number"
                value={state.resize_width}
                onChange={(value) => handleChange('resize_width', value)}
                placeholder="1920"
              />
              <FormField
                label="Alto"
                id="resize_height"
                type="number"
                value={state.resize_height}
                onChange={(value) => handleChange('resize_height', value)}
                placeholder="1080"
              />
              <FormField
                label="Ancho Anterior"
                id="resize_previous_width"
                type="number"
                value={state.resize_previous_width}
                onChange={(value) => handleChange('resize_previous_width', value)}
                placeholder="1366"
              />
              <FormField
                label="Alto Anterior"
                id="resize_previous_height"
                type="number"
                value={state.resize_previous_height}
                onChange={(value) => handleChange('resize_previous_height', value)}
                placeholder="768"
              />
              <FormField
                label="Orientación"
                id="resize_orientation"
                type="text"
                value={state.resize_orientation}
                onChange={(value) => handleChange('resize_orientation', value)}
                placeholder="landscape"
              />
            </>
          );

        case 'focus':
          return (
            <>
              <SectionLabel>Propiedades del Focus</SectionLabel>
              <FormField
                label="Tag del Elemento"
                id="focus_element_tag"
                type="text"
                value={state.focus_element_tag}
                onChange={(value) => handleChange('focus_element_tag', value)}
                placeholder="input"
              />
              <FormField
                label="Tipo del Elemento"
                id="focus_element_type"
                type="text"
                value={state.focus_element_type}
                onChange={(value) => handleChange('focus_element_type', value)}
                placeholder="text"
              />
              <FormField
                label="Nombre del Elemento"
                id="focus_element_name"
                type="text"
                value={state.focus_element_name}
                onChange={(value) => handleChange('focus_element_name', value)}
                placeholder="email"
              />
              <FormField
                label="Placeholder"
                id="focus_element_placeholder"
                type="text"
                value={state.focus_element_placeholder}
                onChange={(value) => handleChange('focus_element_placeholder', value)}
                placeholder="Enter your email"
              />
              <FormField
                label="Duración del Focus (ms)"
                id="focus_duration"
                type="number"
                value={state.focus_duration}
                onChange={(value) => handleChange('focus_duration', value)}
                placeholder="120000"
              />
            </>
          );

        case 'form_submit':
        case 'form_change':
        case 'form_error':
          return (
            <>
              <SectionLabel>Propiedades del Formulario</SectionLabel>
              <FormField
                label="ID del Formulario"
                id="form_id"
                type="text"
                value={state.form_id}
                onChange={(value) => handleChange('form_id', value)}
                placeholder="contact-form"
              />
              <FormField
                label="Nombre del Formulario"
                id="form_name"
                type="text"
                value={state.form_name}
                onChange={(value) => handleChange('form_name', value)}
                placeholder="Contact Form"
              />
              <FormField
                label="Campos (JSON)"
                id="form_fields"
                type="textarea"
                value={state.form_fields}
                onChange={(value) => handleChange('form_fields', value)}
                placeholder='[{"name": "name", "type": "text", "filled": true}]'
              />
              <FormField
                label="Tiempo de Completado (ms)"
                id="form_completion_time"
                type="number"
                value={state.form_completion_time}
                onChange={(value) => handleChange('form_completion_time', value)}
                placeholder="120000"
              />
              <FormField
                label="Éxito"
                id="form_success"
                type="checkbox"
                value={state.form_success}
                onChange={(value) => handleChange('form_success', value)}
              />
            </>
          );

        case 'performance':
          return (
            <>
              <SectionLabel>Propiedades de Rendimiento</SectionLabel>
              <FormField
                label="Tiempo de Carga (ms)"
                id="performance_load_time"
                type="number"
                value={state.performance_load_time}
                onChange={(value) => handleChange('performance_load_time', value)}
                placeholder="1250"
              />
              <FormField
                label="DOM Content Loaded (ms)"
                id="performance_dom_content_loaded"
                type="number"
                value={state.performance_dom_content_loaded}
                onChange={(value) => handleChange('performance_dom_content_loaded', value)}
                placeholder="850"
              />
              <FormField
                label="First Paint (ms)"
                id="performance_first_paint"
                type="number"
                value={state.performance_first_paint}
                onChange={(value) => handleChange('performance_first_paint', value)}
                placeholder="920"
              />
              <FormField
                label="First Contentful Paint (ms)"
                id="performance_first_contentful_paint"
                type="number"
                value={state.performance_first_contentful_paint}
                onChange={(value) => handleChange('performance_first_contentful_paint', value)}
                placeholder="980"
              />
              <FormField
                label="Total de Recursos"
                id="performance_resources_total"
                type="number"
                value={state.performance_resources_total}
                onChange={(value) => handleChange('performance_resources_total', value)}
                placeholder="25"
              />
              <FormField
                label="Imágenes"
                id="performance_resources_images"
                type="number"
                value={state.performance_resources_images}
                onChange={(value) => handleChange('performance_resources_images', value)}
                placeholder="10"
              />
              <FormField
                label="Scripts"
                id="performance_resources_scripts"
                type="number"
                value={state.performance_resources_scripts}
                onChange={(value) => handleChange('performance_resources_scripts', value)}
                placeholder="8"
              />
              <FormField
                label="Hojas de Estilo"
                id="performance_resources_stylesheets"
                type="number"
                value={state.performance_resources_stylesheets}
                onChange={(value) => handleChange('performance_resources_stylesheets', value)}
                placeholder="4"
              />
              <FormField
                label="Fuentes"
                id="performance_resources_fonts"
                type="number"
                value={state.performance_resources_fonts}
                onChange={(value) => handleChange('performance_resources_fonts', value)}
                placeholder="3"
              />
              <FormField
                label="Memoria Usada (bytes)"
                id="performance_memory_used"
                type="number"
                value={state.performance_memory_used}
                onChange={(value) => handleChange('performance_memory_used', value)}
                placeholder="150000000"
              />
              <FormField
                label="Memoria Total (bytes)"
                id="performance_memory_total"
                type="number"
                value={state.performance_memory_total}
                onChange={(value) => handleChange('performance_memory_total', value)}
                placeholder="8589934592"
              />
            </>
          );

        case 'error':
          return (
            <>
              <SectionLabel>Propiedades del Error</SectionLabel>
              <FormField
                label="Tipo de Error"
                id="error_type"
                type="text"
                value={state.error_type}
                onChange={(value) => handleChange('error_type', value)}
                placeholder="javascript"
              />
              <FormField
                label="Mensaje"
                id="error_message"
                type="text"
                value={state.error_message}
                onChange={(value) => handleChange('error_message', value)}
                placeholder="Cannot read property 'price' of undefined"
              />
              <FormField
                label="Stack Trace"
                id="error_stack"
                type="textarea"
                value={state.error_stack}
                onChange={(value) => handleChange('error_stack', value)}
                placeholder="at calculateTotal (script.js:45:12)"
              />
              <FormField
                label="Nombre del Archivo"
                id="error_filename"
                type="text"
                value={state.error_filename}
                onChange={(value) => handleChange('error_filename', value)}
                placeholder="script.js"
              />
              <FormField
                label="Número de Línea"
                id="error_line_number"
                type="number"
                value={state.error_line_number}
                onChange={(value) => handleChange('error_line_number', value)}
                placeholder="45"
              />
              <FormField
                label="Número de Columna"
                id="error_column_number"
                type="number"
                value={state.error_column_number}
                onChange={(value) => handleChange('error_column_number', value)}
                placeholder="12"
              />
              <FormField
                label="Navegador"
                id="error_browser"
                type="text"
                value={state.error_browser}
                onChange={(value) => handleChange('error_browser', value)}
                placeholder="Chrome"
              />
              <FormField
                label="Versión del Navegador"
                id="error_browser_version"
                type="text"
                value={state.error_browser_version}
                onChange={(value) => handleChange('error_browser_version', value)}
                placeholder="98.0.4758.102"
              />
            </>
          );

        case 'session_recording':
          return (
            <>
              <SectionLabel>Propiedades de la Grabación de Sesión</SectionLabel>
              <FormField
                label="ID de Grabación"
                id="recording_id"
                type="text"
                value={state.recording_id}
                onChange={(value) => handleChange('recording_id', value)}
                placeholder="rec_12345"
              />
              <FormField
                label="Tiempo de Inicio"
                id="recording_start_time"
                type="number"
                value={state.recording_start_time}
                onChange={(value) => handleChange('recording_start_time', value)}
                placeholder="1646123456789"
              />
              <FormField
                label="Tiempo de Fin"
                id="recording_end_time"
                type="number"
                value={state.recording_end_time}
                onChange={(value) => handleChange('recording_end_time', value)}
                placeholder="1646123789456"
              />
              <FormField
                label="Duración (ms)"
                id="recording_duration"
                type="number"
                value={state.recording_duration}
                onChange={(value) => handleChange('recording_duration', value)}
                placeholder="332667"
              />
              <FormField
                label="Eventos (JSON Array)"
                id="recording_events"
                type="textarea"
                value={state.recording_events}
                onChange={(value) => handleChange('recording_events', value)}
                placeholder={`[
  { "type": "mousemove", "x": 100, "y": 200, "timestamp": 1646123456789 },
  { "type": "click", "x": 150, "y": 250, "timestamp": 1646123456790, "element": { "tag": "button", "id": "add-to-cart" } },
  { "type": "scroll", "x": 0, "y": 300, "timestamp": 1646123456791, "percentage_scrolled": 25 },
  { "type": "keypress", "key": "Enter", "timestamp": 1646123456792, "key_code": 13 }
]`}
              />
              <div style={{ fontSize: '0.85em', color: '#666', marginTop: '5px' }}>
                Cada evento debe incluir un campo 'type' que indique el subtipo de evento (mousemove, click, scroll, keypress, etc.)
              </div>
              <FormField
                label="Tamaño de Pantalla"
                id="recording_screen_size"
                type="text"
                value={state.recording_screen_size}
                onChange={(value) => handleChange('recording_screen_size', value)}
                placeholder="1920x1080"
              />
              <FormField
                label="Navegador"
                id="recording_browser"
                type="text"
                value={state.recording_browser}
                onChange={(value) => handleChange('recording_browser', value)}
                placeholder="Chrome"
              />
              <FormField
                label="Versión del Navegador"
                id="recording_browser_version"
                type="text"
                value={state.recording_browser_version}
                onChange={(value) => handleChange('recording_browser_version', value)}
                placeholder="98.0.4758.102"
              />
              <FormField
                label="Sistema Operativo"
                id="recording_os"
                type="text"
                value={state.recording_os}
                onChange={(value) => handleChange('recording_os', value)}
                placeholder="Windows"
              />
              <FormField
                label="Tipo de Dispositivo"
                id="recording_device_type"
                type="text"
                value={state.recording_device_type}
                onChange={(value) => handleChange('recording_device_type', value)}
                placeholder="desktop"
              />
            </>
          );

        default:
          return null;
      }
    };
    
    return (
      <>
        <FormField
          label="Endpoint"
          id="endpoint"
          type="text"
          value={state.endpoint}
          onChange={(value) => handleChange('endpoint', value)}
          placeholder="/api/visitors/track"
          required
        />
        
        <FormField
          label="ID del Sitio"
          id="site_id"
          type="text"
          value={state.site_id}
          onChange={(value) => handleChange('site_id', value)}
          placeholder="site_123abc"
          required
        />
        
        <FormField
          label="Tipo de Evento"
          id="event_type"
          type="select"
          value={state.event_type}
          onChange={(value) => handleChange('event_type', value)}
          options={[
            { value: "pageview", label: "Pageview" },
            { value: "click", label: "Click" },
            { value: "custom", label: "Custom" },
            { value: "purchase", label: "Purchase" },
            { value: "action", label: "Action" },
            { value: "mousemove", label: "Mouse Move" },
            { value: "scroll", label: "Scroll" },
            { value: "keypress", label: "Keypress" },
            { value: "resize", label: "Resize" },
            { value: "focus", label: "Focus" },
            { value: "form_submit", label: "Form Submit" },
            { value: "form_change", label: "Form Change" },
            { value: "form_error", label: "Form Error" },
            { value: "error", label: "Error" },
            { value: "performance", label: "Performance" },
            { value: "session_recording", label: "Session Recording" }
          ]}
          required
        />

        {(state.event_type === 'custom' || state.event_type === 'action') && (
          <FormField
            label="Nombre del Evento"
            id="event_name"
            type="text"
            value={state.event_name}
            onChange={(value) => handleChange('event_name', value)}
            placeholder="add_to_cart"
            required
          />
        )}

        <FormField
          label="URL"
          id="url"
          type="text"
          value={state.url}
          onChange={(value) => handleChange('url', value)}
          placeholder="https://ejemplo.com/productos"
          required
        />

        <FormField
          label="Referrer"
          id="referrer"
          type="text"
          value={state.referrer}
          onChange={(value) => handleChange('referrer', value)}
          placeholder="https://google.com"
        />

        <FormField
          label="ID del Visitante"
          id="visitor_id"
          type="text"
          value={state.visitor_id}
          onChange={(value) => handleChange('visitor_id', value)}
          placeholder="vis_abcd1234"
        />

        <FormField
          label="ID de Sesión"
          id="session_id"
          type="text"
          value={state.session_id}
          onChange={(value) => handleChange('session_id', value)}
          placeholder="sess_xyz789"
        />

        <FormField
          label="Timestamp"
          id="timestamp"
          type="number"
          value={state.timestamp}
          onChange={(value) => handleChange('timestamp', value)}
          placeholder={Date.now().toString()}
        />

        <FormField
          label="User Agent"
          id="user_agent"
          type="text"
          value={state.user_agent}
          onChange={(value) => handleChange('user_agent', value)}
          placeholder="Mozilla/5.0..."
        />

        <FormField
          label="IP"
          id="ip"
          type="text"
          value={state.ip}
          onChange={(value) => handleChange('ip', value)}
          placeholder="192.168.1.1"
        />

        {renderEventSpecificFields()}
      </>
    );
  }
};

export default VisitorTrackApi; 