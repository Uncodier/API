/**
 * Tests para MailboxDetectorService
 * Verifica la detección inteligente de carpetas multi-proveedor y multi-idioma
 */

import { MailboxDetectorService, MailboxInfo } from '../MailboxDetectorService';

describe('MailboxDetectorService', () => {
  
  describe('detectProvider', () => {
    it('should detect Gmail provider by host', () => {
      const provider = MailboxDetectorService.detectProvider('imap.gmail.com', 'user@example.com');
      expect(provider).toBe('gmail');
    });
    
    it('should detect Gmail provider by email domain', () => {
      const provider = MailboxDetectorService.detectProvider('imap.custom.com', 'user@gmail.com');
      expect(provider).toBe('gmail');
    });
    
    it('should detect Outlook provider', () => {
      const provider = MailboxDetectorService.detectProvider('outlook.office365.com', 'user@outlook.com');
      expect(provider).toBe('outlook');
    });
    
    it('should return null for unknown provider', () => {
      const provider = MailboxDetectorService.detectProvider('imap.custom.com', 'user@custom.com');
      expect(provider).toBeNull();
    });
  });

  describe('detectSentFolder', () => {
    
    it('should detect Spanish "Enviados" folder (case from user logs)', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { name: 'Destacados', path: 'Destacados' },
        { name: 'Enviados', path: 'Enviados' }, // This is the actual case from user logs
        { name: 'Borradores', path: 'Borradores' },
        { name: 'Todos', path: 'Todos' },
        { name: 'Spam', path: 'Spam' },
        { name: 'Papelera', path: 'Papelera' },
        { name: '[Gmail]', path: '[Gmail]' },
        { name: 'Importantes', path: 'Importantes' },
        { name: 'Notes', path: 'Notes' }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes, 'imap.gmail.com', 'sergio@uncodie.com');
      
             expect(result.found).toBe(true);
       expect(result.folderName).toBe('Enviados');
       expect(result.confidence).toBe(0.95);
       expect(result.method).toBe('provider-specific');
       expect(result.provider).toBe('gmail');
    });
    
    it('should detect Gmail sent folder in English', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { name: '[Gmail]/Sent Mail', path: '[Gmail]/Sent Mail' },
        { name: '[Gmail]/Drafts', path: '[Gmail]/Drafts' }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes, 'imap.gmail.com', 'user@gmail.com');
      
      expect(result.found).toBe(true);
      expect(result.folderName).toBe('[Gmail]/Sent Mail');
      expect(result.method).toBe('provider-specific');
      expect(result.provider).toBe('gmail');
    });
    
    it('should detect Outlook sent folder in Spanish', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { name: 'Elementos enviados', path: 'Elementos enviados' },
        { name: 'Borradores', path: 'Borradores' }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes, 'outlook.office365.com', 'user@outlook.com');
      
      expect(result.found).toBe(true);
      expect(result.folderName).toBe('Elementos enviados');
      expect(result.method).toBe('provider-specific');
      expect(result.provider).toBe('outlook');
    });
    
    it('should detect French sent folder', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { name: 'Envoyés', path: 'Envoyés' },
        { name: 'Brouillons', path: 'Brouillons' }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes);
      
      expect(result.found).toBe(true);
      expect(result.folderName).toBe('Envoyés');
      expect(result.confidence).toBe(1.0);
      expect(result.method).toBe('language-mapping');
    });
    
    it('should detect German sent folder', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { name: 'Gesendete Elemente', path: 'Gesendete Elemente' },
        { name: 'Entwürfe', path: 'Entwürfe' }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes);
      
      expect(result.found).toBe(true);
      expect(result.folderName).toBe('Gesendete Elemente');
      expect(result.confidence).toBe(1.0);
      expect(result.method).toBe('language-mapping');
    });
    
    it('should detect Italian sent folder', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { name: 'Posta inviata', path: 'Posta inviata' },
        { name: 'Bozze', path: 'Bozze' }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes);
      
      expect(result.found).toBe(true);
      expect(result.folderName).toBe('Posta inviata');
      expect(result.confidence).toBe(1.0);
      expect(result.method).toBe('language-mapping');
    });
    
    it('should use SPECIAL-USE attributes when available', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { 
          name: 'Custom Sent Name', 
          path: 'Custom Sent Name',
          attributes: ['\\Sent'],
          specialUse: '\\Sent'
        }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes);
      
      expect(result.found).toBe(true);
      expect(result.folderName).toBe('Custom Sent Name');
      expect(result.confidence).toBe(1.0);
      expect(result.method).toBe('special-use');
    });
    
    it('should use similarity matching for close matches', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { name: 'Enviado', path: 'Enviado' }, // Close to "Enviados"
        { name: 'Borrador', path: 'Borrador' }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes);
      
      expect(result.found).toBe(true);
      expect(result.folderName).toBe('Enviado');
      expect(result.method).toBe('similarity');
      expect(result.confidence).toBeGreaterThan(0.7);
    });
    
    it('should fall back to common names', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { name: 'Sent', path: 'Sent' },
        { name: 'Drafts', path: 'Drafts' }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes);
      
      expect(result.found).toBe(true);
      expect(result.folderName).toBe('Sent');
      expect(result.method).toBe('language-mapping');
    });
    
    it('should return not found when no sent folder is detected', () => {
      const mailboxes: MailboxInfo[] = [
        { name: 'INBOX', path: 'INBOX' },
        { name: 'Custom1', path: 'Custom1' },
        { name: 'Custom2', path: 'Custom2' }
      ];
      
      const result = MailboxDetectorService.detectSentFolder(mailboxes);
      
      expect(result.found).toBe(false);
      expect(result.confidence).toBe(0);
    });
  });
  
  describe('normalizeMailboxInfo', () => {
    it('should normalize ImapFlow mailbox data', () => {
      const imapMailboxes = [
        {
          name: 'INBOX',
          path: 'INBOX',
          flags: ['\\HasNoChildren'],
          delimiter: '/'
        },
        {
          name: 'Enviados',
          path: 'Enviados',
          flags: ['\\HasNoChildren', '\\Sent'],
          delimiter: '/'
        }
      ];
      
      const normalized = MailboxDetectorService.normalizeMailboxInfo(imapMailboxes);
      
      expect(normalized).toHaveLength(2);
      expect(normalized[0]).toEqual({
        name: 'INBOX',
        path: 'INBOX',
        attributes: ['\\HasNoChildren'],
        delimiter: '/'
      });
      expect(normalized[1]).toEqual({
        name: 'Enviados',
        path: 'Enviados',
        attributes: ['\\HasNoChildren', '\\Sent'],
        delimiter: '/'
      });
    });
  });
}); 