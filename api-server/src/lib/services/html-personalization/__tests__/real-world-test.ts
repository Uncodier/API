import { generateSafeJavaScriptImplementation } from '../safe-code-generator';
import { PersonalizationModification } from '../types';

describe('Real-world HTML Personalization Tests', () => {
  it('handles multi-line content correctly without syntax errors', () => {
    const personalizations: PersonalizationModification[] = [
      {
        id: 'test1',
        element_type: 'heading',
        selector: '#hero .framer-1feiza5',
        modification_type: 'enhance',
        operation_type: 'replace',
        description: 'Actualizar encabezado principal',
        rationale: 'Hacer el título más atractivo',
        impact_score: 0.8,
        after_html: `
Empower Your Content Creation Journey
`
      },
      {
        id: 'test2',
        element_type: 'paragraph',
        selector: '#hero .framer-zzcx2',
        modification_type: 'enhance',
        operation_type: 'replace',
        description: 'Actualizar subtítulo',
        rationale: 'Mejorar la claridad del mensaje',
        impact_score: 0.7,
        after_html: `
Create, Optimize, and Grow Your Audience Effortlessly

`
      },
      {
        id: 'test3',
        element_type: 'button',
        selector: '#hero .framer-1i0egf0 button[data-framer-name=\'Desktop - Blue\']',
        modification_type: 'enhance',
        operation_type: 'replace',
        description: 'Actualizar texto del botón',
        rationale: 'Llamada a la acción más clara',
        impact_score: 0.6,
        after_html: 'Start Creating Now'
      },
      {
        id: 'test4',
        element_type: 'paragraph',
        selector: '#integration .framer-1uh1c4m .framer-12yj68p p',
        modification_type: 'enhance',
        operation_type: 'replace',
        description: 'Actualizar texto de integración',
        rationale: 'Resaltar beneficios para creadores de contenido',
        impact_score: 0.7,
        after_html: `
Integrate powerful tools to streamline your content creation process and maximize your impact.

`
      },
      {
        id: 'test5',
        element_type: 'heading',
        selector: '#integration .framer-28eoaf',
        modification_type: 'enhance',
        operation_type: 'replace',
        description: 'Actualizar título de características',
        rationale: 'Mejor alineamiento con segmento de creadores',
        impact_score: 0.8,
        after_html: `
Features Tailored for Content Creators
`
      }
    ];
    
    // Generar el código JavaScript
    const result = generateSafeJavaScriptImplementation(personalizations, true);
    
    // Mostrar el código generado para verificación visual
    console.log('\nCódigo JavaScript generado:');
    console.log(result.code);
    
    // Verificar que el código no tenga errores de sintaxis
    expect(() => {
      // Evaluación del código generado
      // eslint-disable-next-line no-new-func
      new Function(result.code);
    }).not.toThrow();
    
    // Verificar que el código incluya los selectores
    expect(result.code).toContain('#hero .framer-1feiza5');
    expect(result.code).toContain('#hero .framer-zzcx2');
    expect(result.code).toContain('#integration .framer-28eoaf');
    
    // Comprobar que el contenido está presente, sin saltos de línea literales
    expect(result.code).toContain('Empower Your Content Creation Journey');
    expect(result.code).toContain('Create, Optimize, and Grow Your Audience Effortlessly');
    expect(result.code).toContain('Start Creating Now');
    
    // Verificar que no haya saltos de línea literales en el código generado
    expect(result.code).not.toContain('\n"');
    
    // Verificar la estructura general del código
    expect(result.code).toMatch(/^\(function\(\)\{/); // Comienza con IIFE
    expect(result.code).toMatch(/\}\)\(\);$/); // Termina correctamente
  });
}); 