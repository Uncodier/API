/**
 * Standalone personalization script
 * 
 * This is a self-contained version of the personalizer that can be included directly 
 * in any website without any build tools or frameworks.
 * 
 * Usage:
 * 1. Include this script in your page
 * 2. Call SitePersonalizer.apply() with your personalizations
 */

// Create a self-executing function to avoid global namespace pollution
(function(global) {
  "use strict";

  /**
   * SitePersonalizer - A lightweight library for DOM personalizations
   */
  const SitePersonalizer = {
    /**
     * Apply personalization to the DOM
     * 
     * @param {Array<Object>} personalizations Array of {selector, content} objects
     * @param {boolean} immediate Whether to apply immediately or wait for DOMContentLoaded
     * @returns {Function} Cleanup function
     */
    apply: function(personalizations, immediate) {
      if (!Array.isArray(personalizations)) {
        console.error('Personalizations must be an array');
        return function() {};
      }
      
      const selectors = [];
      const contents = [];
      
      // Extract selectors and contents
      personalizations.forEach(function(p) {
        if (p && p.selector && typeof p.content !== 'undefined') {
          selectors.push(p.selector);
          contents.push(p.content);
        }
      });
      
      return this.applyRaw(selectors, contents, immediate);
    },
    
    /**
     * Apply personalization directly with selectors and contents arrays
     * 
     * @param {Array<string>} selectors CSS selectors
     * @param {Array<string>} contents HTML contents
     * @param {boolean} immediate Whether to apply immediately or wait for DOMContentLoaded
     * @returns {Function} Cleanup function
     */
    applyRaw: function(selectors, contents, immediate) {
      if (!Array.isArray(selectors) || !Array.isArray(contents) || selectors.length !== contents.length) {
        console.error('Invalid selectors or contents');
        return function() {};
      }
      
      // Create safe script
      const code = this.createScript(selectors, contents, immediate);
      
      // Create and append script element
      const script = document.createElement('script');
      script.id = 'personalizer-' + Date.now();
      script.textContent = code;
      document.head.appendChild(script);
      
      // Return cleanup function
      return function() {
        if (script && script.parentNode) {
          script.parentNode.removeChild(script);
        }
      };
    },
    
    /**
     * Create a safe personalization script
     * 
     * @param {Array<string>} selectors CSS selectors
     * @param {Array<string>} contents HTML contents
     * @param {boolean} immediate Whether to apply immediately or wait for DOMContentLoaded
     * @returns {string} Safe JavaScript code
     */
    createScript: function(selectors, contents, immediate) {
      // Start with the wrapper function
      let code = immediate 
        ? '(function(){' 
        : 'document.addEventListener("DOMContentLoaded",function(){';
      
      // Add helper functions
      code += 'function findAndUpdate(s,c){try{const e=document.querySelector(s);if(e){e.innerHTML=c;return true}return false}catch(e){return false}}';
      
      // Add each personalization
      selectors.forEach(function(selector, index) {
        const safeSelector = selector.replace(/"/g, '\\"');
        
        let safeContent = contents[index] || '';
        // Escape special characters in content
        safeContent = safeContent
          .replace(/\\/g, '\\\\')  // Escape backslashes
          .replace(/"/g, '\\"')    // Escape quotes
          .replace(/\n/g, '\\n');  // Escape newlines
        
        code += 'findAndUpdate("' + safeSelector + '","' + safeContent + '");';
      });
      
      // Close the function
      code += '})();';
      
      return code;
    },
    
    /**
     * Apply personalizations from a raw code string
     * 
     * @param {string} code Personalization code to parse and apply
     * @param {boolean} immediate Whether to apply immediately
     * @returns {Function} Cleanup function
     */
    applyCode: function(code, immediate) {
      try {
        // Very simple parsing for demonstration
        const regex = /findAndUpdate\("([^"]+)","([^"]*)"\);/g;
        const selectors = [];
        const contents = [];
        
        let match;
        while ((match = regex.exec(code)) !== null) {
          selectors.push(match[1]);
          contents.push(match[2]);
        }
        
        if (selectors.length === 0) {
          // Try alternative format
          const altRegex = /a\("([^"]+)",function\(e\)\{b\(e,"([^"]*)"\);\}\);/g;
          while ((match = altRegex.exec(code)) !== null) {
            selectors.push(match[1]);
            contents.push(match[2]);
          }
        }
        
        return this.applyRaw(selectors, contents, immediate);
      } catch (error) {
        console.error('Error parsing personalization code:', error);
        return function() {};
      }
    },
    
    /**
     * Version of the personalizer
     */
    version: '1.0.0'
  };
  
  // Expose to global scope
  global.SitePersonalizer = SitePersonalizer;
  
})(typeof window !== 'undefined' ? window : this);

// Usage example:
/*
document.addEventListener('DOMContentLoaded', function() {
  // Apply personalizations
  SitePersonalizer.apply([
    { selector: '.header h1', content: 'Welcome to Our Personalized Site' },
    { selector: '.cta-button', content: 'Start Now' }
  ]);
  
  // Or apply from existing code
  const code = 'document.addEventListener("DOMContentLoaded",function(){findAndUpdate(".header h1","Welcome");});';
  SitePersonalizer.applyCode(code);
});
*/ 