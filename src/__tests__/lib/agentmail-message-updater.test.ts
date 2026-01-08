import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { findMessageByDeliveryDetails } from '@/lib/integrations/agentmail/message-updater';
import { supabaseAdmin } from '@/lib/database/supabase-server';

// Mock supabaseAdmin
jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('findMessageByDeliveryDetails', () => {
  const mockFrom = supabaseAdmin.from as jest.MockedFunction<typeof supabaseAdmin.from>;
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockChain = (data: any[], error: any = null) => {
    const mockChain = {
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data, error }),
    };
    mockFrom.mockReturnValue(mockChain as any);
    return mockChain;
  };

  it('should find message with delivery.to as array', async () => {
    const testRecipient = 'test@example.com';
    const testTimestamp = new Date().toISOString();
    
    const mockMessages = [
      {
        id: 'msg-1',
        created_at: testTimestamp,
        custom_data: {
          delivery: {
            to: [testRecipient, 'other@example.com'], // Array format
            status: 'sent',
          },
        },
      },
    ];

    createMockChain(mockMessages);

    const result = await findMessageByDeliveryDetails(testRecipient, testTimestamp);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('msg-1');
  });

  it('should find message with delivery.to as string', async () => {
    const testRecipient = 'test@example.com';
    const testTimestamp = new Date().toISOString();
    
    const mockMessages = [
      {
        id: 'msg-2',
        created_at: testTimestamp,
        custom_data: {
          delivery: {
            to: testRecipient, // String format
            status: 'sent',
          },
        },
      },
    ];

    createMockChain(mockMessages);

    const result = await findMessageByDeliveryDetails(testRecipient, testTimestamp);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('msg-2');
  });

  it('should find message with delivery.details.recipient', async () => {
    const testRecipient = 'test@example.com';
    const testTimestamp = new Date().toISOString();
    
    const mockMessages = [
      {
        id: 'msg-3',
        created_at: testTimestamp,
        custom_data: {
          delivery: {
            details: {
              recipient: testRecipient, // Original format from message creation
            },
            status: 'sent',
          },
        },
      },
    ];

    createMockChain(mockMessages);

    const result = await findMessageByDeliveryDetails(testRecipient, testTimestamp);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('msg-3');
  });

  it('should find message with top-level to field', async () => {
    const testRecipient = 'test@example.com';
    const testTimestamp = new Date().toISOString();
    
    const mockMessages = [
      {
        id: 'msg-4',
        created_at: testTimestamp,
        custom_data: {
          to: testRecipient, // Top-level fallback
          delivery: {
            status: 'sent',
          },
        },
      },
    ];

    createMockChain(mockMessages);

    const result = await findMessageByDeliveryDetails(testRecipient, testTimestamp);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('msg-4');
  });

  it('should match by subject when provided', async () => {
    const testRecipient = 'test@example.com';
    const testTimestamp = new Date().toISOString();
    const testSubject = 'Important Email';
    
    const mockMessages = [
      {
        id: 'msg-wrong-subject',
        created_at: testTimestamp,
        custom_data: {
          delivery: {
            to: testRecipient,
            subject: 'Different Subject',
          },
        },
      },
      {
        id: 'msg-correct-subject',
        created_at: testTimestamp,
        custom_data: {
          delivery: {
            to: testRecipient,
            subject: testSubject,
          },
        },
      },
    ];

    createMockChain(mockMessages);

    const result = await findMessageByDeliveryDetails(testRecipient, testTimestamp, testSubject);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('msg-correct-subject');
  });

  it('should return null when subject does not match', async () => {
    const testRecipient = 'test@example.com';
    const testTimestamp = new Date().toISOString();
    const testSubject = 'Non-existent Subject';
    
    const mockMessages = [
      {
        id: 'msg-1',
        created_at: testTimestamp,
        custom_data: {
          delivery: {
            to: testRecipient,
            subject: 'Different Subject',
          },
        },
      },
    ];

    createMockChain(mockMessages);

    const result = await findMessageByDeliveryDetails(testRecipient, testTimestamp, testSubject);

    expect(result).toBeNull();
  });

  it('should return null when recipient does not match', async () => {
    const testRecipient = 'test@example.com';
    const testTimestamp = new Date().toISOString();
    
    const mockMessages = [
      {
        id: 'msg-1',
        created_at: testTimestamp,
        custom_data: {
          delivery: {
            to: 'different@example.com', // Different recipient
          },
        },
      },
    ];

    createMockChain(mockMessages);

    const result = await findMessageByDeliveryDetails(testRecipient, testTimestamp);

    expect(result).toBeNull();
  });

  it('should return null for invalid timestamp', async () => {
    const testRecipient = 'test@example.com';
    const invalidTimestamp = 'invalid-timestamp';
    
    const result = await findMessageByDeliveryDetails(testRecipient, invalidTimestamp);

    expect(result).toBeNull();
  });

  it('should return most recent message when no subject provided', async () => {
    const testRecipient = 'test@example.com';
    const baseTime = new Date('2025-01-01T12:00:00Z');
    
    const mockMessages = [
      {
        id: 'msg-newest',
        created_at: new Date(baseTime.getTime() + 2000).toISOString(),
        custom_data: {
          delivery: {
            to: testRecipient,
          },
        },
      },
      {
        id: 'msg-oldest',
        created_at: new Date(baseTime.getTime()).toISOString(),
        custom_data: {
          delivery: {
            to: testRecipient,
          },
        },
      },
    ];

    createMockChain(mockMessages);

    const result = await findMessageByDeliveryDetails(testRecipient, baseTime.toISOString());

    expect(result).not.toBeNull();
    expect(result?.id).toBe('msg-newest');
  });

  it('should check multiple subject locations', async () => {
    const testRecipient = 'test@example.com';
    const testTimestamp = new Date().toISOString();
    const testSubject = 'Test Subject';
    
    // Test subject in delivery.details.subject
    const mockMessagesDetails = [
      {
        id: 'msg-details-subject',
        created_at: testTimestamp,
        custom_data: {
          delivery: {
            to: testRecipient,
            details: {
              subject: testSubject,
            },
          },
        },
      },
    ];

    createMockChain(mockMessagesDetails);
    let result = await findMessageByDeliveryDetails(testRecipient, testTimestamp, testSubject);
    expect(result?.id).toBe('msg-details-subject');

    jest.clearAllMocks();

    // Test subject in top-level custom_data.subject
    const mockMessagesTopLevel = [
      {
        id: 'msg-toplevel-subject',
        created_at: testTimestamp,
        custom_data: {
          delivery: {
            to: testRecipient,
          },
          subject: testSubject,
        },
      },
    ];

    createMockChain(mockMessagesTopLevel);
    result = await findMessageByDeliveryDetails(testRecipient, testTimestamp, testSubject);
    expect(result?.id).toBe('msg-toplevel-subject');
  });
});

