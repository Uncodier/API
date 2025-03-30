/**
 * Utilitario simple para arreglar código de personalización problemático
 * desde la consola del navegador
 * 
 * Copiar y pegar este código en la consola del navegador para convertir
 * código problemático en código seguro.
 */

(function() {
  // Función para limpiar y aplicar código de personalización
  window.fixPersonalizationCode = function(code) {
    try {
      // Buscar todos los pares selector-contenido
      const selectors = [];
      const contents = [];
      
      // Patrones para encontrar selectores y contenidos
      const patterns = [
        // Patrón para "a(selector, function(e){ b(e, content); });"
        /a\(["']([^"']+)["'],\s*function\s*\(\s*e\s*\)\s*\{\s*b\s*\(\s*e\s*,\s*["']([^"']*)["']\s*\)\s*;\s*\}\s*\)\s*;/g,
        
        // Patrón para "document.querySelector(selector).innerHTML = content;"
        /document\.querySelector\(["']([^"']+)["']\)\.innerHTML\s*=\s*["']([^"']*)["']\s*;/g
      ];
      
      // Buscar todos los patrones
      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(code)) !== null) {
          selectors.push(match[1]);
          contents.push(match[2]);
        }
      });
      
      // Si no encontramos nada, devolver mensaje de error
      if (selectors.length === 0) {
        return "No se encontraron personalizaciones en el código. Formato no reconocido.";
      }
      
      // Crear código seguro
      let safeCode = '(function(){';
      safeCode += 'function findAndUpdate(s,c){try{const e=document.querySelector(s);if(e){e.innerHTML=c;return true}return false}catch(e){return false}}';
      
      // Agregar cada par selector-contenido
      selectors.forEach((selector, index) => {
        const content = contents[index] || '';
        
        // Eliminar los saltos de línea y espacios innecesarios
        const cleanContent = content.replace(/\n/g, ' ').trim();
        
        // Crear el código de actualización
        safeCode += `findAndUpdate("${selector}", "${cleanContent}");`;
      });
      
      // Cerrar la función
      safeCode += '})();';
      
      // Crear y ejecutar el script
      const script = document.createElement('script');
      script.id = 'personalizer-script';
      script.textContent = safeCode;
      document.head.appendChild(script);
      
      return `Aplicadas ${selectors.length} personalizaciones con éxito`;
    } catch (error) {
      return `Error al procesar el código: ${error.message}`;
    }
  };
  
  // Función para ejemplos rápidos de prueba
  window.testPersonalizationCode = function() {
    // Ejemplo de código problemático para probar
    const problematicCode = `document.addEventListener("DOMContentLoaded",function(){function a(s,c){try{const e=document.querySelector(s);if(e){c(e);return true}return false}catch(e){return false}}function b(e,h){try{e.innerHTML=h}catch(e){}}a("h1",function(e){b(e,"Título Personalizado");});})`;
    
    return window.fixPersonalizationCode(problematicCode);
  };
  
  console.log(`
    =========================================
    Corrector de código de personalización
    =========================================
    
    Funciones disponibles:
    
    1. fixPersonalizationCode(código)
       - Corrige y aplica el código de personalización
       
    2. testPersonalizationCode()
       - Ejecuta un ejemplo de prueba
       
    Ejemplo:
    fixPersonalizationCode(document.addEventListener("DOMContentLoaded",function(){...});
  `);
})();

// Ejemplo de uso:
// fixPersonalizationCode(tuCódigoProblematico); 