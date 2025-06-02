import { describe, it, expect } from '@jest/globals';
import { EmailTextExtractorService } from '../EmailTextExtractorService';

describe('EmailTextExtractorService', () => {
  describe('extractEmailText', () => {
    it('should extract basic email information', () => {
      const email = {
        subject: 'Re: Important Business Proposal',
        from: 'John Doe <john@example.com>',
        to: 'sales@company.com',
        text: 'Hello, I am interested in your services. Please contact me.'
      };

      const result = EmailTextExtractorService.extractEmailText(email);

      expect(result.subject).toBe('Important Business Proposal');
      expect(result.from).toBe('john@example.com');
      expect(result.to).toBe('sales@company.com');
      expect(result.extractedText).toContain('I am interested in your services');
    });

    it('should extract text from HTML content', () => {
      const email = {
        subject: 'HTML Email Test',
        from: 'test@example.com',
        html: '<html><body><p>Hello, <strong>I need help</strong> with your product.</p><script>alert("test")</script></body></html>'
      };

      const result = EmailTextExtractorService.extractEmailText(email);

      expect(result.extractedText).toContain('I need help');
      expect(result.extractedText).not.toContain('<p>');
      expect(result.extractedText).not.toContain('alert');
    });

    it('should remove email signatures', () => {
      const email = {
        subject: 'Business Inquiry',
        from: 'client@example.com',
        text: `I would like to know more about your services.

--
Best regards,
John Smith
CEO, Example Corp
Phone: +1-555-123-4567`
      };

      const result = EmailTextExtractorService.extractEmailText(email);

      expect(result.extractedText).toContain('I would like to know more');
      expect(result.extractedText).not.toContain('Best regards');
      expect(result.extractedText).not.toContain('CEO, Example Corp');
    });

    it('should remove quoted text', () => {
      const email = {
        subject: 'Reply to inquiry',
        from: 'client@example.com',
        text: `Thank you for your response.

> On 2024-01-01, you wrote:
> We offer the following services...
> 
> Original message continues here...

I would like to schedule a meeting.`
      };

      const result = EmailTextExtractorService.extractEmailText(email);

      expect(result.extractedText).toContain('Thank you for your response');
      expect(result.extractedText).toContain('I would like to schedule a meeting');
      expect(result.extractedText).not.toContain('On 2024-01-01, you wrote');
      expect(result.extractedText).not.toContain('We offer the following services');
    });

    it('should handle text length limits', () => {
      const longText = 'This is a very long email. '.repeat(200); // ~5400 chars
      const email = {
        subject: 'Long Email',
        from: 'test@example.com',
        text: longText
      };

      const result = EmailTextExtractorService.extractEmailText(email, {
        maxTextLength: 100
      });

      expect(result.textLength).toBeLessThanOrEqual(103); // 100 + '...'
      expect(result.extractedText.endsWith('...')).toBe(true);
      expect(result.originalLength).toBeGreaterThan(5000);
      expect(result.compressionRatio).toBeLessThan(0.05);
    });

    it('should remove legal disclaimers', () => {
      const email = {
        subject: 'Contract Information',
        from: 'legal@company.com',
        text: `Please find the contract details below.

Contract terms and conditions...

CONFIDENTIAL: This email is confidential and may be legally privileged.
If you are not the intended recipient, please delete this email.`
      };

      const result = EmailTextExtractorService.extractEmailText(email);

      expect(result.extractedText).toContain('Please find the contract details');
      expect(result.extractedText).toContain('Contract terms and conditions');
      expect(result.extractedText).not.toContain('CONFIDENTIAL');
      expect(result.extractedText).not.toContain('legally privileged');
    });

    it('should handle emails with different body structures', () => {
      const emailWithBodyObject = {
        subject: 'Test Email',
        from: 'test@example.com',
        body: {
          html: '<p>This is HTML content</p>',
          text: 'This is text content'
        }
      };

      const result = EmailTextExtractorService.extractEmailText(emailWithBodyObject);

      expect(result.extractedText).toContain('This is HTML content');
    });

    it('should handle error cases gracefully', () => {
      const malformedEmail = {
        subject: null,
        from: undefined,
        html: '<invalid>html</invalid>' // This shouldn't break the parser
      };

      const result = EmailTextExtractorService.extractEmailText(malformedEmail);

      expect(result.subject).toBe('');
      expect(result.from).toBe('');
      expect(result.extractedText).toBeDefined();
      expect(typeof result.textLength).toBe('number');
    });
  });

  describe('extractMultipleEmailsText', () => {
    it('should process multiple emails', () => {
      const emails = [
        {
          subject: 'First Email',
          from: 'user1@example.com',
          text: 'First email content'
        },
        {
          subject: 'Second Email',
          from: 'user2@example.com',
          text: 'Second email content'
        }
      ];

      const results = EmailTextExtractorService.extractMultipleEmailsText(emails);

      expect(results).toHaveLength(2);
      expect(results[0].subject).toBe('First Email');
      expect(results[1].subject).toBe('Second Email');
      expect(results[0].extractedText).toContain('First email content');
      expect(results[1].extractedText).toContain('Second email content');
    });

    it('should apply options to all emails', () => {
      const emails = [
        {
          subject: 'Email 1',
          from: 'user1@example.com',
          text: 'A'.repeat(1000) // 1000 chars
        },
        {
          subject: 'Email 2',
          from: 'user2@example.com',
          text: 'B'.repeat(2000) // 2000 chars
        }
      ];

      const results = EmailTextExtractorService.extractMultipleEmailsText(emails, {
        maxTextLength: 500
      });

      expect(results).toHaveLength(2);
      results.forEach(result => {
        expect(result.textLength).toBeLessThanOrEqual(503); // 500 + '...'
      });
    });
  });

  describe('compression and optimization', () => {
    it('should provide compression statistics', () => {
      const email = {
        subject: 'Business Proposal',
        from: 'client@example.com',
        text: `Dear Team,

I am interested in your services for our upcoming project.

--
Best regards,
John Smith
Senior Director
ABC Corporation
1234 Main Street
City, State 12345
Phone: (555) 123-4567
Email: john.smith@abc-corp.com

CONFIDENTIAL: This communication is confidential and proprietary.`
      };

      const result = EmailTextExtractorService.extractEmailText(email);

      expect(result.originalLength).toBeGreaterThan(0);
      expect(result.textLength).toBeGreaterThan(0);
      expect(result.textLength).toBeLessThan(result.originalLength);
      expect(result.compressionRatio).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeLessThan(1);
    });
  });
}); 