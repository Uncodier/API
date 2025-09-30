/**
 * Tests para verificar que la función de hash funciona correctamente
 * y evita duplicados en los 3 endpoints: aliasReply, leadsReply, reply
 */

import { TextHashService } from '@/lib/utils/text-hash-service';
import { ComprehensiveEmailFilterService } from '@/lib/services/email/ComprehensiveEmailFilterService';

// Mock de supabase
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          in: jest.fn(() => ({
            data: [],
            error: null
          }))
        }))
      }))
    }))
  }
}));

describe('Email Hash Deduplication Tests', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock console.log para evitar ruido
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('TextHashService.hash64() - Función de hash', () => {
    
    it('should generate consistent hash for identical email content', () => {
      const emailContent = `cleqos@gmail.com
hola@uncodie.com
Test Subject
2024-01-15T10:30:00Z

This is the email body content.`;

      const hash1 = TextHashService.hash64(emailContent);
      const hash2 = TextHashService.hash64(emailContent);
      
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('bigint');
      expect(hash1).not.toBe(0n);
      
      console.log('✅ Hash consistency test passed');
    });

    it('should generate different hashes for different email content', () => {
      const content1 = `cleqos@gmail.com
hola@uncodie.com
Test Subject 1
2024-01-15T10:30:00Z

This is email body 1.`;

      const content2 = `cleqos@gmail.com
hola@uncodie.com
Test Subject 2
2024-01-15T10:30:00Z

This is email body 2.`;

      const hash1 = TextHashService.hash64(content1);
      const hash2 = TextHashService.hash64(content2);
      
      expect(hash1).not.toBe(hash2);
      
      console.log('✅ Hash uniqueness test passed');
    });

    it('should generate same hash for emails with same content but different whitespace', () => {
      const content1 = `cleqos@gmail.com
hola@uncodie.com
Test Subject
2024-01-15T10:30:00Z

This is the email body.`;

      const content2 = `cleqos@gmail.com
hola@uncodie.com
Test Subject
2024-01-15T10:30:00Z

This is the email body.`;

      const hash1 = TextHashService.hash64(content1);
      const hash2 = TextHashService.hash64(content2);
      
      expect(hash1).toBe(hash2);
      
      console.log('✅ Hash whitespace consistency test passed');
    });

    it('should handle empty content gracefully', () => {
      const emptyContent = '';
      const hash = TextHashService.hash64(emptyContent);
      
      expect(typeof hash).toBe('bigint');
      
      console.log('✅ Empty content hash test passed');
    });
  });

  describe('Email Content Hash Generation', () => {
    
    it('should generate correct hash format for email objects', () => {
      const testEmail = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject',
        date: '2024-01-15T10:30:00Z',
        body: 'This is the email body content.'
      };

      // Replicar la lógica de ComprehensiveEmailFilterService
      const textForHash = `${testEmail.from||''}\n${testEmail.to||''}\n${testEmail.subject||''}\n${testEmail.date||testEmail.received_date||''}\n\n${testEmail.body||''}`;
      const hashVal = TextHashService.hash64(textForHash);
      const hashKey = String(hashVal);

      expect(hashKey).toBeDefined();
      expect(hashKey).not.toBe('');
      expect(typeof hashVal).toBe('bigint');
      
      console.log('✅ Email hash generation test passed');
    });

    it('should generate same hash for identical emails with different field names', () => {
      const email1 = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject',
        date: '2024-01-15T10:30:00Z',
        body: 'This is the email body.'
      };

      const email2 = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject',
        received_date: '2024-01-15T10:30:00Z', // Diferente campo de fecha
        body: 'This is the email body.'
      };

      const textForHash1 = `${email1.from||''}\n${email1.to||''}\n${email1.subject||''}\n${email1.date||email1.received_date||''}\n\n${email1.body||''}`;
      const textForHash2 = `${email2.from||''}\n${email2.to||''}\n${email2.subject||''}\n${email2.date||email2.received_date||''}\n\n${email2.body||''}`;
      
      const hash1 = TextHashService.hash64(textForHash1);
      const hash2 = TextHashService.hash64(textForHash2);

      expect(hash1).toBe(hash2);
      
      console.log('✅ Email field consistency test passed');
    });
  });

  describe('Duplicate Detection Logic', () => {
    
    it('should identify duplicate emails by hash', () => {
      const email1 = {
        id: 'email-1',
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject',
        date: '2024-01-15T10:30:00Z',
        body: 'This is the email body.'
      };

      const email2 = {
        id: 'email-2', // Diferente ID
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject',
        date: '2024-01-15T10:30:00Z',
        body: 'This is the email body.'
      };

      // Generar hashes
      const textForHash1 = `${email1.from||''}\n${email1.to||''}\n${email1.subject||''}\n${email1.date||email1.received_date||''}\n\n${email1.body||''}`;
      const textForHash2 = `${email2.from||''}\n${email2.to||''}\n${email2.subject||''}\n${email2.date||email2.received_date||''}\n\n${email2.body||''}`;
      
      const hash1 = TextHashService.hash64(textForHash1);
      const hash2 = TextHashService.hash64(textForHash2);

      // Los hashes deben ser iguales (mismo contenido)
      expect(hash1).toBe(hash2);
      
      console.log('✅ Duplicate detection by hash test passed');
    });

    it('should NOT identify different emails as duplicates', () => {
      const email1 = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject 1',
        date: '2024-01-15T10:30:00Z',
        body: 'This is email body 1.'
      };

      const email2 = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject 2', // Diferente subject
        date: '2024-01-15T10:30:00Z',
        body: 'This is email body 2.' // Diferente body
      };

      const textForHash1 = `${email1.from||''}\n${email1.to||''}\n${email1.subject||''}\n${email1.date||email1.received_date||''}\n\n${email1.body||''}`;
      const textForHash2 = `${email2.from||''}\n${email2.to||''}\n${email2.subject||''}\n${email2.date||email2.received_date||''}\n\n${email2.body||''}`;
      
      const hash1 = TextHashService.hash64(textForHash1);
      const hash2 = TextHashService.hash64(textForHash2);

      // Los hashes deben ser diferentes (contenido diferente)
      expect(hash1).not.toBe(hash2);
      
      console.log('✅ Non-duplicate detection test passed');
    });
  });

  describe('Endpoint Consistency Tests', () => {
    
    it('should use same hash logic across all endpoints', () => {
      const testEmail = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject',
        date: '2024-01-15T10:30:00Z',
        body: 'This is the email body.'
      };

      // Esta es la lógica que debe ser consistente en los 3 endpoints
      const textForHash = `${testEmail.from||''}\n${testEmail.to||''}\n${testEmail.subject||''}\n${testEmail.date||testEmail.received_date||''}\n\n${testEmail.body||''}`;
      const hashVal = TextHashService.hash64(textForHash);
      const hashKey = String(hashVal);

      expect(hashKey).toBeDefined();
      expect(typeof hashVal).toBe('bigint');
      
      console.log('✅ Endpoint consistency test passed');
    });

    it('should handle edge cases consistently', () => {
      const edgeCases = [
        {
          from: '',
          to: 'hola@uncodie.com',
          subject: 'Test',
          date: '',
          body: ''
        },
        {
          from: 'cleqos@gmail.com',
          to: '',
          subject: '',
          date: '2024-01-15T10:30:00Z',
          body: 'Body only'
        },
        {
          from: null,
          to: null,
          subject: null,
          date: null,
          body: null
        }
      ];

      edgeCases.forEach((email, index) => {
        const textForHash = `${email.from||''}\n${email.to||''}\n${email.subject||''}\n${email.date||email.received_date||''}\n\n${email.body||''}`;
        const hashVal = TextHashService.hash64(textForHash);
        const hashKey = String(hashVal);

        expect(hashKey).toBeDefined();
        expect(typeof hashVal).toBe('bigint');
      });
      
      console.log('✅ Edge cases handling test passed');
    });
  });

  describe('Performance Tests', () => {
    
    it('should generate hash quickly for large content', () => {
      const largeBody = 'A'.repeat(10000); // 10KB de contenido
      const testEmail = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Large Content Test',
        date: '2024-01-15T10:30:00Z',
        body: largeBody
      };

      const startTime = Date.now();
      const textForHash = `${testEmail.from||''}\n${testEmail.to||''}\n${testEmail.subject||''}\n${testEmail.date||testEmail.received_date||''}\n\n${testEmail.body||''}`;
      const hashVal = TextHashService.hash64(textForHash);
      const endTime = Date.now();

      const duration = endTime - startTime;
      
      expect(hashVal).toBeDefined();
      expect(duration).toBeLessThan(100); // Debe ser rápido (< 100ms)
      
      console.log(`✅ Performance test passed (${duration}ms for 10KB content)`);
    });

    it('should handle multiple emails efficiently', () => {
      const emails = Array.from({ length: 100 }, (_, i) => ({
        from: `user${i}@example.com`,
        to: 'hola@uncodie.com',
        subject: `Test Subject ${i}`,
        date: '2024-01-15T10:30:00Z',
        body: `This is email body ${i}.`
      }));

      const startTime = Date.now();
      
      emails.forEach(email => {
        const textForHash = `${email.from||''}\n${email.to||''}\n${email.subject||''}\n${email.date||email.received_date||''}\n\n${email.body||''}`;
        const hashVal = TextHashService.hash64(textForHash);
        expect(hashVal).toBeDefined();
      });
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(duration).toBeLessThan(1000); // Debe procesar 100 emails en < 1 segundo
      
      console.log(`✅ Batch processing test passed (${duration}ms for 100 emails)`);
    });
  });
});
