/**
 * Definición de mapeo de respuestas para APIs externas
 * 
 * Este archivo contiene únicamente el mapeo de respuestas para cada API,
 * permitiendo transformar la respuesta en un formato específico para el agente.
 * 
 * ===== CÓMO FUNCIONA EL MAPEO DE RESPUESTAS =====
 * 
 * El objeto responseMapping define cómo extraer y renombrar valores de la respuesta
 * de la API. Funciona como un diccionario donde:
 * 
 * - Las CLAVES son los nombres que queremos en nuestra respuesta final
 * - Los VALORES son las rutas donde encontrar esos datos en la respuesta original
 * 
 * Ejemplo: Si la respuesta de la API es:
 * {
 *   "success": true,
 *   "data": {
 *     "user": {
 *       "name": "John",
 *       "details": { "age": 30 }
 *     },
 *     "items": [
 *       { "id": 1, "title": "Item 1" },
 *       { "id": 2, "title": "Item 2" }
 *     ]
 *   }
 * }
 * 
 * Un mapeo como este:
 * {
 *   "wasSuccessful": "success",             // Propiedad de nivel superior
 *   "userName": "data.user.name",           // Propiedades anidadas separadas por puntos
 *   "userAge": "data.user.details.age",     // Navegación profunda en el objeto
 *   "firstItem": "data.items[0].title"      // Acceso a elementos de arrays con [índice]
 * }
 * 
 * Resultaría en:
 * {
 *   "wasSuccessful": true,
 *   "userName": "John",
 *   "userAge": 30,
 *   "firstItem": "Item 1"
 * }
 * 
 * ===== MANEJO DE CÓDIGOS DE RESPUESTA HTTP =====
 * 
 * Cuando se consumen APIs, es importante manejar correctamente los códigos
 * de respuesta HTTP. Aquí se muestra cómo se procesan diferentes tipos de respuestas:
 * 
 * Ejemplo de códigos de éxito (2xx):
 * - 200 OK: Respuesta estándar para peticiones HTTP exitosas
 * - 201 Created: La petición ha sido completada y ha resultado en la creación de un nuevo recurso
 * - 204 No Content: La petición se ha completado con éxito pero no devuelve contenido
 * 
 * Ejemplo de códigos de error (4xx, 5xx):
 * - 400 Bad Request: La solicitud no se pudo entender por el servidor
 * - 401 Unauthorized: Similar a 403, pero específicamente para uso cuando la autenticación es requerida
 * - 404 Not Found: El recurso solicitado no existe en el servidor
 * - 500 Internal Server Error: Error genérico del servidor
 * 
 * Para cada código, se procesa la respuesta de manera específica:
 * 
 * Códigos 2xx (éxito):
 * Si la respuesta de la API es exitosa, se aplicará el mapeo definido en responseMapping.
 * 
 * EJEMPLO 200 (OK):
 * Respuesta original:
 * {
 *   "success": true,
 *   "data": { "id": "123", "name": "Producto" }
 * }
 * Con mapeo { id: 'data.id', name: 'data.name' }
 * Resulta en: { id: "123", name: "Producto" }
 * 
 * EJEMPLO 201 (Created):
 * Respuesta original:
 * {
 *   "id": "ticket-123",
 *   "status": "created"
 * }
 * Con mapeo { ticket_id: 'id', ticket_status: 'status' }
 * Resulta en: { ticket_id: "ticket-123", ticket_status: "created" }
 * 
 * Códigos 4xx, 5xx (error):
 * Si la respuesta indica un error, se lanzará una excepción con información detallada.
 * 
 * EJEMPLO 400 (Bad Request):
 * Respuesta original:
 * {
 *   "success": false,
 *   "error": {
 *     "code": "INVALID_REQUEST",
 *     "message": "Missing required field: location"
 *   }
 * }
 * Resultado: Se lanza una excepción con mensaje "INVALID_REQUEST: Missing required field: location"
 * 
 * EJEMPLO 404 (Not Found):
 * Respuesta original:
 * {
 *   "success": false,
 *   "error": {
 *     "code": "RESOURCE_NOT_FOUND",
 *     "message": "The requested product does not exist"
 *   }
 * }
 * Resultado: Se lanza una excepción con mensaje "RESOURCE_NOT_FOUND: The requested product does not exist"
 */

/**
 * Interfaz para definir un endpoint de API (solo info de conexión)
 */
