#!/usr/bin/env python3
# Schema Analyzer para Supabase (versión Python)
# Este script toma el JSON del esquema y genera un resumen estructurado

import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime

def analyze_schema():
    print("Analizando esquema de base de datos...")
    
    try:
        # Cargar el esquema JSON
        script_dir = os.path.dirname(os.path.abspath(__file__))
        schema_path = os.path.join(script_dir, 'schema.sql')
        print(f"Leyendo archivo: {schema_path}")
        
        if not os.path.exists(schema_path):
            print("Error: No se encontró el archivo schema.sql")
            print("Por favor, ejecute la consulta SQL en Supabase y guarde el resultado en schema.sql")
            sys.exit(1)
        
        with open(schema_path, 'r') as file:
            schema_content = file.read()
        
        print(f"Archivo leído: {len(schema_content)} caracteres")
        
        # Extraer el JSON del archivo
        schema_data = None
        try:
            schema_data = json.loads(schema_content)
            print(f"JSON parseado correctamente: {len(schema_data)} elementos")
        except json.JSONDecodeError:
            print("El contenido no es JSON puro, intentando extraer la parte JSON...")
            # Si el archivo no es JSON puro, intentamos extraer la parte JSON
            json_match = re.search(r'\[\s*\{[\s\S]*\}\s*\]', schema_content)
            if json_match:
                print("Se encontró un patrón JSON en el contenido")
                schema_data = json.loads(json_match.group(0))
                print(f"JSON extraído y parseado: {len(schema_data)} elementos")
            else:
                raise ValueError("No se pudo extraer JSON válido del archivo")
        
        # Organizar los datos por esquema y tabla
        print("Organizando datos por esquema y tabla...")
        organized_schema = defaultdict(lambda: defaultdict(lambda: {
            'columns': [],
            'primary_key': None,
            'foreign_keys': [],
            'unique_constraints': []
        }))
        
        for item in schema_data:
            schema = item['schema']
            table = item['table']
            column = item['column']
            data_type = item['data_type']
            nullable = item['nullable']
            constraint_type = item['constraint_type']
            references_table = item['references_table']
            
            # Añadir columna
            organized_schema[schema][table]['columns'].append({
                'name': column,
                'type': data_type,
                'nullable': nullable == 'NULL'
            })
            
            # Registrar restricciones
            if constraint_type == 'PRIMARY KEY':
                organized_schema[schema][table]['primary_key'] = column
            elif constraint_type == 'FOREIGN KEY':
                organized_schema[schema][table]['foreign_keys'].append({
                    'column': column,
                    'references': references_table
                })
            elif constraint_type == 'UNIQUE':
                organized_schema[schema][table]['unique_constraints'].append(column)
        
        # Generar resumen
        print("Generando resumen en formato Markdown...")
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        summary = f'# Resumen del Esquema de Base de Datos\n\n'
        summary += f'*Generado el: {timestamp}*\n\n'
        
        for schema in sorted(organized_schema.keys()):
            summary += f'## Esquema: {schema}\n\n'
            
            tables = sorted(organized_schema[schema].keys())
            summary += f'Contiene {len(tables)} tabla(s):\n\n'
            
            for table in tables:
                table_data = organized_schema[schema][table]
                summary += f'### Tabla: {table}\n\n'
                
                # Columnas
                summary += '#### Columnas\n\n'
                summary += '| Nombre | Tipo | Nullable | Restricciones |\n'
                summary += '|--------|------|----------|---------------|\n'
                
                for col in table_data['columns']:
                    constraints = []
                    if col['name'] == table_data['primary_key']:
                        constraints.append('PRIMARY KEY')
                    if col['name'] in table_data['unique_constraints']:
                        constraints.append('UNIQUE')
                    
                    fk_constraint = next((fk for fk in table_data['foreign_keys'] if fk['column'] == col['name']), None)
                    if fk_constraint:
                        constraints.append(f"FK → {fk_constraint['references']}")
                    
                    summary += f"| {col['name']} | {col['type']} | {'Sí' if col['nullable'] else 'No'} | {', '.join(constraints)} |\n"
                
                summary += '\n'
            
            summary += '\n'
        
        # Guardar el resumen
        summary_path = os.path.join(script_dir, 'schema_summary.md')
        with open(summary_path, 'w') as file:
            file.write(summary)
        
        print(f"Resumen del esquema guardado en: {summary_path}")
        
        # Generar visualización de relaciones
        print("Generando visualización de relaciones en formato Mermaid...")
        relations_summary = '# Relaciones entre Tablas\n\n'
        relations_summary += f'*Generado el: {timestamp}*\n\n'
        relations_summary += '```mermaid\nerDiagram\n'
        
        # Registrar todas las tablas primero
        for schema in sorted(organized_schema.keys()):
            for table in sorted(organized_schema[schema].keys()):
                relations_summary += f'    {schema}_{table} {{\n'
                for col in organized_schema[schema][table]['columns']:
                    pk_marker = 'PK' if col['name'] == organized_schema[schema][table]['primary_key'] else ''
                    relations_summary += f'        {col["type"]} {col["name"]} {pk_marker}\n'
                relations_summary += '    }\n'
        
        # Luego registrar todas las relaciones
        for schema in sorted(organized_schema.keys()):
            for table in sorted(organized_schema[schema].keys()):
                for fk in organized_schema[schema][table]['foreign_keys']:
                    if fk['references']:
                        ref_parts = fk['references'].split('.')
                        if len(ref_parts) == 2:
                            ref_schema, ref_table = ref_parts
                            relations_summary += f'    {schema}_{table} ||--o{{ {ref_schema}_{ref_table} : "{fk["column"]}"\n'
        
        relations_summary += '```\n'
        
        # Guardar la visualización de relaciones
        relations_path = os.path.join(script_dir, 'schema_relations.md')
        with open(relations_path, 'w') as file:
            file.write(relations_summary)
        
        print(f"Visualización de relaciones guardada en: {relations_path}")
        
        # Generar estadísticas
        print("\nEstadísticas del esquema:")
        schemas = list(organized_schema.keys())
        total_tables = 0
        total_columns = 0
        
        for schema in schemas:
            tables = list(organized_schema[schema].keys())
            total_tables += len(tables)
            
            for table in tables:
                total_columns += len(organized_schema[schema][table]['columns'])
        
        print(f"- Esquemas: {len(schemas)}")
        print(f"- Tablas: {total_tables}")
        print(f"- Columnas: {total_columns}")
        
        # Generar archivo de estadísticas
        stats = {
            "timestamp": timestamp,
            "schemas": len(schemas),
            "tables": total_tables,
            "columns": total_columns,
            "schema_details": {}
        }
        
        for schema in schemas:
            tables = list(organized_schema[schema].keys())
            schema_tables = []
            
            for table in tables:
                table_data = organized_schema[schema][table]
                schema_tables.append({
                    "name": table,
                    "columns": len(table_data['columns']),
                    "has_primary_key": table_data['primary_key'] is not None,
                    "foreign_keys": len(table_data['foreign_keys']),
                    "unique_constraints": len(table_data['unique_constraints'])
                })
            
            stats["schema_details"][schema] = {
                "tables": len(tables),
                "table_details": schema_tables
            }
        
        stats_path = os.path.join(script_dir, 'schema_stats.json')
        with open(stats_path, 'w') as file:
            json.dump(stats, file, indent=2)
        
        print(f"Estadísticas guardadas en: {stats_path}")
        print("\nAnálisis completado con éxito.")
        
    except Exception as e:
        print(f"Error al procesar el esquema: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    analyze_schema() 