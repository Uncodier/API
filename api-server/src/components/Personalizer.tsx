import React, { useEffect } from 'react';
import { createSafePersonalizationScript, parsePersonalizationCode } from '@/lib/utils/js-sanitizer';

interface PersonalizerProps {
  /**
   * Selector-content pairs for personalization
   */
  personalizations?: {
    selector: string;
    content: string;
  }[];
  
  /**
   * Raw personalization code (alternative to personalizations prop)
   */
  code?: string;
  
  /**
   * Whether to run the script after component mount
   */
  autoRun?: boolean;
}

/**
 * Personalization component that safely applies content changes to DOM elements
 * 
 * This component can be used in two ways:
 * 1. With selector-content pairs: <Personalizer personalizations={[...]} />
 * 2. With raw code: <Personalizer code="document.addEventListener..." />
 * 
 * @example
 * <Personalizer 
 *   personalizations={[
 *     { selector: '#hero h1', content: 'New Hero Title' },
 *     { selector: '.call-to-action', content: 'Start Now' }
 *   ]} 
 * />
 */
const Personalizer: React.FC<PersonalizerProps> = ({ 
  personalizations = [], 
  code,
  autoRun = true
}) => {
  useEffect(() => {
    if (!autoRun) return;
    
    try {
      if (code) {
        // If raw code is provided, try to execute it directly
        // We'll extract the personalizations from it first to ensure it's safe
        const { selectors, contents } = parsePersonalizationCode(code);
        
        if (selectors.length === 0) {
          console.warn('No personalizations found in provided code');
          return;
        }
        
        // Regenerate safe code from the parsed values
        const safeCode = createSafePersonalizationScript(selectors, contents);
        
        // Create and execute the script
        const script = document.createElement('script');
        script.textContent = safeCode;
        document.head.appendChild(script);
      } else if (personalizations.length > 0) {
        // Use personalizations array
        const selectors = personalizations.map(p => p.selector);
        const contents = personalizations.map(p => p.content);
        
        // Generate safe script
        const safeCode = createSafePersonalizationScript(selectors, contents);
        
        // Create and execute the script
        const script = document.createElement('script');
        script.textContent = safeCode;
        document.head.appendChild(script);
      }
    } catch (error) {
      console.error('Error applying personalizations:', error);
    }
  }, [code, personalizations, autoRun]);

  // This is a utility component that doesn't render anything visible
  return null;
};

export default Personalizer; 