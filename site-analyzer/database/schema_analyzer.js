// Schema Analyzer para Supabase
// Este script toma el JSON del esquema y genera un resumen estructurado

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Obtener el directorio actual
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Función principal
async function analyzeSchema() {
  try {
    console.log("Analizando esquema de base de datos...");
    
    const schemaPath = path.join(__dirname, 'schema.sql');
    console.log(`Leyendo archivo: ${schemaPath}`);
    
    if (!fs.existsSync(schemaPath)) {
      console.error("Error: No se encontró el archivo schema.sql");
      console.error("Por favor, ejecute la consulta SQL en Supabase y guarde el resultado en schema.sql");
      process.exit(1);
    }
    
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');
    console.log(`Archivo leído: ${schemaContent.length} caracteres`);
    
    // Extraer el JSON del archivo
    let schemaData;
    try {
      schemaData = JSON.parse(schemaContent);
      console.log(`JSON parseado correctamente: ${schemaData.length} elementos`);
    } catch (e) {
      console.log("El contenido no es JSON puro, intentando extraer la parte JSON...");
      // Si el archivo no es JSON puro, intentamos extraer la parte JSON
      const jsonMatch = schemaContent.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        console.log("Se encontró un patrón JSON en el contenido");
        schemaData = JSON.parse(jsonMatch[0]);
        console.log(`JSON extraído y parseado: ${schemaData.length} elementos`);
      } else {
        throw new Error('No se pudo extraer JSON válido del archivo');
      }
    }

    // Organizar los datos por esquema y tabla
    console.log("Organizando datos por esquema y tabla...");
    const organizedSchema = {};
    
    schemaData.forEach(item => {
      const { schema, table, column, data_type, nullable, constraint_type, references_table } = item;
      
      if (!organizedSchema[schema]) {
        organizedSchema[schema] = {};
      }
      
      if (!organizedSchema[schema][table]) {
        organizedSchema[schema][table] = {
          columns: [],
          primaryKey: null,
          foreignKeys: [],
          uniqueConstraints: []
        };
      }
      
      // Añadir columna
      organizedSchema[schema][table].columns.push({
        name: column,
        type: data_type,
        nullable: nullable === 'NULL'
      });
      
      // Registrar restricciones
      if (constraint_type === 'PRIMARY KEY') {
        organizedSchema[schema][table].primaryKey = column;
      } else if (constraint_type === 'FOREIGN KEY') {
        organizedSchema[schema][table].foreignKeys.push({
          column,
          references: references_table
        });
      } else if (constraint_type === 'UNIQUE') {
        organizedSchema[schema][table].uniqueConstraints.push(column);
      }
    });
    
    // Generar resumen
    console.log("Generando resumen en formato Markdown...");
    let summary = '# Resumen del Esquema de Base de Datos\n\n';
    
    Object.keys(organizedSchema).sort().forEach(schema => {
      summary += `## Esquema: ${schema}\n\n`;
      
      const tables = Object.keys(organizedSchema[schema]).sort();
      summary += `Contiene ${tables.length} tabla(s):\n\n`;
      
      tables.forEach(table => {
        const tableData = organizedSchema[schema][table];
        summary += `### Tabla: ${table}\n\n`;
        
        // Columnas
        summary += '#### Columnas\n\n';
        summary += '| Nombre | Tipo | Nullable | Restricciones |\n';
        summary += '|--------|------|----------|---------------|\n';
        
        tableData.columns.forEach(col => {
          const constraints = [];
          if (col.name === tableData.primaryKey) constraints.push('PRIMARY KEY');
          if (tableData.uniqueConstraints.includes(col.name)) constraints.push('UNIQUE');
          
          const fkConstraint = tableData.foreignKeys.find(fk => fk.column === col.name);
          if (fkConstraint) constraints.push(`FK → ${fkConstraint.references}`);
          
          summary += `| ${col.name} | ${col.type} | ${col.nullable ? 'Sí' : 'No'} | ${constraints.join(', ')} |\n`;
        });
        
        summary += '\n';
      });
      
      summary += '\n';
    });
    
    // Generar visualización de relaciones
    console.log("Generando visualización de relaciones en formato Mermaid...");
    let relations = '# Relaciones entre Tablas\n\n';
    relations += '```mermaid\nerDiagram\n';
    
    // Registrar todas las tablas primero
    for (const schema of Object.keys(organizedSchema).sort()) {
      for (const table of Object.keys(organizedSchema[schema]).sort()) {
        relations += `    ${schema}_${table} {\n`;
        for (const col of organizedSchema[schema][table].columns) {
          const pk_marker = col.name === organizedSchema[schema][table].primaryKey ? 'PK' : '';
          relations += `        ${col.type} ${col.name} ${pk_marker}\n`;
        }
        relations += '    }\n';
      }
    }
    
    // Luego registrar todas las relaciones
    for (const schema of Object.keys(organizedSchema).sort()) {
      for (const table of Object.keys(organizedSchema[schema]).sort()) {
        for (const fk of organizedSchema[schema][table].foreignKeys) {
          if (fk.references) {
            const ref_parts = fk.references.split('.');
            if (ref_parts.length === 2) {
              const [ref_schema, ref_table] = ref_parts;
              relations += `    ${schema}_${table} ||--o{ ${ref_schema}_${ref_table} : "${fk.column}"\n`;
            }
          }
        }
      }
    }
    
    relations += '```\n';
    
    // Guardar los archivos
    const summaryPath = path.join(__dirname, 'schema_summary.md');
    fs.writeFileSync(summaryPath, summary);
    console.log(`Resumen del esquema guardado en: ${summaryPath}`);
    
    const relationsPath = path.join(__dirname, 'schema_relations.md');
    fs.writeFileSync(relationsPath, relations);
    console.log(`Visualización de relaciones guardada en: ${relationsPath}`);
    
    // Generar estadísticas
    console.log("\nEstadísticas del esquema:");
    const schemas = Object.keys(organizedSchema);
    let totalTables = 0;
    let totalColumns = 0;
    
    schemas.forEach(schema => {
      const tables = Object.keys(organizedSchema[schema]);
      totalTables += tables.length;
      
      tables.forEach(table => {
        totalColumns += organizedSchema[schema][table].columns.length;
      });
    });
    
    console.log(`- Esquemas: ${schemas.length}`);
    console.log(`- Tablas: ${totalTables}`);
    console.log(`- Columnas: ${totalColumns}`);
    
    console.log("\nAnálisis completado con éxito.");
    
  } catch (error) {
    console.error('Error al procesar el esquema:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Ejecutar la función principal
analyzeSchema(); 