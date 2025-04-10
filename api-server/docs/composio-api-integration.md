# Composio API Apps Integration

This document explains how to use the Composio API apps endpoints.

## Available Endpoints

### List All Apps

**Endpoint:** `/api/agents/apps/list`

**Method:** GET

**Response Format:**
```json
{
  "success": true,
  "data": [
    {
      "id": "app_id",
      "name": "App Name",
      "description": "App Description",
      // Other app properties
    }
  ]
}
```

**Example Usage:**
```javascript
// Fetch all apps
const url = '/api/agents/apps/list';
const options = {
  method: 'GET'
};

try {
  const response = await fetch(url, options);
  const data = await response.json();
  
  if (data.success) {
    // Handle successful response
    console.log(data.data);
  } else {
    // Handle error
    console.error(data.error);
  }
} catch (error) {
  console.error('Error fetching apps:', error);
}
```

### Get Integration Details

**Endpoint:** `/api/agents/integrations/{integrationId}`

**Method:** GET

**Parameters:**
- `integrationId` (path parameter): The ID of the integration to fetch

**Response Format:**
```json
{
  "success": true,
  "data": {
    "id": "integration_id",
    "name": "Integration Name",
    "description": "Integration Description",
    // Other integration details
  }
}
```

**Example Usage:**
```javascript
// Fetch integration details
const integrationId = 'YOUR_INTEGRATION_ID';
const url = `/api/agents/integrations/${integrationId}`;
const options = {
  method: 'GET'
};

try {
  const response = await fetch(url, options);
  const data = await response.json();
  
  if (data.success) {
    // Handle successful response
    console.log(data.data);
  } else {
    // Handle error
    console.error(data.error);
  }
} catch (error) {
  console.error('Error fetching integration details:', error);
}
```

## Important Notes

1. **API Prefix**: Always include the `/api` prefix in your URLs when calling these endpoints.

2. **Environment Variables**: Make sure the server has the `COMPOSIO_PROJECT_API_KEY` environment variable properly configured.

3. **Error Handling**: All API responses follow the same format:
   - Success: `{ success: true, data: [...] }`
   - Error: `{ success: false, error: "Error message" }`

4. **Original Composio API**: These endpoints are proxies to the original Composio API at `https://backend.composio.dev/api/v1/apps`.

## Direct API Access (Server-side)

For server-side code, you can also use the `ComposioService` directly:

```javascript
import { ComposioService } from '@/lib/services/composio-service';

// Get all apps
const apps = await ComposioService.getIntegrations();

// Get integration by ID
const integration = await ComposioService.getIntegrationById('integration_id');
```

Note that this approach should only be used in server-side code where environment variables are accessible. 