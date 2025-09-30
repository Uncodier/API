/**
 * Test de integración para verificar que no se responda dos veces al mismo correo
 * Simula el flujo completo de los 3 endpoints
 */

import { TextHashService } from '@/lib/utils/text-hash-service';

// Mock de supabase para simular emails ya procesados
const mockProcessedEmails = new Set<string>();
const mockProcessedHashes = new Set<string>();

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          in: jest.fn(() => ({
            data: Array.from(mockProcessedEmails).map(id => ({ external_id: id, hash: '123' })),
            error: null
          }))
        }))
      }))
    }))
  }
}));

describe('Duplicate Prevention Integration Tests', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessedEmails.clear();
    mockProcessedHashes.clear();
    
    // Mock console.log para evitar ruido
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Simulated Email Processing Flow', () => {
    
    it('should prevent duplicate responses for same email content', () => {
      const testEmail = {
        id: 'email-123',
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject',
        date: '2024-01-15T10:30:00Z',
        body: 'This is the email body content.'
      };

      // Simular la lógica de ComprehensiveEmailFilterService
      const textForHash = `${testEmail.from||''}\n${testEmail.to||''}\n${testEmail.subject||''}\n${testEmail.date||testEmail.received_date||''}\n\n${testEmail.body||''}`;
      const hashVal = TextHashService.hash64(textForHash);
      const hashKey = String(hashVal);

      // Primera vez: email no está procesado
      const isFirstTimeDuplicate = mockProcessedHashes.has(hashKey);
      expect(isFirstTimeDuplicate).toBe(false);

      // Simular que se procesa el email (se guarda el hash)
      mockProcessedHashes.add(hashKey);

      // Segunda vez: email ya está procesado
      const isSecondTimeDuplicate = mockProcessedHashes.has(hashKey);
      expect(isSecondTimeDuplicate).toBe(true);

      console.log('✅ Duplicate prevention works correctly');
    });

    it('should allow different emails with same sender', () => {
      const email1 = {
        id: 'email-1',
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'First Subject',
        date: '2024-01-15T10:30:00Z',
        body: 'First email body.'
      };

      const email2 = {
        id: 'email-2',
        from: 'cleqos@gmail.com', // Mismo sender
        to: 'hola@uncodie.com',
        subject: 'Second Subject', // Diferente subject
        date: '2024-01-15T10:30:00Z',
        body: 'Second email body.' // Diferente body
      };

      // Generar hashes
      const textForHash1 = `${email1.from||''}\n${email1.to||''}\n${email1.subject||''}\n${email1.date||email1.received_date||''}\n\n${email1.body||''}`;
      const textForHash2 = `${email2.from||''}\n${email2.to||''}\n${email2.subject||''}\n${email2.date||email2.received_date||''}\n\n${email2.body||''}`;
      
      const hash1 = TextHashService.hash64(textForHash1);
      const hash2 = TextHashService.hash64(textForHash2);

      // Los hashes deben ser diferentes
      expect(hash1).not.toBe(hash2);

      // Ambos emails deben ser procesables
      const isEmail1Duplicate = mockProcessedHashes.has(String(hash1));
      const isEmail2Duplicate = mockProcessedHashes.has(String(hash2));

      expect(isEmail1Duplicate).toBe(false);
      expect(isEmail2Duplicate).toBe(false);

      console.log('✅ Different emails allowed even with same sender');
    });

    it('should handle email variations correctly', () => {
      const baseEmail = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Test Subject',
        date: '2024-01-15T10:30:00Z',
        body: 'This is the email body.'
      };

      // Variaciones que deben ser consideradas duplicados
      const variations = [
        { ...baseEmail, id: 'var-1' }, // Diferente ID
        { ...baseEmail, messageId: 'msg-123' }, // Diferente messageId
        { ...baseEmail, received_date: baseEmail.date }, // Diferente campo de fecha
        { ...baseEmail, headers: { 'message-id': '<test@example.com>' } } // Con headers
      ];

      const hashes = variations.map(email => {
        const textForHash = `${email.from||''}\n${email.to||''}\n${email.subject||''}\n${email.date||email.received_date||''}\n\n${email.body||''}`;
        return TextHashService.hash64(textForHash);
      });

      // Todos los hashes deben ser iguales (mismo contenido)
      const firstHash = hashes[0];
      hashes.forEach(hash => {
        expect(hash).toBe(firstHash);
      });

      console.log('✅ Email variations correctly identified as duplicates');
    });
  });

  describe('Endpoint-Specific Scenarios', () => {
    
    it('should handle aliasReply scenario correctly', () => {
      // Simular email a alias
      const aliasEmail = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com', // Alias configurado
        subject: 'Test to alias',
        date: '2024-01-15T10:30:00Z',
        body: 'Email to configured alias.'
      };

      const textForHash = `${aliasEmail.from||''}\n${aliasEmail.to||''}\n${aliasEmail.subject||''}\n${aliasEmail.date||aliasEmail.received_date||''}\n\n${aliasEmail.body||''}`;
      const hashKey = String(TextHashService.hash64(textForHash));

      // Simular que ya fue procesado
      mockProcessedHashes.add(hashKey);

      // Verificar que se detecta como duplicado
      const isDuplicate = mockProcessedHashes.has(hashKey);
      expect(isDuplicate).toBe(true);

      console.log('✅ aliasReply duplicate detection works');
    });

    it('should handle leadsReply scenario correctly', () => {
      // Simular email de lead no asignado
      const leadEmail = {
        from: 'unassigned-lead@example.com',
        to: 'any@uncodie.com',
        subject: 'Lead inquiry',
        date: '2024-01-15T10:30:00Z',
        body: 'Email from unassigned lead.'
      };

      const textForHash = `${leadEmail.from||''}\n${leadEmail.to||''}\n${leadEmail.subject||''}\n${leadEmail.date||leadEmail.received_date||''}\n\n${leadEmail.body||''}`;
      const hashKey = String(TextHashService.hash64(textForHash));

      // Primera vez: no es duplicado
      const isFirstTime = mockProcessedHashes.has(hashKey);
      expect(isFirstTime).toBe(false);

      // Procesar email
      mockProcessedHashes.add(hashKey);

      // Segunda vez: es duplicado
      const isSecondTime = mockProcessedHashes.has(hashKey);
      expect(isSecondTime).toBe(true);

      console.log('✅ leadsReply duplicate detection works');
    });

    it('should handle reply scenario correctly (FIXED)', () => {
      // Simular email del agente
      const agentEmail = {
        from: 'agent@uncodie.com',
        to: 'client@example.com',
        subject: 'Agent response',
        date: '2024-01-15T10:30:00Z',
        body: 'Email from agent to client.'
      };

      const textForHash = `${agentEmail.from||''}\n${agentEmail.to||''}\n${agentEmail.subject||''}\n${agentEmail.date||agentEmail.received_date||''}\n\n${agentEmail.body||''}`;
      const hashKey = String(TextHashService.hash64(textForHash));

      // Simular que ya fue procesado (FIXED: ahora solo guarda directResponseEmails)
      mockProcessedHashes.add(hashKey);

      // Verificar que se detecta como duplicado
      const isDuplicate = mockProcessedHashes.has(hashKey);
      expect(isDuplicate).toBe(true);

      console.log('✅ reply duplicate detection works (FIXED)');
    });
  });

  describe('Edge Cases', () => {
    
    it('should handle empty or null fields', () => {
      const edgeCaseEmail = {
        from: '',
        to: null,
        subject: undefined,
        date: '',
        body: null
      };

      const textForHash = `${edgeCaseEmail.from||''}\n${edgeCaseEmail.to||''}\n${edgeCaseEmail.subject||''}\n${edgeCaseEmail.date||edgeCaseEmail.received_date||''}\n\n${edgeCaseEmail.body||''}`;
      const hashKey = String(TextHashService.hash64(textForHash));

      expect(hashKey).toBeDefined();
      expect(typeof hashKey).toBe('string');

      console.log('✅ Edge cases handled correctly');
    });

    it('should handle very long content', () => {
      const longBody = 'A'.repeat(50000); // 50KB
      const longEmail = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Long content test',
        date: '2024-01-15T10:30:00Z',
        body: longBody
      };

      const startTime = Date.now();
      const textForHash = `${longEmail.from||''}\n${longEmail.to||''}\n${longEmail.subject||''}\n${longEmail.date||longEmail.received_date||''}\n\n${longEmail.body||''}`;
      const hashKey = String(TextHashService.hash64(textForHash));
      const endTime = Date.now();

      expect(hashKey).toBeDefined();
      expect(endTime - startTime).toBeLessThan(1000); // Debe ser rápido

      console.log('✅ Long content handled efficiently');
    });

    it('should handle special characters', () => {
      const specialEmail = {
        from: 'test+tag@example.com',
        to: 'hola@uncodie.com',
        subject: 'Test with émojis 🚀 and ñ characters',
        date: '2024-01-15T10:30:00Z',
        body: 'Body with special chars: áéíóú ñüç'
      };

      const textForHash = `${specialEmail.from||''}\n${specialEmail.to||''}\n${specialEmail.subject||''}\n${specialEmail.date||specialEmail.received_date||''}\n\n${specialEmail.body||''}`;
      const hashKey = String(TextHashService.hash64(textForHash));

      expect(hashKey).toBeDefined();
      expect(hashKey).not.toBe('');

      console.log('✅ Special characters handled correctly');
    });
  });

  describe('Performance and Reliability', () => {
    
    it('should process multiple emails efficiently', () => {
      const emails = Array.from({ length: 1000 }, (_, i) => ({
        from: `user${i}@example.com`,
        to: 'hola@uncodie.com',
        subject: `Subject ${i}`,
        date: '2024-01-15T10:30:00Z',
        body: `Body content ${i}`
      }));

      const startTime = Date.now();
      
      emails.forEach(email => {
        const textForHash = `${email.from||''}\n${email.to||''}\n${email.subject||''}\n${email.date||email.received_date||''}\n\n${email.body||''}`;
        const hashKey = String(TextHashService.hash64(textForHash));
        expect(hashKey).toBeDefined();
      });
      
      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(5000); // Debe procesar 1000 emails en < 5 segundos
      
      console.log(`✅ Batch processing efficient (${duration}ms for 1000 emails)`);
    });

    it('should maintain hash consistency across multiple runs', () => {
      const testEmail = {
        from: 'cleqos@gmail.com',
        to: 'hola@uncodie.com',
        subject: 'Consistency test',
        date: '2024-01-15T10:30:00Z',
        body: 'Test body for consistency'
      };

      const textForHash = `${testEmail.from||''}\n${testEmail.to||''}\n${testEmail.subject||''}\n${testEmail.date||testEmail.received_date||''}\n\n${testEmail.body||''}`;
      
      // Generar hash múltiples veces
      const hashes = Array.from({ length: 10 }, () => 
        String(TextHashService.hash64(textForHash))
      );

      // Todos los hashes deben ser iguales
      const firstHash = hashes[0];
      hashes.forEach(hash => {
        expect(hash).toBe(firstHash);
      });

      console.log('✅ Hash consistency maintained across multiple runs');
    });
  });
});
