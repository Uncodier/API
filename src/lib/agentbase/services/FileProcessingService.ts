/**
 * FileProcessingService - Servicio para procesar archivos para agentes
 */
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';

export class FileProcessingService {
  private static instance: FileProcessingService;
  
  private constructor() {
    console.log('📄 FileProcessingService: Inicializado');
  }
  
  public static getInstance(): FileProcessingService {
    if (!FileProcessingService.instance) {
      FileProcessingService.instance = new FileProcessingService();
    }
    return FileProcessingService.instance;
  }

  /**
   * Añade el contenido de los archivos del agente al background
   * Especialmente procesa los archivos CSV, Markdown, JSON, TXT y YAML para incluirlos directamente
   */
  public async appendAgentFilesToBackground(background: string, files: any[]): Promise<string> {
    if (!files || files.length === 0) {
      console.log(`⚠️ No hay archivos para añadir al background`);
      return background;
    }
    
    console.log(`🔍 Procesando ${files.length} archivos para añadir al background`);
    let updatedBackground = background;
    let processedFilesAdded = 0;
    
    try {
      // Añadir sección específica para archivos
      updatedBackground += '\n\n## Reference Files';
      
      for (const file of files) {
        try {
          // Determinar tipo de archivo - múltiples formas de verificar
          const fileType = file.file_type?.toLowerCase() || '';
          const fileName = file.name || file.file_path?.split('/').pop() || 'unnamed_file';
          const filePath = file.file_path || file.id; // Usar path o ID si path no está disponible
          
          console.log(`📄 Procesando archivo: ${fileName} (${fileType || 'tipo desconocido'}), path: ${filePath}`);
          
          // Verificar si es un CSV de múltiples formas
          const isCSV = fileType === 'csv' || 
                       fileName.toLowerCase().endsWith('.csv') || 
                       (file.metadata && file.metadata.mime_type === 'text/csv') ||
                       (typeof filePath === 'string' && filePath.toLowerCase().endsWith('.csv')) ||
                       (file.public_url && typeof file.public_url === 'string' && file.public_url.toLowerCase().includes('.csv'));
          
          // Verificar si es un archivo Markdown de múltiples formas
          const isMarkdown = fileType === 'md' || 
                            fileType === 'markdown' ||
                            fileName.toLowerCase().endsWith('.md') || 
                            fileName.toLowerCase().endsWith('.markdown') ||
                            (file.metadata && (file.metadata.mime_type === 'text/markdown' || file.metadata.mime_type === 'text/x-markdown')) ||
                            (typeof filePath === 'string' && (filePath.toLowerCase().endsWith('.md') || filePath.toLowerCase().endsWith('.markdown'))) ||
                            (file.public_url && typeof file.public_url === 'string' && (file.public_url.toLowerCase().includes('.md') || file.public_url.toLowerCase().includes('.markdown')));
          
          // Verificar si es un archivo JSON de múltiples formas
          const isJSON = fileType === 'json' || 
                        fileName.toLowerCase().endsWith('.json') ||
                        (file.metadata && file.metadata.mime_type === 'application/json') ||
                        (typeof filePath === 'string' && filePath.toLowerCase().endsWith('.json')) ||
                        (file.public_url && typeof file.public_url === 'string' && file.public_url.toLowerCase().includes('.json'));
          
          // Verificar si es un archivo TXT de múltiples formas
          const isTXT = fileType === 'txt' || 
                       fileType === 'text' ||
                       fileName.toLowerCase().endsWith('.txt') ||
                       (file.metadata && (file.metadata.mime_type === 'text/plain' || file.metadata.mime_type === 'text/txt')) ||
                       (typeof filePath === 'string' && filePath.toLowerCase().endsWith('.txt')) ||
                       (file.public_url && typeof file.public_url === 'string' && file.public_url.toLowerCase().includes('.txt'));
          
          // Verificar si es un archivo YAML de múltiples formas
          const isYAML = fileType === 'yaml' || 
                        fileType === 'yml' ||
                        fileName.toLowerCase().endsWith('.yaml') ||
                        fileName.toLowerCase().endsWith('.yml') ||
                        (file.metadata && (file.metadata.mime_type === 'application/yaml' || file.metadata.mime_type === 'text/yaml')) ||
                        (typeof filePath === 'string' && (filePath.toLowerCase().endsWith('.yaml') || filePath.toLowerCase().endsWith('.yml'))) ||
                        (file.public_url && typeof file.public_url === 'string' && (file.public_url.toLowerCase().includes('.yaml') || file.public_url.toLowerCase().includes('.yml')));
          
          // Si es un archivo CSV, obtener y añadir su contenido directamente
          if (isCSV) {
            console.log(`📊 Archivo CSV detectado: ${fileName}, intentando obtener contenido...`);
            console.log(`📊 URL del archivo: ${file.public_url || 'No disponible'}`);
            
            // Intentar obtener el contenido directamente de la URL pública si está disponible
            let fileContent = null;
            
            if (file.public_url) {
              try {
                console.log(`🌐 Intentando obtener directamente desde URL pública: ${file.public_url}`);
                const response = await fetch(file.public_url);
                if (response.ok) {
                  fileContent = await response.text();
                  console.log(`✅ Contenido obtenido directamente de URL pública (${fileContent.length} bytes)`);
                } else {
                  console.warn(`⚠️ Error al obtener contenido de URL pública: ${response.status} ${response.statusText}`);
                }
              } catch (urlError) {
                console.error(`❌ Error al obtener desde URL:`, urlError);
              }
            }
            
            // Si no se pudo obtener desde la URL, intentar con el método habitual
            if (!fileContent) {
              fileContent = await this.getFileContent(file, 'csv');
            }
            
            if (fileContent) {
              // Añadir el contenido CSV directamente al background
              updatedBackground += `\n\n### ${fileName}\n\`\`\`csv\n${fileContent}\n\`\`\``;
              console.log(`✅ Contenido CSV añadido para: ${fileName} (${fileContent.length} caracteres)`);
              processedFilesAdded++;
            } else {
              console.warn(`⚠️ No se pudo obtener el contenido del archivo CSV: ${fileName}`);
              updatedBackground += `\n\n### ${fileName}\nCSV file reference (content could not be loaded)`;
            }
          } else if (isMarkdown) {
            // Si es un archivo Markdown, obtener y añadir su contenido directamente
            console.log(`📝 Archivo Markdown detectado: ${fileName}, intentando obtener contenido...`);
            console.log(`📝 URL del archivo: ${file.public_url || 'No disponible'}`);
            
            // Intentar obtener el contenido directamente de la URL pública si está disponible
            let fileContent = null;
            
            if (file.public_url) {
              try {
                console.log(`🌐 Intentando obtener directamente desde URL pública: ${file.public_url}`);
                const response = await fetch(file.public_url);
                if (response.ok) {
                  fileContent = await response.text();
                  console.log(`✅ Contenido obtenido directamente de URL pública (${fileContent.length} bytes)`);
                } else {
                  console.warn(`⚠️ Error al obtener contenido de URL pública: ${response.status} ${response.statusText}`);
                }
              } catch (urlError) {
                console.error(`❌ Error al obtener desde URL:`, urlError);
              }
            }
            
            // Si no se pudo obtener desde la URL, intentar con el método habitual
            if (!fileContent) {
              fileContent = await this.getFileContent(file, 'markdown');
            }
            
            if (fileContent) {
              // Añadir el contenido Markdown directamente al background
              updatedBackground += `\n\n### ${fileName}\n\`\`\`markdown\n${fileContent}\n\`\`\``;
              console.log(`✅ Contenido Markdown añadido para: ${fileName} (${fileContent.length} caracteres)`);
              processedFilesAdded++;
            } else {
              console.warn(`⚠️ No se pudo obtener el contenido del archivo Markdown: ${fileName}`);
              updatedBackground += `\n\n### ${fileName}\nMarkdown file reference (content could not be loaded)`;
            }
          } else if (isJSON) {
            // Si es un archivo JSON, obtener y añadir su contenido directamente
            console.log(`🔗 Archivo JSON detectado: ${fileName}, intentando obtener contenido...`);
            console.log(`🔗 URL del archivo: ${file.public_url || 'No disponible'}`);
            
            // Intentar obtener el contenido directamente de la URL pública si está disponible
            let fileContent = null;
            
            if (file.public_url) {
              try {
                console.log(`🌐 Intentando obtener directamente desde URL pública: ${file.public_url}`);
                const response = await fetch(file.public_url);
                if (response.ok) {
                  fileContent = await response.text();
                  console.log(`✅ Contenido obtenido directamente de URL pública (${fileContent.length} bytes)`);
                } else {
                  console.warn(`⚠️ Error al obtener contenido de URL pública: ${response.status} ${response.statusText}`);
                }
              } catch (urlError) {
                console.error(`❌ Error al obtener desde URL:`, urlError);
              }
            }
            
            // Si no se pudo obtener desde la URL, intentar con el método habitual
            if (!fileContent) {
              fileContent = await this.getFileContent(file, 'json');
            }
            
            if (fileContent) {
              // Añadir el contenido JSON directamente al background
              updatedBackground += `\n\n### ${fileName}\n\`\`\`json\n${fileContent}\n\`\`\``;
              console.log(`✅ Contenido JSON añadido para: ${fileName} (${fileContent.length} caracteres)`);
              processedFilesAdded++;
            } else {
              console.warn(`⚠️ No se pudo obtener el contenido del archivo JSON: ${fileName}`);
              updatedBackground += `\n\n### ${fileName}\nJSON file reference (content could not be loaded)`;
            }
          } else if (isTXT) {
            // Si es un archivo TXT, obtener y añadir su contenido directamente
            console.log(`📄 Archivo TXT detectado: ${fileName}, intentando obtener contenido...`);
            console.log(`📄 URL del archivo: ${file.public_url || 'No disponible'}`);
            
            // Intentar obtener el contenido directamente de la URL pública si está disponible
            let fileContent = null;
            
            if (file.public_url) {
              try {
                console.log(`🌐 Intentando obtener directamente desde URL pública: ${file.public_url}`);
                const response = await fetch(file.public_url);
                if (response.ok) {
                  fileContent = await response.text();
                  console.log(`✅ Contenido obtenido directamente de URL pública (${fileContent.length} bytes)`);
                } else {
                  console.warn(`⚠️ Error al obtener contenido de URL pública: ${response.status} ${response.statusText}`);
                }
              } catch (urlError) {
                console.error(`❌ Error al obtener desde URL:`, urlError);
              }
            }
            
            // Si no se pudo obtener desde la URL, intentar con el método habitual
            if (!fileContent) {
              fileContent = await this.getFileContent(file, 'txt');
            }
            
            if (fileContent) {
              // Añadir el contenido TXT directamente al background
              updatedBackground += `\n\n### ${fileName}\n\`\`\`text\n${fileContent}\n\`\`\``;
              console.log(`✅ Contenido TXT añadido para: ${fileName} (${fileContent.length} caracteres)`);
              processedFilesAdded++;
            } else {
              console.warn(`⚠️ No se pudo obtener el contenido del archivo TXT: ${fileName}`);
              updatedBackground += `\n\n### ${fileName}\nTXT file reference (content could not be loaded)`;
            }
          } else if (isYAML) {
            // Si es un archivo YAML, obtener y añadir su contenido directamente
            console.log(`⚙️ Archivo YAML detectado: ${fileName}, intentando obtener contenido...`);
            console.log(`⚙️ URL del archivo: ${file.public_url || 'No disponible'}`);
            
            // Intentar obtener el contenido directamente de la URL pública si está disponible
            let fileContent = null;
            
            if (file.public_url) {
              try {
                console.log(`🌐 Intentando obtener directamente desde URL pública: ${file.public_url}`);
                const response = await fetch(file.public_url);
                if (response.ok) {
                  fileContent = await response.text();
                  console.log(`✅ Contenido obtenido directamente de URL pública (${fileContent.length} bytes)`);
                } else {
                  console.warn(`⚠️ Error al obtener contenido de URL pública: ${response.status} ${response.statusText}`);
                }
              } catch (urlError) {
                console.error(`❌ Error al obtener desde URL:`, urlError);
              }
            }
            
            // Si no se pudo obtener desde la URL, intentar con el método habitual
            if (!fileContent) {
              fileContent = await this.getFileContent(file, 'yaml');
            }
            
            if (fileContent) {
              // Añadir el contenido YAML directamente al background
              updatedBackground += `\n\n### ${fileName}\n\`\`\`yaml\n${fileContent}\n\`\`\``;
              console.log(`✅ Contenido YAML añadido para: ${fileName} (${fileContent.length} caracteres)`);
              processedFilesAdded++;
            } else {
              console.warn(`⚠️ No se pudo obtener el contenido del archivo YAML: ${fileName}`);
              updatedBackground += `\n\n### ${fileName}\nYAML file reference (content could not be loaded)`;
            }
          } else {
            // Para otros tipos de archivos, solo añadir una referencia
            console.log(`📎 Añadiendo referencia para archivo no-soportado: ${fileName}`);
            updatedBackground += `\n\n### ${fileName}\nReference file of type: ${fileType || 'unknown'}`;
          }
        } catch (fileError: any) {
          console.error(`❌ Error al procesar archivo individual para background:`, fileError);
          // Continuar con el siguiente archivo
        }
      }
      
      console.log(`✅ Procesamiento de archivos completado: ${processedFilesAdded} archivos procesados añadidos al background`);
      
      if (processedFilesAdded === 0) {
        console.warn(`⚠️ No se añadió ningún contenido de archivos al background. Revise que los archivos existan y sean accesibles.`);
      }
      
      return updatedBackground;
    } catch (error: any) {
      console.error(`❌ Error general al procesar archivos para background:`, error);
      // En caso de error, devolver el background original
      return background;
    }
  }
  