interface ApiEndpoint {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  requiresAuth?: boolean;
  authType?: 'Bearer' | 'Basic' | 'ApiKey';
}

/**
 * Interfaz para definir el mapeo de respuestas de una API
 */
interface ApiResponseConfig {
  endpoint: ApiEndpoint;
  responseMapping: Record<string, string>;
  // Configuración de manejo de errores para diferentes códigos de estado
  errors?: {
    // Para códigos de error específicos (4xx, 5xx)
    [statusCode: number]: {
      message: string; // Propiedad donde encontrar el mensaje de error
      code?: string;   // Propiedad donde encontrar el código de error (opcional)
    }
  };
}

/**
 * Mapa de configuraciones de respuestas para cada API
 */
export const customTools: Record<string, ApiResponseConfig> = {
  /**
   * Herramienta: Contactar a un humano para asistencia
   * 
   * Ejemplos de respuestas según código HTTP:
   * 
   * 201 Created (Éxito):
   * {
   *   "success": true,
   *   "intervention_id": "abc-123",
   *   "conversation_id": "conv-456",
   *   "agent_id": "agent-789",
   *   "status": "pending",
   *   "requested_at": "2023-01-01T12:00:00Z"
   * }
   * 
   * 400 Bad Request (Error):
   * {
   *   "success": false,
   *   "error": {
   *     "code": "INVALID_REQUEST",
   *     "message": "conversation_id is required"
   *   }
   * }
   * 
   * 404 Not Found (Error):
   * {
   *   "success": false,
   *   "error": {
   *     "code": "CONVERSATION_NOT_FOUND",
   *     "message": "The specified conversation was not found"
   *   }
   * }
   */
  CONTACT_HUMAN: {
    endpoint: {
      url: '/api/agents/tools/contact-human',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      requiresAuth: false
    },
    responseMapping: {
      // Todas estas propiedades están en el nivel raíz de la respuesta
      intervention_id: 'intervention_id',  // ID único de la intervención creada
      status: 'status',                    // Estado de la intervención (pending, etc.)
      requested_at: 'requested_at',        // Timestamp de la solicitud
      success: 'success',                  // Indicador de éxito de la operación
      conversation_id: 'conversation_id',  // ID de la conversación que solicitó la intervención
      agent_id: 'agent_id'                 // ID del agente que solicitó la intervención
    },
    errors: {
      400: {
        message: 'error.message',
        code: 'error.code'
      },
      404: {
        message: 'error.message',
        code: 'error.code'
      },
      500: {
        message: 'error.message',
        code: 'error.code'
      }
    }
  },

  /**
   * Herramienta: Consultar estado de intervención humana
   * 
   * Ejemplos de respuestas según código HTTP:
   * 
   * 200 OK (Éxito):
   * {
   *   "success": true,
   *   "interventions": [
   *     {
   *       "id": "int-123",
   *       "conversation_id": "conv-456",
   *       "status": "pending",
   *       "message": "Necesito ayuda"
   *     }
   *   ]
   * }
   * 
   * 400 Bad Request (Error):
   * {
   *   "success": false,
   *   "error": {
   *     "code": "INVALID_REQUEST",
   *     "message": "Either intervention_id or conversation_id must be provided"
   *   }
   * }
   * 
   * 404 Not Found (Error):
   * {
   *   "success": false,
   *   "error": {
   *     "code": "NOT_FOUND",
   *     "message": "No intervention requests found with the specified criteria"
   *   }
   * }
   */
  GET_HUMAN_INTERVENTION_STATUS: {
    endpoint: {
      url: '/api/agents/tools/contact-human',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      requiresAuth: false
    },
    responseMapping: {
      // Extrae el array 'interventions' completo y el indicador de éxito
      interventions: 'interventions',  // Array de intervenciones encontradas
      success: 'success'               // Indicador de éxito de la operación
    },
    errors: {
      400: {
        message: 'error.message',
        code: 'error.code'
      },
      404: {
        message: 'error.message',
        code: 'error.code'
      }
    }
  },

  /**
   * Herramienta: Delegar conversación a otro agente
   * 
   * Ejemplos de respuestas según código HTTP:
   * 
   * 200 OK (Delegado actualizado):
   * {
   *   "success": true,
   *   "conversation_id": "conv-123",
   *   "delegate_id": "agent-456",
   *   "message": "Delegate updated successfully"
   * }
   * 
   * 201 Created (Nuevo delegado):
   * {
   *   "success": true,
   *   "conversation_id": "conv-123",
   *   "delegate_id": "agent-456",
   *   "message": "New delegate assigned successfully"
   * }
   * 
   * 204 No Content (Ya asignado):
   * {
   *   "success": true,
   *   "conversation_id": "conv-123",
   *   "delegate_id": "agent-456",
   *   "message": "Agent already assigned as delegate"
   * }
   * 
   * 400 Bad Request (Error):
   * {
   *   "success": false,
   *   "error": {
   *     "code": "INVALID_REQUEST",
   *     "message": "conversation_id is required"
   *   }
   * }
   * 
   * 404 Not Found (Error):
   * {
   *   "success": false,
   *   "error": {
   *     "code": "AGENT_NOT_FOUND",
   *     "message": "No agent found with role 'support' in the conversation's site"
   *   }
   * }
   */
  DELEGATE_CONVERSATION: {
    endpoint: {
      url: '/api/agents/tools/delegate-conversation',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      requiresAuth: false
    },
    responseMapping: {
      // Propiedades del objeto de respuesta
      success: 'success',                  // Indicador de éxito de la operación
      delegate_id: 'delegate_id',          // ID del agente delegado
      message: 'message',                  // Mensaje descriptivo del resultado
      conversation_id: 'conversation_id'   // ID de la conversación delegada
    },
    errors: {
      400: {
        message: 'error.message',
        code: 'error.code'
      },
      404: {
        message: 'error.message',
        code: 'error.code'
      },
      500: {
        message: 'error.message',
        code: 'error.code'
      }
    }
  },

  /**
   * Herramienta: Consultar información de delegación
   * 
   * Ejemplos de respuestas según código HTTP:
   * 
   * 200 OK (Éxito):
   * {
   *   "success": true,
   *   "conversation_id": "conv-123",
   *   "delegate_id": "agent-456",
   *   "delegate": {
   *     "id": "agent-456",
   *     "name": "Support Agent",
   *     "role": "support"
   *   }
   * }
   * 
   * 400 Bad Request (Error):
   * {
   *   "success": false,
   *   "error": {
   *     "code": "INVALID_REQUEST",
   *     "message": "conversation_id is required"
   *   }
   * }
   * 
   * 404 Not Found (Error - No delegado):
   * {
   *   "success": false,
   *   "error": {
   *     "code": "NO_DELEGATE",
   *     "message": "No delegate assigned to this conversation"
   *   }
   * }
   */
  GET_DELEGATION_INFO: {
    endpoint: {
      url: '/api/agents/tools/delegate-conversation',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      requiresAuth: false
    },
    responseMapping: {
      // Propiedades del objeto de respuesta
      success: 'success',                // Indicador de éxito de la operación
      delegate_id: 'delegate_id',        // ID del agente delegado
      delegate: 'delegate',              // Objeto con información detallada del agente delegado
      conversation_id: 'conversation_id' // ID de la conversación consultada
    },
    errors: {
      400: {
        message: 'error.message',
        code: 'error.code'
      },
      404: {
        message: 'error.message',
        code: 'error.code'
      }
    }
  },

  /**
   * Ejemplo: API de clima
   * 
   * Ejemplos de respuestas según código HTTP:
   * 
   * 200 OK (Éxito):
   * {
   *   "name": "Madrid",
   *   "main": {
   *     "temp": 22.5,
   *     "humidity": 65
   *   },
   *   "weather": [
   *     {
   *       "description": "Soleado",
   *       "icon": "01d"
   *     }
   *   ]
   * }
   * 
   * 400 Bad Request (Error):
   * {
   *   "cod": "400",
   *   "message": "Nothing to geocode"
   * }
   * 
   * 401 Unauthorized (Error):
   * {
   *   "cod": "401",
   *   "message": "Invalid API key"
   * }
   * 
   * 404 Not Found (Error):
   * {
   *   "cod": "404",
   *   "message": "City not found"
   * }
   */
  GET_WEATHER: {
    endpoint: {
      url: 'https://api.example.com/weather',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': '{{WEATHER_API_KEY}}'
      },
      requiresAuth: true,
      authType: 'ApiKey'
    },
    responseMapping: {
      // Navegación en objeto anidado y array 
      temperature: 'main.temp',           // Navega a main.temp -> 22.5
      forecast: 'weather[0].description', // Accede al primer elemento del array weather y extrae description -> "Soleado"
      humidity: 'main.humidity',          // Navega a main.humidity -> 65
      location: 'name'                    // Propiedad de nivel raíz -> "Madrid"
    },
    errors: {
      400: {
        message: 'message',
        code: 'cod'
      },
      401: {
        message: 'message',
        code: 'cod'
      },
      404: {
        message: 'message',
        code: 'cod'
      }
    }
  },
  
  /**
   * Ejemplo: API de soporte
   * 
   * Ejemplos de respuestas según código HTTP:
   * 
   * 201 Created (Éxito):
   * {
   *   "id": "ticket-123",
   *   "status": "open",
   *   "created_at": "2023-01-01T12:00:00Z",
   *   "eta": "24 hours"
   * }
   * 
   * 400 Bad Request (Error):
   * {
   *   "error": {
   *     "type": "validation_error",
   *     "message": "Title is required"
   *   }
   * }
   * 
   * 401 Unauthorized (Error):
   * {
   *   "error": {
   *     "type": "auth_error",
   *     "message": "Invalid or expired token"
   *   }
   * }
   */
  CREATE_SUPPORT_TICKET: {
    endpoint: {
      url: 'https://api.example.com/support/tickets',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer {{SUPPORT_API_TOKEN}}'
      },
      requiresAuth: true,
      authType: 'Bearer'
    },
    responseMapping: {
      // Renombramos algunas propiedades para mayor claridad
      ticket_id: 'id',                          // "id": "ticket-123" -> ticket_id: "ticket-123"
      status: 'status',                         // "status": "open" -> status: "open"
      estimated_response_time: 'eta',           // "eta": "24 hours" -> estimated_response_time: "24 hours"
      created_at: 'created_at'                  // "created_at": "2023..." -> created_at: "2023..."
    },
    errors: {
      400: {
        message: 'error.message',
        code: 'error.type'
      },
      401: {
        message: 'error.message',
        code: 'error.type'
      }
    }
  },
  
  /**
   * Ejemplo: API de productos
   * 
   * Ejemplos de respuestas según código HTTP:
   * 
   * 200 OK (Éxito):
   * {
   *   "sku": "PROD-123",
   *   "product_name": "Smart Watch",
   *   "price": {
   *     "value": 199.99,
   *     "currency": "USD"
   *   },
   *   "inventory": {
   *     "available": true,
   *     "quantity": 42
   *   },
   *   "detailed_description": "Reloj inteligente con...",
   *   "category": {
   *     "id": 5,
   *     "name": "Electronics"
   *   }
   * }
   * 
   * 404 Not Found (Error):
   * {
   *   "error": true,
   *   "code": "PRODUCT_NOT_FOUND",
   *   "message": "Product with ID PROD-999 does not exist"
   * }
   */
  GET_PRODUCT_DETAILS: {
    endpoint: {
      url: 'https://api.example.com/products/{product_id}',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      requiresAuth: false
    },
    responseMapping: {
      // Navegación en objetos anidados para extraer valores específicos
      name: 'product_name',                // "product_name": "Smart Watch" -> name: "Smart Watch"
      price: 'price.value',                // Navega a price.value -> 199.99
      in_stock: 'inventory.available',     // Navega a inventory.available -> true
      description: 'detailed_description', // "detailed_description": "..." -> description: "..."
      sku: 'sku',                          // "sku": "PROD-123" -> sku: "PROD-123"
      category: 'category.name'            // Navega a category.name -> "Electronics"
    },
    errors: {
      404: {
        message: 'message',
        code: 'code'
      },
      500: {
        message: 'message',
        code: 'code'
      }
    }
  }
};

/**
 * Verifica si una herramienta está disponible en el mapa personalizado
 * @param toolName Nombre de la herramienta a verificar
 * @returns true si la herramienta existe en el mapa personalizado
 */
export function hasCustomTool(toolName: string): boolean {
  return toolName in customTools;
}

/**
 * Obtiene la configuración de respuesta para una herramienta
 * @param toolName Nombre de la herramienta
 * @returns Configuración de respuesta o undefined si no existe
 */
export function getCustomToolDefinition(toolName: string): ApiResponseConfig | undefined {
  return customTools[toolName];
} 