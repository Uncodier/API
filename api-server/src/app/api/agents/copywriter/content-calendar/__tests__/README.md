# Content Calendar Tests

Este directorio contiene las pruebas unitarias y de integración para el módulo de Content Calendar.

## Archivos de prueba

1. `api-integration.test.ts` - Pruebas de integración del API, verificando que los endpoints funcionen correctamente.
2. `content-extraction.test.ts` - Pruebas de las funciones de extracción de contenido.
3. `results-processing.test.ts` - Pruebas del procesamiento de resultados del comando.

## Cómo ejecutar las pruebas

```bash
# Ejecutar todas las pruebas
npm run test

# Ejecutar pruebas específicas
npx jest src/app/api/agents/copywriter/content-calendar/__tests__
```

## Estructura de contenido probada

Las pruebas utilizan esta estructura de contenido como ejemplo:

```json
[
  {
    "content": [
      {
        "text": "# The Future of Education: Integrating Innovative Technology Solutions\n\n## Introduction\nIn the rapidly evolving landscape of education...",
        "type": "blog_post",
        "title": "The Future of Education: Integrating Innovative Technology Solutions",
        "description": "Explore how innovative technology solutions are transforming education, enhancing learning experiences, and shaping the future of teaching and learning.",
        "estimated_reading_time": 10
      }
    ]
  }
]
```

## Lo que se está probando

Estas pruebas verifican que:

1. El contenido con la estructura exacta proporcionada se puede extraer correctamente de los resultados del comando.
2. Todos los campos requeridos están presentes y se procesan adecuadamente.
3. El contenido se formatea correctamente para el almacenamiento en la base de datos.
4. El API devuelve respuestas apropiadas en diversos escenarios. 