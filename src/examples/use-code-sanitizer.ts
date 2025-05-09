/**
 * Ejemplo de uso de sanitizeExistingCode para limpiar código de personalización
 * 
 * Este ejemplo muestra cómo usar la función sanitizeExistingCode para convertir
 * código problemático en código seguro sin escape sequences inválidas.
 */

import { sanitizeExistingCode } from '../lib/services/html-personalization';

// Ejemplo de código problemático con escape sequences inválidas
const problematicCode = `document.addEventListener("DOMContentLoaded",function(){function a(s,c){try{const e=document.querySelector(s);if(e){c(e);return true}return false}catch(e){return false}}function b(e,h){try{e.innerHTML=h}catch(e){}}a("h1.framer-text[data-framer-name='Word 1']",function(e){b(e,"
Grow Your Influence
");});a(".framer-1cqha5m[data-framer-name='Word 2']",function(e){b(e,"
with AI Insights
");});a("button[data-framer-name='Desktop - Blue']",function(e){b(e,"Try it Free");});a(".framer-1feiza5[data-framer-name='Word 1']",function(e){b(e,"
Enhance Your Reach
");});a(".framer-1cqha5m[data-framer-name='Word 2']",function(e){b(e,"
with AI Insights
");});a(".framer-zzcx2[data-framer-name='Subtitle']",function(e){b(e,"
Unlock AI-driven insights for your content strategy

");});a("section[data-framer-name='How It Works'] .framer-1kmzrh7[data-framer-name='Key metrics showcasing our growth and success']",function(e){b(e,"
Start with ease and watch your content thrive with AI-enhanced strategies.

");});a("section[data-framer-name='About us'] h3[data-framer-name='Our Milestones,  Your Advantage —']",function(e){b(e,"
Join Our Creative Community
");});});`;

// Sanitizar el código problemático
const safeCode = sanitizeExistingCode(problematicCode);

// Mostrar el código limpio
console.log('Código sanitizado:');
console.log(safeCode);

// -------------------------
// Aplicar en el navegador
// -------------------------

/**
 * Para aplicar el código sanitizado en el navegador:
 * 
 * 1. Copia el código sanitizado (console.log)
 * 2. Pégalo en la consola del navegador
 * 
 * Alternativamente, puedes usar esta función para aplicarlo dinámicamente:
 */
function applyCleanCodeInBrowser() {
  const script = document.createElement('script');
  script.textContent = safeCode;
  document.head.appendChild(script);
  return 'Código de personalización aplicado con éxito';
}

// Si estamos en un entorno de navegador, exportar la función de aplicación
if (typeof window !== 'undefined') {
  (window as any).applyCleanPersonalizations = applyCleanCodeInBrowser;
}

/**
 * Ejemplo de uso programático:
 * 
 * 1. Importar la función: import { sanitizeExistingCode } from '../lib/services/html-personalization';
 * 2. Sanitizar el código: const safeCode = sanitizeExistingCode(problematicCode);
 * 3. Aplicar el código:
 *    const script = document.createElement('script');
 *    script.textContent = safeCode;
 *    document.head.appendChild(script);
 */

export { 
  problematicCode, 
  safeCode, 
  applyCleanCodeInBrowser 
}; 