import { findMessageByDeliveryDetails } from '@/lib/integrations/agentmail/message-updater';
import { supabaseAdmin } from '@/lib/database/supabase-server';

// Mock the supabase client
jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        filter: jest.fn(() => ({
          gte: jest.fn(() => ({
            lte: jest.fn(() => ({
              eq: jest.fn(() => ({
                order: jest.fn(() => ({
                  limit: jest.fn(() => Promise.resolve({ data: [], error: null }))
                }))
              }))
            }))
          }))
        }))
      }))
    }))
  }
}));

describe('findMessageByDeliveryDetails - Timestamp Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear console mocks
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should handle valid ISO timestamp without throwing', async () => {
    const validTimestamp = '2024-01-15T10:30:00Z';
    const recipient = 'test@example.com';
    
    const result = await findMessageByDeliveryDetails(recipient, validTimestamp);
    
    // Should not throw and should return null (no messages found in mock)
    expect(result).toBeNull();
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Invalid timestamp')
    );
  });

  it('should return null for invalid timestamp without throwing', async () => {
    const invalidTimestamp = 'not-a-valid-date';
    const recipient = 'test@example.com';
    
    const result = await findMessageByDeliveryDetails(recipient, invalidTimestamp);
    
    // Should return null without throwing
    expect(result).toBeNull();
    
    // Should log error about invalid timestamp
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid timestamp provided')
    );
  });

  it('should return null for empty timestamp without throwing', async () => {
    const emptyTimestamp = '';
    const recipient = 'test@example.com';
    
    const result = await findMessageByDeliveryDetails(recipient, emptyTimestamp);
    
    // Should return null without throwing
    expect(result).toBeNull();
    
    // Should log error about invalid timestamp
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid timestamp provided')
    );
  });

  it('should return null for malformed ISO timestamp without throwing', async () => {
    const malformedTimestamp = '2024-13-45T99:99:99Z'; // Invalid month and time
    const recipient = 'test@example.com';
    
    const result = await findMessageByDeliveryDetails(recipient, malformedTimestamp);
    
    // Should return null without throwing
    expect(result).toBeNull();
    
    // Should log error about invalid timestamp
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid timestamp provided')
    );
  });

  it('should return null for null/undefined-like strings without throwing', async () => {
    const nullishTimestamp = 'null';
    const recipient = 'test@example.com';
    
    const result = await findMessageByDeliveryDetails(recipient, nullishTimestamp);
    
    // Should return null without throwing
    expect(result).toBeNull();
    
    // Should log error about invalid timestamp
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid timestamp provided')
    );
  });

  it('should handle numeric timestamp string correctly', async () => {
    const numericTimestamp = '1705316400000'; // Unix timestamp in ms
    const recipient = 'test@example.com';
    
    const result = await findMessageByDeliveryDetails(recipient, numericTimestamp);
    
    // Should not throw and should return null (no messages found in mock)
    expect(result).toBeNull();
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Invalid timestamp')
    );
  });
});

