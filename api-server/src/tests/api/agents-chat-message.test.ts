import { describe, it, expect, jest } from '@jest/globals';
import { NextRequest } from 'next/server';

// Mock supabase client
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockReturnValue({
            data: null,
            error: { message: 'Agent not found' }
          })
        })
      })
    })
  }
}));

// Mock the ProcessorInitializer
jest.mock('@/lib/agentbase', () => ({
  ProcessorInitializer: {
    getInstance: jest.fn().mockReturnValue({
      initialize: jest.fn(),
      getCommandService: jest.fn().mockReturnValue({
        submitCommand: jest.fn().mockReturnValue('cmd_123'),
        getCommandById: jest.fn().mockReturnValue(null)
      })
    })
  },
  CommandFactory: {
    createCommand: jest.fn().mockReturnValue({})
  }
}));

// Import the required functions/components
import { POST } from '@/app/api/agents/chat/message/route';

describe('Chat Message API', () => {
  it('should reject requests with missing message', async () => {
    // Create a mock request with missing message
    const request = new NextRequest('http://localhost:3000/api/agents/chat/message', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-uuid-123456',
        site_id: 'site-uuid-123456'
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    // Execute the POST handler
    const response = await POST(request);
    
    // Convert the response to JSON for assertions
    const responseData = await response.json();
    
    // Verify the response structure
    expect(response.status).toBe(400);
    expect(responseData).toHaveProperty('success', false);
    expect(responseData.error).toHaveProperty('code', 'INVALID_REQUEST');
    expect(responseData.error).toHaveProperty('message', 'message is required');
  });
  
  it('should reject requests with missing agentId', async () => {
    // Create a mock request with missing agentId
    const request = new NextRequest('http://localhost:3000/api/agents/chat/message', {
      method: 'POST',
      body: JSON.stringify({
        message: 'Hello, can you help me?',
        site_id: 'site-uuid-123456'
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    // Execute the POST handler
    const response = await POST(request);
    
    // Convert the response to JSON for assertions
    const responseData = await response.json();
    
    // Verify the response structure
    expect(response.status).toBe(400);
    expect(responseData).toHaveProperty('success', false);
    expect(responseData.error).toHaveProperty('code', 'INVALID_REQUEST');
    expect(responseData.error).toHaveProperty('message', 'agentId is required');
  });
  
  it('should reject requests with missing site_id', async () => {
    // Create a mock request with missing site_id
    const request = new NextRequest('http://localhost:3000/api/agents/chat/message', {
      method: 'POST',
      body: JSON.stringify({
        message: 'Hello, can you help me?',
        agentId: 'agent-uuid-123456'
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    // Execute the POST handler
    const response = await POST(request);
    
    // Convert the response to JSON for assertions
    const responseData = await response.json();
    
    // Verify the response structure
    expect(response.status).toBe(400);
    expect(responseData).toHaveProperty('success', false);
    expect(responseData.error).toHaveProperty('code', 'INVALID_REQUEST');
    expect(responseData.error).toHaveProperty('message', 'site_id is required');
  });
}); 