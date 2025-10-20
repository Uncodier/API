/**
 * Instance Assets Context Service
 * Fetches assets linked to a robot instance and appends their content to system prompt
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { AgentService } from '@/lib/agentbase/adapters/AgentService';

export interface ProcessedAsset {
  id: string;
  name: string;
  file_type: string;
  content?: string;
  base64Image?: string;
  metadata?: any;
  error?: string;
}

export class InstanceAssetsService {
  /**
   * Main public method to append assets context to system prompt
   */
  public static async appendAssetsToSystemPrompt(
    systemPrompt: string, 
    instance_id: string
  ): Promise<string> {
    try {
      console.log(`📁 [InstanceAssetsService] Fetching assets for instance: ${instance_id}`);
      
      if (!instance_id) {
        console.log(`⚠️ [InstanceAssetsService] No instance_id provided, skipping assets`);
        return systemPrompt;
      }

      const assets = await this.fetchInstanceAssets(instance_id);
      
      if (!assets || assets.length === 0) {
        console.log(`📁 [InstanceAssetsService] No assets found for instance: ${instance_id}`);
        return systemPrompt;
      }

      console.log(`📁 [InstanceAssetsService] Found ${assets.length} assets for instance: ${instance_id}`);
      
      const processedAssets = await this.processAssets(assets);
      const assetsContext = this.buildAssetsContext(processedAssets);
      
      if (!assetsContext.trim()) {
        console.log(`📁 [InstanceAssetsService] No valid asset content generated`);
        return systemPrompt;
      }

      const combinedPrompt = [
        systemPrompt,
        assetsContext
      ].filter(Boolean).join('\n\n');

      console.log(`✅ [InstanceAssetsService] Assets context appended (${assetsContext.length} characters)`);
      return combinedPrompt;

    } catch (error) {
      console.error(`❌ [InstanceAssetsService] Error processing assets:`, error);
      // Return original system prompt on error to avoid breaking the assistant
      return systemPrompt;
    }
  }

  /**
   * Fetch all assets linked to an instance
   */
  private static async fetchInstanceAssets(instance_id: string): Promise<any[]> {
    try {
      console.log(`🔍 [InstanceAssetsService] Querying assets for instance_id: ${instance_id}`);
      
      const { data: assets, error } = await supabaseAdmin
        .from('assets')
        .select('*')
        .eq('instance_id', instance_id)
        .order('created_at', { ascending: false });

      if (error) {
        console.error(`❌ [InstanceAssetsService] Database error fetching assets:`, error);
        return [];
      }

      if (!assets || assets.length === 0) {
        console.log(`📁 [InstanceAssetsService] No assets found in database for instance: ${instance_id}`);
        return [];
      }

      console.log(`✅ [InstanceAssetsService] Found ${assets.length} assets in database`);
      return assets;

    } catch (error) {
      console.error(`❌ [InstanceAssetsService] Error fetching assets:`, error);
      return [];
    }
  }

  /**
   * Process all assets and extract their content
   */
  private static async processAssets(assets: any[]): Promise<ProcessedAsset[]> {
    const processedAssets: ProcessedAsset[] = [];

    for (const asset of assets) {
      try {
        console.log(`📄 [InstanceAssetsService] Processing asset: ${asset.name} (${asset.file_type})`);
        
        const processedAsset = await this.processAssetContent(asset);
        if (processedAsset) {
          processedAssets.push(processedAsset);
        }
      } catch (error) {
        console.error(`❌ [InstanceAssetsService] Error processing asset ${asset.name}:`, error);
        
        // Add asset with error info instead of skipping
        processedAssets.push({
          id: asset.id,
          name: asset.name,
          file_type: asset.file_type,
          error: `Failed to process: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
    }

    return processedAssets;
  }

  /**
   * Process individual asset based on file type
   */
  private static async processAssetContent(asset: any): Promise<ProcessedAsset | null> {
    const fileType = asset.file_type?.toLowerCase() || '';
    const fileName = asset.name || 'unknown';
    
    console.log(`🔍 [InstanceAssetsService] Processing ${fileName} (type: ${fileType})`);

    // Handle text files
    if (this.isTextFile(fileType)) {
      return await this.processTextFile(asset);
    }
    
    // Handle image files
    if (this.isImageFile(fileType)) {
      return await this.processImageFile(asset);
    }
    
    // Handle PDF and document files
    if (this.isDocumentFile(fileType)) {
      return await this.processDocumentFile(asset);
    }
    
    // Handle other file types (include metadata only)
    console.log(`📄 [InstanceAssetsService] Unsupported file type: ${fileType}, including metadata only`);
    return {
      id: asset.id,
      name: asset.name,
      file_type: asset.file_type,
      metadata: {
        file_size: asset.file_size,
        description: asset.description,
        created_at: asset.created_at
      }
    };
  }

  /**
   * Process text files (.txt, .md, .json, .yaml, .csv)
   */
  private static async processTextFile(asset: any): Promise<ProcessedAsset | null> {
    try {
      console.log(`📝 [InstanceAssetsService] Reading text file: ${asset.name}`);
      
      const content = await AgentService.getAgentFileContent(asset.file_path || asset.id);
      
      if (!content) {
        console.log(`⚠️ [InstanceAssetsService] No content found for text file: ${asset.name}`);
        return {
          id: asset.id,
          name: asset.name,
          file_type: asset.file_type,
          error: 'No content found'
        };
      }

      // Truncate very large files to prevent context overflow
      const maxLength = 10000; // 10k characters max per file
      const truncatedContent = content.length > maxLength 
        ? content.substring(0, maxLength) + '\n\n[Content truncated due to size]'
        : content;

      console.log(`✅ [InstanceAssetsService] Text file processed: ${asset.name} (${truncatedContent.length} chars)`);
      
      return {
        id: asset.id,
        name: asset.name,
        file_type: asset.file_type,
        content: truncatedContent
      };

    } catch (error) {
      console.error(`❌ [InstanceAssetsService] Error reading text file ${asset.name}:`, error);
      return {
        id: asset.id,
        name: asset.name,
        file_type: asset.file_type,
        error: `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Process image files (.png, .jpg, .jpeg, .gif, .webp)
   */
  private static async processImageFile(asset: any): Promise<ProcessedAsset | null> {
    try {
      console.log(`🖼️ [InstanceAssetsService] Processing image file: ${asset.name}`);
      
      const content = await AgentService.getAgentFileContent(asset.file_path || asset.id);
      
      if (!content) {
        console.log(`⚠️ [InstanceAssetsService] No content found for image file: ${asset.name}`);
        return {
          id: asset.id,
          name: asset.name,
          file_type: asset.file_type,
          error: 'No content found'
        };
      }

      // Convert to base64 if not already
      let base64Image = content;
      if (!content.startsWith('data:image/')) {
        const mimeType = this.getMimeType(asset.file_type);
        base64Image = `data:${mimeType};base64,${content}`;
      }

      console.log(`✅ [InstanceAssetsService] Image file processed: ${asset.name} (${base64Image.length} chars)`);
      
      return {
        id: asset.id,
        name: asset.name,
        file_type: asset.file_type,
        base64Image: base64Image
      };

    } catch (error) {
      console.error(`❌ [InstanceAssetsService] Error processing image file ${asset.name}:`, error);
      return {
        id: asset.id,
        name: asset.name,
        file_type: asset.file_type,
        error: `Failed to process image: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Process document files (PDF, Word docs) - extract text or include metadata
   */
  private static async processDocumentFile(asset: any): Promise<ProcessedAsset | null> {
    try {
      console.log(`📄 [InstanceAssetsService] Processing document file: ${asset.name}`);
      
      // For now, include metadata only since PDF text extraction would require additional dependencies
      // TODO: Add PDF text extraction library if needed
      console.log(`📄 [InstanceAssetsService] Including metadata for document: ${asset.name}`);
      
      return {
        id: asset.id,
        name: asset.name,
        file_type: asset.file_type,
        metadata: {
          file_size: asset.file_size,
          description: asset.description,
          created_at: asset.created_at,
          note: 'Document content extraction not implemented - metadata only'
        }
      };

    } catch (error) {
      console.error(`❌ [InstanceAssetsService] Error processing document file ${asset.name}:`, error);
      return {
        id: asset.id,
        name: asset.name,
        file_type: asset.file_type,
        error: `Failed to process document: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Build formatted context string with all processed assets
   */
  private static buildAssetsContext(processedAssets: ProcessedAsset[]): string {
    if (!processedAssets || processedAssets.length === 0) {
      return '';
    }

    console.log(`📝 [InstanceAssetsService] Building context for ${processedAssets.length} assets`);

    let context = '# Instance Assets Context\n';
    context += 'The following assets are available for this instance:\n\n';

    for (const asset of processedAssets) {
      context += `## Asset: ${asset.name}\n`;
      context += `- Type: ${asset.file_type}\n`;
      
      if (asset.error) {
        context += `- Status: Error - ${asset.error}\n`;
      } else if (asset.content) {
        context += `- Content:\n\`\`\`\n${asset.content}\n\`\`\`\n`;
      } else if (asset.base64Image) {
        context += `- Content: [Image data available - ${asset.file_type}]\n`;
        context += `- Note: This image can be processed by vision models\n`;
      } else if (asset.metadata) {
        context += `- Metadata: ${JSON.stringify(asset.metadata, null, 2)}\n`;
      }
      
      context += '\n';
    }

    console.log(`✅ [InstanceAssetsService] Context built (${context.length} characters)`);
    return context;
  }

  /**
   * Check if file type is a text file
   */
  private static isTextFile(fileType: string): boolean {
    const textTypes = ['txt', 'md', 'json', 'yaml', 'yml', 'csv', 'xml', 'html', 'css', 'js', 'ts'];
    return textTypes.includes(fileType.toLowerCase());
  }

  /**
   * Check if file type is an image file
   */
  private static isImageFile(fileType: string): boolean {
    const imageTypes = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
    return imageTypes.includes(fileType.toLowerCase());
  }

  /**
   * Check if file type is a document file
   */
  private static isDocumentFile(fileType: string): boolean {
    const docTypes = ['pdf', 'doc', 'docx', 'rtf', 'odt'];
    return docTypes.includes(fileType.toLowerCase());
  }

  /**
   * Get MIME type for file type
   */
  private static getMimeType(fileType: string): string {
    const mimeTypes: Record<string, string> = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'bmp': 'image/bmp',
      'svg': 'image/svg+xml'
    };
    
    return mimeTypes[fileType.toLowerCase()] || 'image/png';
  }
}




