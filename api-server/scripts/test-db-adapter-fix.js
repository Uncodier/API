/**
 * Script para verificar que el fix en DatabaseAdapter respeta la estructura original de los targets
 */

// Simula la función de validación de DatabaseAdapter
function simulateValidation(result, useFixedVersion = false) {
  if (useFixedVersion) {
    // Versión corregida: acepta cualquier propiedad
    return result && typeof result === 'object';
  } else {
    // Versión antigua: busca específicamente type, content o contents
    return result && typeof result === 'object' && (result.type || result.content || result.contents);
  }
}

// Diferentes estructuras de targets para probar
const testCases = [
  {
    name: "Target con contents (caso real)",
    data: {
      contents: [
        {
          text: "Contenido del blog post",
          type: "blog_post",
          title: "Título del blog",
          description: "Descripción del blog",
          estimated_reading_time: 10
        }
      ]
    }
  },
  {
    name: "Target con type y content (formato antiguo)",
    data: {
      type: "blog_post",
      content: "Texto del blog post"
    }
  },
  {
    name: "Target con otra estructura (ej: images)",
    data: {
      images: [
        {
          url: "https://example.com/image.jpg",
          alt: "Descripción de la imagen"
        }
      ]
    }
  }
];

// Prueba cada caso
function runTests() {
  console.log('===== VALIDANDO QUE LAS CORRECCIONES RESPETAN LA ESTRUCTURA DE LOS TARGETS =====\n');
  
  console.log('1. COMPARACIÓN DE VALIDACIONES:');
  console.log('   - Validación antigua: Exige "type", "content" o "contents"');
  console.log('   - Validación propuesta: Acepta cualquier objeto como válido\n');
  
  let allOriginalValid = true;
  let allFixedValid = true;
  
  testCases.forEach((testCase, index) => {
    console.log(`\nCaso #${index + 1}: ${testCase.name}`);
    console.log('Estructura:', JSON.stringify(testCase.data, null, 2));
    
    const isValidOriginal = simulateValidation(testCase.data, false);
    const isValidFixed = simulateValidation(testCase.data, true);
    
    console.log(`Validación antigua: ${isValidOriginal ? '✅ VÁLIDO' : '❌ INVÁLIDO'}`);
    console.log(`Validación propuesta: ${isValidFixed ? '✅ VÁLIDO' : '❌ INVÁLIDO'}`);
    
    if (!isValidOriginal) allOriginalValid = false;
    if (!isValidFixed) allFixedValid = false;
  });
  
  console.log('\n===== RESULTADO FINAL =====');
  console.log(`Validación antigua: ${allOriginalValid ? '✅ Todos los casos son válidos' : '❌ Algunos casos son inválidos'}`);
  console.log(`Validación propuesta: ${allFixedValid ? '✅ Todos los casos son válidos' : '❌ Algunos casos son inválidos'}`);
  
  if (!allOriginalValid && allFixedValid) {
    console.log('\n✅ CONCLUSIÓN: La validación propuesta resuelve el problema y acepta todas las estructuras de targets.');
  } else if (allOriginalValid) {
    console.log('\n❓ CONCLUSIÓN: La validación antigua ya acepta todas las estructuras probadas. Verifica si hay otros casos problemáticos.');
  } else {
    console.log('\n❌ CONCLUSIÓN: La validación propuesta no resuelve completamente el problema. Se necesita una solución diferente.');
  }
  
  console.log('\n===== RECOMENDACIÓN =====');
  console.log('La mejor solución es simplemente verificar que el resultado sea un objeto:');
  console.log('\nconst isValid = result && typeof result === "object";');
  console.log('\nEsto respeta completamente la estructura original de los targets y es más simple y robusto.');
}

// Ejecutar las pruebas
runTests(); 