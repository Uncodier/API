import { generateImplementationCode } from '../../static-implementation-service';
import { PersonalizationModification } from '../../html-personalization-service';

// TypeScript will recognize these globals from @types/jest
// No need to import them explicitly

describe('Static Implementation Service', () => {
  const samplePersonalizations: PersonalizationModification[] = [
    {
      id: 'mod_123',
      element_type: 'heading',
      selector: 'h1.hero-title',
      modification_type: 'content',
      operation_type: 'replace',
      description: 'Update headline for technical audience',
      rationale: 'Technical audience prefers specific and precise information',
      impact_score: 0.85,
      after_html: '<h1 class="hero-title">Advanced Analytics Platform for Enterprise Data</h1>'
    },
    {
      id: 'mod_456',
      element_type: 'button',
      selector: '.cta-button',
      modification_type: 'text',
      operation_type: 'replace',
      description: 'Change CTA text to be more specific',
      rationale: 'Technical users respond better to specific action descriptions',
      impact_score: 0.75,
      after_html: '<button class="cta-button">Start Free Technical Trial</button>'
    },
    {
      id: 'mod_789',
      element_type: 'feature',
      selector: '.feature-list',
      modification_type: 'enhance',
      operation_type: 'append',
      description: 'Append technical features to the feature list',
      rationale: 'Technical audience values detailed specifications',
      impact_score: 0.8,
      after_html: '<li class="feature-item">Advanced data encryption with AES-256</li>'
    },
    {
      id: 'mod_101',
      element_type: 'promotion',
      selector: '.promotional-banner',
      modification_type: 'remove',
      operation_type: 'remove',
      description: 'Remove promotional banner that distracts technical audience',
      rationale: 'Technical users prefer focused content without marketing distractions',
      impact_score: 0.65,
      after_html: ''
    }
  ];

  it('should generate JavaScript implementation code with full comments when explicitly requested', () => {
    const result = generateImplementationCode(samplePersonalizations, 'javascript', false);
    
    // Check that the result has the correct type
    expect(result.type).toBe('javascript');
    
    // Check that the code is a string and contains expected content
    expect(typeof result.code).toBe('string');
    expect(result.code).toContain('document.addEventListener');
    expect(result.code).toContain('h1.hero-title');
    expect(result.code).toContain('.cta-button');
    expect(result.code).toContain('Advanced Analytics Platform');
    expect(result.code).toContain('Start Free Technical Trial');
    
    // Check that it contains code for append operation
    expect(result.code).toContain('.feature-list');
    expect(result.code).toContain('appendHTML');
    expect(result.code).toContain('Advanced data encryption');
    
    // Check that it contains code for remove operation
    expect(result.code).toContain('.promotional-banner');
    expect(result.code).toContain('removeElement');
    
    // Should contain comments since it's not minified
    expect(result.code).toContain('//');
  });

  it('should generate HTML implementation code with comments when explicitly requested', () => {
    const result = generateImplementationCode(samplePersonalizations, 'html', false);
    
    // Check that the result has the correct type
    expect(result.type).toBe('html');
    
    // Check that the code is a string and contains expected content
    expect(typeof result.code).toBe('string');
    expect(result.code).toContain('<!-- Site Analyzer Personalization HTML -->');
    expect(result.code).toContain('data-selector="h1.hero-title"');
    expect(result.code).toContain('data-selector=".cta-button"');
    expect(result.code).toContain('Advanced Analytics Platform');
    expect(result.code).toContain('Start Free Technical Trial');
    
    // Check that it contains data attributes for operation types
    expect(result.code).toContain('data-operation="replace"');
    expect(result.code).toContain('data-operation="append"');
    expect(result.code).toContain('data-operation="remove"');
    expect(result.code).toContain('data-selector=".promotional-banner"');
    expect(result.code).toContain('<!-- Element will be removed -->');
  });

  it('should generate hybrid implementation code with comments when explicitly requested', () => {
    const result = generateImplementationCode(samplePersonalizations, 'hybrid', false);
    
    // Check that the result has the correct type
    expect(result.type).toBe('hybrid');
    
    // Check that the code is a string and contains expected content
    expect(typeof result.code).toBe('string');
    expect(result.code).toContain('(function()');
    expect(result.code).toContain('data-selector="h1.hero-title"');
    expect(result.code).toContain('data-selector=".cta-button"');
    expect(result.code).toContain('Advanced Analytics Platform');
    expect(result.code).toContain('Start Free Technical Trial');
    
    // Check that it contains logic for different operation types
    expect(result.code).toContain('switch (operation)');
    expect(result.code).toContain('case \'remove\'');
    expect(result.code).toContain('case \'append\'');
    expect(result.code).toContain('parentNode.removeChild');
    expect(result.code).toContain('appendChild');
  });

  it('should handle empty personalizations array (minified by default)', () => {
    const result = generateImplementationCode([], 'javascript');
    
    expect(result.type).toBe('javascript');
    expect(result.code).toBe('');
  });
  
  it('should handle empty personalizations array with non-minified option', () => {
    const result = generateImplementationCode([], 'javascript', false);
    
    expect(result.type).toBe('javascript');
    expect(result.code).toBe('// No personalizations to implement');
  });

  it('should default to JavaScript if no implementation type is provided', () => {
    const result = generateImplementationCode(samplePersonalizations);
    
    expect(result.type).toBe('javascript');
    // Should be minified by default
    expect(result.code).not.toContain('// Site Analyzer');
    expect(result.code).not.toContain('\n');
    expect(result.code).not.toContain('  ');  // No indentation
    expect(result.code).toContain('function a(');  // Minified function names
  });
  
  describe('Minified code', () => {
    it('should generate minified JavaScript by default', () => {
      const result = generateImplementationCode(samplePersonalizations, 'javascript');
      
      expect(result.type).toBe('javascript');
      expect(typeof result.code).toBe('string');
      
      // Check that code is minified
      expect(result.code).not.toContain('//');
      expect(result.code).not.toContain('\n');
      expect(result.code).toContain('function a(');
      
      // Check for single quotes instead of double quotes
      expect(result.code).toContain('\'DOMContentLoaded\'');
      expect(result.code).not.toContain('"DOMContentLoaded"');
      
      // Check that it still contains essential functionality
      expect(result.code).toContain('h1.hero-title');
      expect(result.code).toContain('.cta-button');
      expect(result.code).toContain('Advanced Analytics Platform');
    });
    
    it('should generate minified HTML by default', () => {
      const result = generateImplementationCode(samplePersonalizations, 'html');
      
      expect(result.type).toBe('html');
      expect(typeof result.code).toBe('string');
      
      // Check that code is minified
      expect(result.code).not.toContain('<!--');
      expect(result.code).not.toContain('\n');
      
      // Check for single quotes instead of double quotes
      expect(result.code).toContain('data-personalization-id=\'');
      expect(result.code).not.toContain('data-personalization-id="');
      
      // Check that it still contains essential functionality
      expect(result.code).toContain('data-selector=\'h1.hero-title\'');
      expect(result.code).toContain('data-operation=\'append\'');
      expect(result.code).toContain('Advanced Analytics Platform');
    });
    
    it('should generate minified hybrid code by default', () => {
      const result = generateImplementationCode(samplePersonalizations, 'hybrid');
      
      expect(result.type).toBe('hybrid');
      expect(typeof result.code).toBe('string');
      
      // Check that code is minified
      expect(result.code).not.toContain('//');
      expect(result.code).not.toContain('\n');
      expect(result.code).toContain('function a(');
      
      // Check for single quotes instead of double quotes
      expect(result.code).toContain('\'loading\'');
      expect(result.code).toContain('\'DOMContentLoaded\'');
      expect(result.code).not.toContain('"loading"');
      
      // Check that it still contains essential functionality
      expect(result.code).toContain('h1.hero-title');
      expect(result.code).toContain('case\'remove\'');
      expect(result.code).toContain('case\'append\'');
    });
    
    it('should generate minified JavaScript when explicitly requested', () => {
      const result = generateImplementationCode(samplePersonalizations, 'javascript', true);
      
      expect(result.type).toBe('javascript');
      expect(typeof result.code).toBe('string');
      
      // Check that code is minified
      expect(result.code).not.toContain('//');
      expect(result.code).not.toContain('\n');
      expect(result.code).toContain('function a(');
    });
    
    it('should return empty string for minified empty personalizations', () => {
      const result = generateImplementationCode([], 'javascript');
      
      expect(result.type).toBe('javascript');
      expect(result.code).toBe('');
    });
  });
}); 