  /**
   * Obtiene el contenido de un archivo específico (CSV, Markdown, JSON, TXT, YAML)
   * Implementa lógica adicional para manejar errores y formatear archivos
   */
  private async getFileContent(file: any, fileTypeHint: 'csv' | 'markdown' | 'json' | 'txt' | 'yaml'): Promise<string | null> {
    try {
      console.log(`📄 Obteniendo contenido ${fileTypeHint.toUpperCase()} para: ${file.name || file.file_path}`);
      
      // Intento 1: Si hay una URL pública disponible, intentar descargar directamente
      if (file.public_url) {
        console.log(`🔍 Archivo tiene URL pública: ${file.public_url}`);
        const urlContent = await this.downloadFromUrl(file.public_url);
        if (urlContent) {
          console.log(`✅ Contenido obtenido desde URL pública`);
          return urlContent;
        }
      }
      
      // Intentar obtener el archivo usando diversos enfoques
      const filePath = file.file_path || file.id;
      
      // Intento 2: Usar el método estándar
      let content = await DatabaseAdapter.getAgentFileContent(filePath);
      
      if (!content) {
        console.log(`⚠️ No se pudo obtener ${fileTypeHint} por método estándar, intentando con asset_id: ${file.id}`);
        // Intento 3: Usar directamente el ID del asset
        content = await DatabaseAdapter.getAgentFileContent(file.id);
      }
      
      if (!content && file.file_path && typeof file.file_path === 'string') {
        // Intento 4: Si file_path parece ser una URL completa, intentar descarga directa
        if (file.file_path.startsWith('http')) {
          console.log(`🔍 File path parece ser una URL, intentando descarga directa: ${file.file_path}`);
          content = await this.downloadFromUrl(file.file_path);
        }
      }
      
      if (!content) {
        console.error(`❌ No se pudo obtener contenido ${fileTypeHint} para: ${file.name || file.id}`);
        return null;
      }
      
      // Verificar que el contenido sea válido según el tipo
      if (fileTypeHint === 'csv' && !this.isValidCSV(content)) {
        console.warn(`⚠️ Contenido obtenido no parece ser un CSV válido`);
        console.log(`📄 Primeros 200 caracteres: ${content.substring(0, 200)}`);
        return null;
      } else if (fileTypeHint === 'markdown' && !this.isValidMarkdown(content)) {
        console.warn(`⚠️ Contenido obtenido no parece ser un Markdown válido`);
        console.log(`📄 Primeros 200 caracteres: ${content.substring(0, 200)}`);
        // Para Markdown, incluso si no parece válido, lo incluimos de todas formas
        // ya que puede ser contenido de texto plano útil
      } else if (fileTypeHint === 'json' && !this.isValidJSON(content)) {
        console.warn(`⚠️ Contenido obtenido no parece ser un JSON válido`);
        console.log(`📄 Primeros 200 caracteres: ${content.substring(0, 200)}`);
        return null;
      } else if (fileTypeHint === 'yaml' && !this.isValidYAML(content)) {
        console.warn(`⚠️ Contenido obtenido no parece ser un YAML válido`);
        console.log(`📄 Primeros 200 caracteres: ${content.substring(0, 200)}`);
        // Para YAML, incluso si no parece válido, lo incluimos de todas formas
        // ya que puede ser contenido de texto plano útil
      } else if (fileTypeHint === 'txt' && !this.isValidTXT(content)) {
        console.warn(`⚠️ Contenido obtenido no parece ser un TXT válido`);
        console.log(`📄 Primeros 200 caracteres: ${content.substring(0, 200)}`);
        // Para TXT, incluso si no parece válido, lo incluimos de todas formas
        // ya que puede ser contenido de texto plano útil
      }
      
      console.log(`✅ Contenido ${fileTypeHint.toUpperCase()} obtenido correctamente (${content.length} bytes)`);
      return content;
    } catch (error: any) {
      console.error(`❌ Error al obtener ${fileTypeHint}:`, error);
      return null;
    }
  }
  
