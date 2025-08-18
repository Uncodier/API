import { POST, GET } from '@/app/api/agents/tools/validateEmail/route';
import { NextRequest } from 'next/server';

// Mock DNS module
jest.mock('dns', () => ({
  promises: {
    resolveMx: jest.fn()
  }
}));

// Mock net module
const mockSocket = {
  connect: jest.fn(),
  write: jest.fn(),
  destroy: jest.fn(),
  on: jest.fn(),
  once: jest.fn()
};

jest.mock('net', () => ({
  Socket: jest.fn().mockImplementation(() => mockSocket)
}));

// Mock tls module
jest.mock('tls', () => ({
  connect: jest.fn()
}));

const { promises: dns } = require('dns');

describe('/api/agents/tools/validateEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.setTimeout(30000); // 30 second timeout for tests
  });

  describe('POST', () => {
    it('should return error when email is not provided', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
        method: 'POST',
        body: JSON.stringify({})
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('EMAIL_REQUIRED');
    });

    it('should return invalid for malformed email', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'invalid-email'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.isValid).toBe(false);
      expect(data.data.result).toBe('invalid');
      expect(data.data.flags).toContain('invalid_format');
    });

    it('should return disposable for known disposable email domains', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@10minutemail.com'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.isValid).toBe(false);
      expect(data.data.result).toBe('disposable');
      expect(data.data.flags).toContain('disposable_email');
    });

    it('should return invalid when domain has no MX records', async () => {
      // Mock DNS to throw error (no MX records)
      dns.resolveMx.mockRejectedValue(new Error('ENOTFOUND'));

      const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@nonexistentdomain12345.com'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.isValid).toBe(false);
      expect(data.data.result).toBe('invalid');
      expect(data.data.flags).toContain('no_mx_record');
    });

    it('should return invalid when domain has empty MX records', async () => {
      // Mock DNS to return empty array
      dns.resolveMx.mockResolvedValue([]);

      const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@emptymx.com'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.isValid).toBe(false);
      expect(data.data.result).toBe('invalid');
      expect(data.data.flags).toContain('no_mx_record');
    });

    it('should handle SMTP validation with valid MX records', async () => {
      // Mock DNS to return MX records
      dns.resolveMx.mockResolvedValue([
        { exchange: 'mx1.example.com', priority: 10 },
        { exchange: 'mx2.example.com', priority: 20 }
      ]);

      // Mock socket connection to simulate SMTP responses
      mockSocket.connect.mockImplementation((port, host, callback) => {
        // Simulate successful connection
        setTimeout(callback, 10);
      });

      // Mock SMTP responses
      let responseIndex = 0;
      const responses = [
        '220 mx1.example.com ESMTP ready\r\n',
        '250 mx1.example.com Hello\r\n',
        '250 OK\r\n',
        '550 5.1.1 User unknown\r\n'
      ];

      mockSocket.once.mockImplementation((event, callback) => {
        if (event === 'data') {
          setTimeout(() => {
            callback(Buffer.from(responses[responseIndex++] || '250 OK\r\n'));
          }, 10);
        }
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@example.com'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.email).toBe('test@example.com');
      expect(data.data).toHaveProperty('isValid');
      expect(data.data).toHaveProperty('result');
      expect(data.data).toHaveProperty('flags');
      expect(data.data).toHaveProperty('execution_time');
      expect(data.data).toHaveProperty('timestamp');
      expect(typeof data.data.execution_time).toBe('number');
    }, 10000);

    it('should return proper response structure matching neverbounce format', async () => {
      const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'invalid-format'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data).toHaveProperty('success');
      expect(data.data).toHaveProperty('email');
      expect(data.data).toHaveProperty('isValid');
      expect(data.data).toHaveProperty('result');
      expect(data.data).toHaveProperty('flags');
      expect(data.data).toHaveProperty('suggested_correction');
      expect(data.data).toHaveProperty('execution_time');
      expect(data.data).toHaveProperty('message');
      expect(data.data).toHaveProperty('timestamp');
      
      expect(Array.isArray(data.data.flags)).toBe(true);
      expect(typeof data.data.isValid).toBe('boolean');
      expect(typeof data.data.execution_time).toBe('number');
    });

    it('should handle internal server errors gracefully', async () => {
      // Mock DNS to throw unexpected error
      dns.resolveMx.mockImplementation(() => {
        throw new Error('Unexpected DNS error');
      });

      const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@example.com'
        })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
    });

    it('should validate email format correctly', async () => {
      const validEmails = [
        'test@example.com',
        'user.name@domain.co.uk',
        'user+tag@example.org',
        'user123@test-domain.com'
      ];

      const invalidEmails = [
        'invalid-email',
        '@example.com',
        'test@',
        'test..test@example.com',
        'test@.com',
        'test@com',
        ''
      ];

      for (const email of validEmails) {
        const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
          method: 'POST',
          body: JSON.stringify({ email })
        });

        const response = await POST(request);
        const data = await response.json();

        // Should not fail on format validation (might fail on other checks)
        expect(data.data.flags).not.toContain('invalid_format');
      }

      for (const email of invalidEmails) {
        const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
          method: 'POST',
          body: JSON.stringify({ email })
        });

        const response = await POST(request);
        const data = await response.json();

        if (email === '') {
          expect(data.error?.code).toBe('EMAIL_REQUIRED');
        } else {
          expect(data.data.flags).toContain('invalid_format');
        }
      }
    });
  });

  describe('GET', () => {
    it('should return service information', async () => {
      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.service).toBe('SMTP Email Validation');
      expect(data.data.version).toBe('1.0.0');
      expect(data.data).toHaveProperty('description');
      expect(data.data).toHaveProperty('endpoints');
      expect(data.data).toHaveProperty('features');
      expect(data.data).toHaveProperty('timestamp');
      
      expect(Array.isArray(data.data.features)).toBe(true);
      expect(data.data.features.length).toBeGreaterThan(0);
    });

    it('should include proper endpoint documentation', async () => {
      const response = await GET();
      const data = await response.json();

      expect(data.data.endpoints.validate).toHaveProperty('method');
      expect(data.data.endpoints.validate).toHaveProperty('path');
      expect(data.data.endpoints.validate).toHaveProperty('description');
      expect(data.data.endpoints.validate).toHaveProperty('body');
      expect(data.data.endpoints.validate).toHaveProperty('response');
      
      expect(data.data.endpoints.validate.method).toBe('POST');
      expect(data.data.endpoints.validate.path).toBe('/api/agents/tools/validateEmail');
    });
  });

  describe('Email validation logic', () => {
    it('should detect disposable email domains correctly', async () => {
      const disposableDomains = [
        '10minutemail.com',
        'tempmail.org',
        'guerrillamail.com',
        'mailinator.com',
        'yopmail.com'
      ];

      for (const domain of disposableDomains) {
        const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
          method: 'POST',
          body: JSON.stringify({
            email: `test@${domain}`
          })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(data.data.result).toBe('disposable');
        expect(data.data.flags).toContain('disposable_email');
        expect(data.data.isValid).toBe(false);
      }
    });

    it('should extract domain correctly from email', async () => {
      const testCases = [
        { email: 'test@example.com', expectedDomain: 'example.com' },
        { email: 'user.name@sub.domain.co.uk', expectedDomain: 'sub.domain.co.uk' },
        { email: 'user+tag@test-domain.org', expectedDomain: 'test-domain.org' }
      ];

      // Since domain extraction is internal, we test it indirectly through MX lookup
      for (const testCase of testCases) {
        dns.resolveMx.mockRejectedValue(new Error('ENOTFOUND'));

        const request = new NextRequest('http://localhost:3000/api/agents/tools/validateEmail', {
          method: 'POST',
          body: JSON.stringify({
            email: testCase.email
          })
        });

        await POST(request);

        // Verify that resolveMx was called with the correct domain
        expect(dns.resolveMx).toHaveBeenCalledWith(testCase.expectedDomain);
      }
    });
  });
});
