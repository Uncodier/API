import { EmailFilterService } from '@/lib/services/email/EmailFilterService';

describe('EmailFilterService', () => {
  describe('validateEmailNotDeliveryStatus', () => {
    it('should detect delivery status emails by FROM field', () => {
      const email = {
        from: 'mailer-daemon@example.com',
        subject: 'Regular subject',
        body: 'Regular content'
      };

      const result = EmailFilterService.validateEmailNotDeliveryStatus(email);
      
      expect(result.isValid).toBe(false);
      expect(result.category).toBe('delivery_status');
      expect(result.reason).toContain('mailer-daemon@');
    });

    it('should detect delivery status emails by SUBJECT field', () => {
      const email = {
        from: 'user@example.com',
        subject: 'Delivery Status Notification',
        body: 'Regular content'
      };

      const result = EmailFilterService.validateEmailNotDeliveryStatus(email);
      
      expect(result.isValid).toBe(false);
      expect(result.category).toBe('delivery_status');
      expect(result.reason).toContain('delivery status notification');
    });

    it('should detect delivery status emails by headers', () => {
      const email = {
        from: 'user@example.com',
        subject: 'Regular subject',
        body: 'Regular content',
        headers: {
          'content-type': 'multipart/report; report-type=delivery-status'
        }
      };

      const result = EmailFilterService.validateEmailNotDeliveryStatus(email);
      
      expect(result.isValid).toBe(false);
      expect(result.category).toBe('delivery_status');
      expect(result.reason).toContain('multipart/report');
    });

    it('should allow valid emails to pass', () => {
      const email = {
        from: 'customer@example.com',
        subject: 'Inquiry about your services',
        body: 'I am interested in your product'
      };

      const result = EmailFilterService.validateEmailNotDeliveryStatus(email);
      
      expect(result.isValid).toBe(true);
      expect(result.category).toBeUndefined();
      expect(result.reason).toBeUndefined();
    });
  });

  describe('isBounceEmail', () => {
    it('should detect bounce emails by FROM field', () => {
      const email = {
        from: 'Mail Delivery Subsystem <noreply@example.com>',
        subject: 'Undelivered Mail Returned to Sender',
        body: 'Your message could not be delivered'
      };

      const result = EmailFilterService.isBounceEmail(email);
      
      expect(result).toBe(true);
    });

    it('should detect bounce emails by SUBJECT field', () => {
      const email = {
        from: 'postmaster@example.com',
        subject: 'Mail delivery failed: returning message to sender',
        body: 'Delivery failure'
      };

      const result = EmailFilterService.isBounceEmail(email);
      
      expect(result).toBe(true);
    });

    it('should not detect valid emails as bounce', () => {
      const email = {
        from: 'customer@example.com',
        subject: 'Product inquiry',
        body: 'Hello, I would like to know more about your services'
      };

      const result = EmailFilterService.isBounceEmail(email);
      
      expect(result).toBe(false);
    });
  });

  describe('filterValidEmails', () => {
    it('should filter out delivery status and no-reply emails', () => {
      const emails = [
        {
          from: 'customer@example.com',
          subject: 'Valid inquiry',
          body: 'I need information about your product'
        },
        {
          from: 'mailer-daemon@example.com',
          subject: 'Delivery Status Notification',
          body: 'Your message could not be delivered'
        },
        {
          from: 'noreply@company.com',
          subject: 'Automated response',
          body: 'This is an automated message'
        }
      ];

      const noReplyAddresses = ['noreply@company.com'];
      const result = EmailFilterService.filterValidEmails(emails, noReplyAddresses);
      
      expect(result.validEmails).toHaveLength(1);
      expect(result.filteredEmails).toHaveLength(2);
      expect(result.validEmails[0].from).toBe('customer@example.com');
      
      const stats = EmailFilterService.getFilteringStats(result.filteredEmails);
      expect(stats.byCategory.delivery_status).toBe(1);
      expect(stats.byCategory.no_reply).toBe(1);
    });
  });
}); 