  /**
   * Descarga contenido directamente desde una URL
   */
  private async downloadFromUrl(url: string): Promise<string | null> {
    if (!url) return null;
    
    try {
      console.log(`🌐 Intentando descargar directamente desde URL: ${url}`);
      
      const response = await fetch(url, {
        headers: {
          'Accept': 'text/plain,text/csv,application/octet-stream,*/*',
          'User-Agent': 'Agentbase/1.0'
        }
      });
      
      if (!response.ok) {
        console.error(`⚠️ Error al descargar de URL: ${response.status} ${response.statusText}`);
        return null;
      }
      
      const content = await response.text();
      console.log(`✅ Contenido descargado con éxito de URL (${content.length} bytes)`);
      
      // Análisis básico para verificar si es un CSV
      if (url.toLowerCase().endsWith('.csv')) {
        const lines = content.split(/\r?\n/).filter(line => line.trim());
        if (lines.length > 0) {
          console.log(`📊 CSV tiene ${lines.length} líneas. Primera línea: ${lines[0]}`);
        }
      }
      
      return content;
    } catch (error: any) {
      console.error(`❌ Error al descargar contenido: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Valida si un contenido tiene formato CSV
   */
  private isValidCSV(content: string): boolean {
    if (!content || typeof content !== 'string') {
      return false;
    }
    
    // Verificar que contenga separadores de columna y al menos una línea
    if (!content.includes(',') || (!content.includes('\n') && !content.includes('\r'))) {
      return false;
    }
    
    // Verificar que tenga múltiples líneas
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) { // Al menos encabezado y una fila de datos
      return false;
    }
    
    // Verificar que las líneas tengan formato de columnas
    return lines.every(line => line.includes(','));
  }

  /**
   * Valida si un contenido tiene formato Markdown válido
   */
  private isValidMarkdown(content: string): boolean {
    if (!content || typeof content !== 'string') {
      return false;
    }
    
    // Para Markdown, la validación es más permisiva ya que 
    // cualquier texto puede ser considerado Markdown válido
    const trimmedContent = content.trim();
    
    // Si está completamente vacío, no es válido
    if (trimmedContent.length === 0) {
      return false;
    }
    
    // Verificar que no sea solo caracteres especiales o espacios
    if (!/\w/.test(trimmedContent)) {
      return false;
    }
    
    // Si el contenido parece tener estructura de Markdown, es válido
    const hasMarkdownStructure = 
      trimmedContent.includes('#') || // Encabezados
      trimmedContent.includes('*') || // Énfasis o listas
      trimmedContent.includes('`') || // Código
      trimmedContent.includes('[') || // Enlaces
      trimmedContent.includes('|') || // Tablas
      trimmedContent.includes('>') || // Citas
      trimmedContent.includes('-') || // Listas
      trimmedContent.length > 50; // Si es suficientemente largo, probablemente tenga contenido útil
    
    return hasMarkdownStructure;
  }
  
  /**
   * Valida si un contenido tiene formato JSON válido
   */
  private isValidJSON(content: string): boolean {
    if (!content || typeof content !== 'string') {
      return false;
    }
    
    const trimmedContent = content.trim();
    
    // Si está completamente vacío, no es válido
    if (trimmedContent.length === 0) {
      return false;
    }
    
    try {
      JSON.parse(trimmedContent);
      return true;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Valida si un contenido tiene formato YAML válido
   */
  private isValidYAML(content: string): boolean {
    if (!content || typeof content !== 'string') {
      return false;
    }
    
    const trimmedContent = content.trim();
    
    // Si está completamente vacío, no es válido
    if (trimmedContent.length === 0) {
      return false;
    }
    
    // Para YAML, hacemos una validación básica de estructura
    // YAML típicamente tiene claves seguidas de dos puntos
    const hasYamlStructure = 
      /^\s*\w+\s*:/.test(trimmedContent) || // Líneas que empiezan con clave:
      /^\s*-\s+/.test(trimmedContent) || // Listas con guiones
      trimmedContent.includes('---') || // Separadores de documento
      trimmedContent.length > 10; // Si es suficientemente largo, probablemente sea válido
    
    return hasYamlStructure;
  }
  
  /**
   * Valida si un contenido tiene formato TXT válido
   */
  private isValidTXT(content: string): boolean {
    if (!content || typeof content !== 'string') {
      return false;
    }
    
    const trimmedContent = content.trim();
    
    // Si está completamente vacío, no es válido
    if (trimmedContent.length === 0) {
      return false;
    }
    
    // Para archivos de texto, la validación es muy permisiva
    // Cualquier contenido que tenga al menos algunos caracteres alfanuméricos es válido
    return /\w/.test(trimmedContent);
  }
} 