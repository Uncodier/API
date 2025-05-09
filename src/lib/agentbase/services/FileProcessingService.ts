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
   * Especialmente procesa los archivos CSV para incluirlos directamente
   */
  public async appendAgentFilesToBackground(background: string, files: any[]): Promise<string> {
    if (!files || files.length === 0) {
      console.log(`⚠️ No hay archivos para añadir al background`);
      return background;
    }
    
    console.log(`🔍 Procesando ${files.length} archivos para añadir al background`);
    let updatedBackground = background;
    let csvFilesAdded = 0;
    
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
              fileContent = await this.getCSVContent(file);
            }
            
            if (fileContent) {
              // Añadir el contenido CSV directamente al background
              updatedBackground += `\n\n### ${fileName}\n\`\`\`csv\n${fileContent}\n\`\`\``;
              console.log(`✅ Contenido CSV añadido para: ${fileName} (${fileContent.length} caracteres)`);
              csvFilesAdded++;
            } else {
              console.warn(`⚠️ No se pudo obtener el contenido del archivo CSV: ${fileName}`);
              updatedBackground += `\n\n### ${fileName}\nCSV file reference (content could not be loaded)`;
            }
          } else {
            // Para otros tipos de archivos, solo añadir una referencia
            console.log(`📎 Añadiendo referencia para archivo no-CSV: ${fileName}`);
            updatedBackground += `\n\n### ${fileName}\nReference file of type: ${fileType || 'unknown'}`;
          }
        } catch (fileError: any) {
          console.error(`❌ Error al procesar archivo individual para background:`, fileError);
          // Continuar con el siguiente archivo
        }
      }
      
      console.log(`✅ Procesamiento de archivos completado: ${csvFilesAdded} archivos CSV añadidos al background`);
      
      if (csvFilesAdded === 0) {
        console.warn(`⚠️ No se añadió ningún contenido CSV al background. Revise que los archivos existan y sean accesibles.`);
      }
      
      return updatedBackground;
    } catch (error: any) {
      console.error(`❌ Error general al procesar archivos para background:`, error);
      // En caso de error, devolver el background original
      return background;
    }
  }
  
  /**
   * Obtiene el contenido CSV de un archivo específico
   * Implementa lógica adicional para manejar errores y formatear CSV
   */
  private async getCSVContent(file: any): Promise<string | null> {
    try {
      console.log(`📊 Obteniendo contenido CSV para: ${file.name || file.file_path}`);
      
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
        console.log(`⚠️ No se pudo obtener CSV por método estándar, intentando con asset_id: ${file.id}`);
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
        console.error(`❌ No se pudo obtener contenido CSV para: ${file.name || file.id}`);
        return null;
      }
      
      // Verificar que el contenido sea realmente un CSV
      if (!this.isValidCSV(content)) {
        console.warn(`⚠️ Contenido obtenido no parece ser un CSV válido`);
        console.log(`📄 Primeros 200 caracteres: ${content.substring(0, 200)}`);
        return null;
      }
      
      console.log(`✅ Contenido CSV obtenido correctamente (${content.length} bytes)`);
      return content;
    } catch (error: any) {
      console.error(`❌ Error al obtener CSV:`, error);
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
} 