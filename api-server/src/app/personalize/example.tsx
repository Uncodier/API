import React from 'react';
import Personalizer from '@/components/Personalizer';

/**
 * Example page showing how to use the Personalizer component
 */
export default function PersonalizeExample() {
  // Define personalizations directly as props
  const personalizations = [
    { 
      selector: '.framer-1feiza5', 
      content: 'Empower Your Digital Content Creation'
    },
    { 
      selector: '.framer-18f7db3-container button', 
      content: 'Start Creating Now'
    },
    { 
      selector: '.framer-1wls7v5', 
      content: 'Take Your Content to the Next Level with One Click'
    },
    { 
      selector: '#features .framer-1ioxybx .framer-m77kyt', 
      content: 'Unleash the Power of Automated Insights for Your Content'
    },
    { 
      selector: '#how-it-works .framer-qtuk79 h6', 
      content: 'How It Works for Creators'
    },
    { 
      selector: '#about-us .framer-16w4fmz h3', 
      content: 'Meet the Innovators Behind Uncodie'
    },
    { 
      selector: '#client-insights .framer-1yg7p8w h3', 
      content: 'Hear From Fellow Content Creators'
    }
  ];

  // The original problematic code
  const originalCode = `document.addEventListener("DOMContentLoaded",function(){function a(s,c){try{const e=document.querySelector(s);if(e){c(e);return!0}return!1}catch(e){return!1}}function b(e,h){try{e.innerHTML=h}catch(e){}}function c(e,h){try{const t=document.createElement("div");t.innerHTML=h;while(t.firstChild){e.appendChild(t.firstChild)}}catch(e){}}function d(e){try{e.parentNode.removeChild(e)}catch(e){}}a(".framer-1feiza5",function(e){b(e,"
Empower Your Digital Content Creation
");});a(".framer-18f7db3-container button",function(e){b(e,"Start Creating Now");});a(".framer-1wls7v5",function(e){b(e,"
Take Your Content to the Next Level with One Click

");});a("#features .framer-1ioxybx .framer-m77kyt",function(e){b(e,"
Unleash the Power of Automated Insights for Your Content

");});a("#how-it-works .framer-qtuk79 h6",function(e){b(e,"
How It Works for Creators
");});a("#about-us .framer-16w4fmz h3",function(e){b(e,"
Meet the Innovators Behind Uncodie
");});a("#client-insights .framer-1yg7p8w h3",function(e){b(e,"
Hear From Fellow Content Creators
");});});`;

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Personalization Example</h1>
      
      <div className="mb-10">
        <h2 className="text-xl font-semibold mb-3">Method 1: Using the personalizations prop</h2>
        <p className="mb-4">This method is the recommended approach as it's type-safe and easier to maintain.</p>
        <div className="bg-gray-100 p-4 rounded">
          <pre className="text-sm overflow-x-auto">
            {`<Personalizer
  personalizations={[
    { 
      selector: '.framer-1feiza5', 
      content: 'Empower Your Digital Content Creation'
    },
    // Additional personalizations...
  ]}
/>`}
          </pre>
        </div>
        
        {/* Apply personalizations using the component */}
        <Personalizer personalizations={personalizations} />
      </div>
      
      <div className="mb-10">
        <h2 className="text-xl font-semibold mb-3">Method 2: Using the code prop</h2>
        <p className="mb-4">This method safely parses and sanitizes existing personalization code.</p>
        <div className="bg-gray-100 p-4 rounded">
          <pre className="text-sm overflow-x-auto">
            {`<Personalizer
  code="document.addEventListener('DOMContentLoaded', function(){...}"
/>`}
          </pre>
        </div>
        
        {/* Don't actually apply these personalizations twice - just for demonstration */}
        <Personalizer code={originalCode} autoRun={false} />
      </div>
      
      <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4">
        <p className="text-yellow-700">
          <strong>Note:</strong> The Personalizer component automatically sanitizes the code
          to prevent syntax errors like <code>SyntaxError: Invalid escape in identifier</code>.
        </p>
      </div>
    </div>
  );
} 