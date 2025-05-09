/**
 * Sanitizer utilities for JavaScript code generation
 * 
 * This module provides functions to sanitize and escape JavaScript code
 * to prevent syntax errors when generating dynamic code.
 */

/**
 * Creates safe JavaScript code for personalizations by properly escaping
 * special characters and ensuring that no invalid escape sequences exist
 * 
 * @param code The JavaScript code to sanitize
 * @returns Sanitized JavaScript code
 */
export function sanitizeJsCode(code: string): string {
  // Replace any potential problematic escape sequences
  let sanitized = code
    // Use double quotes consistently
    .replace(/'/g, '"')
    // Escape any remaining backslashes properly to avoid invalid escape sequences
    .replace(/\\/g, '\\\\')
    // Then escape any unescaped double quotes
    .replace(/(?<!\\)"/g, '\\"')
    // Fix any double-escaped quotes that might have been created in the process
    .replace(/\\\\\"/g, '\\"');
    
  return sanitized;
}

/**
 * Creates a safe minified personalization script for DOM manipulations
 * 
 * This function creates a minimal script that uses document.querySelector
 * to find elements and apply content changes safely.
 * 
 * @param selectors Array of selectors to target
 * @param contents Array of HTML contents to apply to each selector
 * @returns Safe JavaScript code that can be executed on the client
 */
export function createSafePersonalizationScript(
  selectors: string[], 
  contents: string[]
): string {
  if (selectors.length !== contents.length) {
    throw new Error('The number of selectors must match the number of contents');
  }
  
  // Base script with helper functions
  let script = 'document.addEventListener("DOMContentLoaded",function(){';
  script += 'function a(s,c){try{const e=document.querySelector(s);if(e){c(e);return true}return false}catch(e){return false}}';
  script += 'function b(e,h){try{e.innerHTML=h}catch(e){}}';
  
  // Add each personalization with properly escaped values
  selectors.forEach((selector, index) => {
    const safeSelector = selector.replace(/"/g, '\\"');
    const safeContent = contents[index]
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
    
    script += `a("${safeSelector}",function(e){b(e,"${safeContent}");});`;
  });
  
  script += '});';
  return script;
}

/**
 * Parse personalization code string and separate it into selectors and contents
 * for easier manipulation
 * 
 * @param code The personalization code to parse
 * @returns Object with arrays of selectors and contents
 */
export function parsePersonalizationCode(code: string): { selectors: string[], contents: string[] } {
  const selectors: string[] = [];
  const contents: string[] = [];
  
  // Regular expression to extract selectors and content
  const regex = /a\("([^"]+)",function\(e\)\{b\(e,"([^"]*)"\);\}\);/g;
  let match;
  
  while ((match = regex.exec(code)) !== null) {
    // match[1] is the selector, match[2] is the content
    selectors.push(match[1]);
    contents.push(match[2]);
  }
  
  return { selectors, contents };
}

/**
 * Framework-agnostic function to apply personalizations directly to the DOM
 * 
 * This function works in any JavaScript environment without requiring any framework.
 * It can be used directly in vanilla JS projects or inside any framework.
 * 
 * @param selectors Array of selectors to target
 * @param contents Array of HTML contents to apply to each selector
 * @param immediate If true, applies immediately; otherwise waits for DOMContentLoaded
 * @returns A cleanup function that removes the script tag
 */
export function applyPersonalizations(
  selectors: string[],
  contents: string[],
  immediate: boolean = false
): () => void {
  // Create the safe JavaScript code
  const code = createSafePersonalizationScript(selectors, contents);
  
  // Create a script element
  const script = document.createElement('script');
  script.id = 'personalization-script-' + Date.now();
  script.textContent = immediate 
    ? code.replace('document.addEventListener("DOMContentLoaded",function(){', '(function(){')
    : code;
  
  // Add the script to the document
  document.head.appendChild(script);
  
  // Return a cleanup function
  return () => {
    if (script && script.parentNode) {
      script.parentNode.removeChild(script);
    }
  };
}

/**
 * Apply personalizations directly from a code string in a framework-agnostic way
 * 
 * @param code The personalization code to parse and apply
 * @param immediate If true, applies immediately; otherwise waits for DOMContentLoaded
 * @returns A cleanup function that removes the script tag
 */
export function applyPersonalizationCode(
  code: string,
  immediate: boolean = false
): () => void {
  try {
    // Parse the code first to ensure it's valid and safe
    const { selectors, contents } = parsePersonalizationCode(code);
    
    // Apply the personalizations
    return applyPersonalizations(selectors, contents, immediate);
  } catch (error) {
    console.error('Error applying personalization code:', error);
    return () => {}; // Return empty cleanup function
  }
} 