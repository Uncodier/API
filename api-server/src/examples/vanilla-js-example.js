/**
 * Vanilla JavaScript example for using personalizations
 * 
 * This example shows how to use the personalizations in a framework-agnostic way,
 * with no dependencies on React, Angular, Vue or any other framework.
 */

// Method 1: Direct Script Tag (Copy-Paste)
// This is the simplest method for static sites where you just need to paste the code

function loadPersonalizationScript() {
  // This is the safe personalization code that you can directly include in your site
  const script = document.createElement('script');
  script.textContent = `
    document.addEventListener("DOMContentLoaded",function(){
      function a(s,c){try{const e=document.querySelector(s);if(e){c(e);return true}return false}catch(e){return false}}
      function b(e,h){try{e.innerHTML=h}catch(e){}}
      
      a(".hero-title", function(e){b(e,"Empower Your Digital Content Creation");});
      a(".cta-button", function(e){b(e,"Start Creating Now");});
      a(".hero-subtitle", function(e){b(e,"Take Your Content to the Next Level with One Click");});
    });
  `;
  document.head.appendChild(script);
}

// Method 2: Using ES modules (via import)
// If you have a build system or modern browser support
// In your actual file, you would use:
// import { applyPersonalizations, applyPersonalizationCode } from './path/to/utils';

function exampleWithModules() {
  // Example 1: Apply using selector-content pairs
  const selectors = [
    '.hero-title',
    '.cta-button',
    '.hero-subtitle'
  ];
  
  const contents = [
    'Empower Your Digital Content Creation',
    'Start Creating Now',
    'Take Your Content to the Next Level with One Click'
  ];
  
  // Apply immediately (true) or wait for DOMContentLoaded (false)
  const cleanup = window.SiteAnalyzer.utils.applyPersonalizations(selectors, contents, true);
  
  // You can clean up later if needed (e.g., when user navigates away)
  // cleanup();
  
  // Example 2: Apply using raw code
  const originalCode = `document.addEventListener("DOMContentLoaded",function(){function a(s,c){try{const e=document.querySelector(s);if(e){c(e);return!0}return!1}catch(e){return!1}}function b(e,h){try{e.innerHTML=h}catch(e){}}a(".hero-title",function(e){b(e,"New Title");});a(".cta-button",function(e){b(e,"Click Here");});});`;
  
  window.SiteAnalyzer.utils.applyPersonalizationCode(originalCode);
}

// Method 3: UMD/Global namespace approach
// This works when the library is exposed as a global variable
function exampleWithGlobalNamespace() {
  // Assuming the utils are exposed as window.SiteAnalyzer.utils
  if (typeof window.SiteAnalyzer !== 'undefined' && window.SiteAnalyzer.utils) {
    // Apply personalizations
    window.SiteAnalyzer.utils.applyPersonalizations([
      '.hero-title',
      '.cta-button'
    ], [
      'Empower Your Digital Content Creation',
      'Start Creating Now'
    ]);
  }
}

// Simple method to create a button that applies personalization when clicked
function createPersonalizationButton() {
  const button = document.createElement('button');
  button.textContent = 'Apply Personalizations';
  button.classList.add('personalize-button');
  button.addEventListener('click', function() {
    const personalizations = [
      { selector: '.hero-title', content: 'Customized Title!' },
      { selector: '.cta-button', content: 'Click Me Now!' }
    ];
    
    // Apply personalizations immediately
    const selectors = personalizations.map(p => p.selector);
    const contents = personalizations.map(p => p.content);
    
    if (typeof window.SiteAnalyzer !== 'undefined' && window.SiteAnalyzer.utils) {
      window.SiteAnalyzer.utils.applyPersonalizations(selectors, contents, true);
      button.textContent = 'Personalizations Applied!';
      button.disabled = true;
    } else {
      // Fallback if the library isn't available
      console.error('SiteAnalyzer utils not found. Loading standalone implementation...');
      
      // Simple standalone implementation
      personalizations.forEach(p => {
        try {
          const element = document.querySelector(p.selector);
          if (element) element.innerHTML = p.content;
        } catch (e) {
          console.error('Error applying personalization:', e);
        }
      });
    }
  });
  
  document.body.appendChild(button);
}

// Initialize when the DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  // Detect if running in a modern environment or needs compatibility
  const isModernBrowser = 'querySelector' in document && 'addEventListener' in window;
  
  if (!isModernBrowser) {
    console.warn('You are using an outdated browser. Some features may not work correctly.');
  }
  
  // Create the button for manual personalization
  createPersonalizationButton();
  
  // Example: Load personalizations from server
  // fetchPersonalizationsFromServer();
}); 