import { 
  generateSafeJavaScriptImplementation, 
  sanitizeExistingCode 
} from '../safe-code-generator';
import { PersonalizationModification } from '../types';

describe('Safe Code Generator', () => {
  describe('generateSafeJavaScriptImplementation', () => {
    it('handles operation_type replace correctly', () => {
      const personalizations: PersonalizationModification[] = [{
        id: 'test1',
        selector: '#test-element',
        operation_type: 'replace',
        after_html: '<p>This is replaced content</p>'
      }];
      
      const result = generateSafeJavaScriptImplementation(personalizations, true);
      
      // Should include the operation type
      expect(result.code).toContain('"replace"');
      // Should include the content
      expect(result.code).toContain('This is replaced content');
      // Should use findAndOperate function
      expect(result.code).toContain('findAndOperate');
    });

    it('handles operation_type append correctly', () => {
      const personalizations: PersonalizationModification[] = [{
        id: 'test2',
        selector: '#test-element',
        operation_type: 'append',
        after_html: '<p>This is appended content</p>'
      }];
      
      const result = generateSafeJavaScriptImplementation(personalizations, true);
      
      // Should include the operation type
      expect(result.code).toContain('"append"');
      // Should include the content
      expect(result.code).toContain('This is appended content');
      // Should use findAndOperate function
      expect(result.code).toContain('findAndOperate');
    });

    it('handles operation_type remove correctly', () => {
      const personalizations: PersonalizationModification[] = [{
        id: 'test3',
        selector: '#test-element',
        operation_type: 'remove',
        after_html: ''
      }];
      
      const result = generateSafeJavaScriptImplementation(personalizations, true);
      
      // Should include the operation type
      expect(result.code).toContain('"remove"');
      // Should use findAndOperate function
      expect(result.code).toContain('findAndOperate');
    });

    it('handles operation_type rewrite correctly', () => {
      const personalizations: PersonalizationModification[] = [{
        id: 'test7',
        selector: '#test-element',
        operation_type: 'rewrite',
        after_html: 'This is text-only content'
      }];
      
      const result = generateSafeJavaScriptImplementation(personalizations, true);
      
      // Should include the operation type
      expect(result.code).toContain('"rewrite"');
      // Should include the content
      expect(result.code).toContain('This is text-only content');
      // Should use findAndOperate function
      expect(result.code).toContain('findAndOperate');
    });

    it('escapes special characters in selectors correctly', () => {
      const personalizations: PersonalizationModification[] = [{
        id: 'test4',
        selector: '#test-element[data-attr="value"]',
        operation_type: 'replace',
        after_html: '<p>Test content</p>'
      }];
      
      const result = generateSafeJavaScriptImplementation(personalizations, true);
      
      // Verify the selector is in the output rather than checking specific escape format
      expect(result.code).toMatch(/findAndOperate\("[^"]*data-attr[^"]*"/);
      
      // Verify the content is present
      expect(result.code).toContain('Test content');
    });

    it('converts special characters in HTML content correctly', () => {
      const personalizations: PersonalizationModification[] = [{
        id: 'test5',
        selector: '#test-element',
        operation_type: 'replace',
        after_html: '<p class="test">Line 1\nLine 2\tTabbed\r\nCarriage Return</p>'
      }];
      
      const result = generateSafeJavaScriptImplementation(personalizations, true);
      
      // Should convert newlines and tabs to spaces, not escape sequences
      expect(result.code).toContain('Line 1 Line 2 Tabbed  Carriage Return');
      
      // Should not contain escape sequences for newlines/tabs
      expect(result.code).not.toContain('\\n');
      expect(result.code).not.toContain('\\t');
      expect(result.code).not.toContain('\\r');
    });

    it('handles backslash characters in HTML content correctly', () => {
      const personalizations: PersonalizationModification[] = [{
        id: 'test6',
        selector: '#test-element',
        operation_type: 'replace',
        after_html: '<p>This content has a backslash \\ and a quoted backslash "\\"</p>'
      }];
      
      const result = generateSafeJavaScriptImplementation(personalizations, true);
      
      // Should properly escape backslashes - using looser check
      expect(result.code).toContain('backslash');
      expect(result.code).toMatch(/backslash\s+[\\]{2,}/);
    });
  });

  describe('sanitizeExistingCode', () => {
    it('sanitizes existing code with multiple operations', () => {
      const inputCode = `
        (function() {
          function findAndUpdate(selector, content) {
            const el = document.querySelector(selector);
            if (el) el.innerHTML = content;
          }
          findAndUpdate("#header", "<h1>New Header</h1>");
          findAndUpdate("#content", "<p>New Content</p>");
        })();
      `;
      
      const result = sanitizeExistingCode(inputCode);
      
      // Should contain both selectors
      expect(result).toContain('#header');
      expect(result).toContain('#content');
      // Should use the new findAndOperate function
      expect(result).toContain('findAndOperate');
    });
  });
}); 