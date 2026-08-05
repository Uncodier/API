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
  publicUrl?: string;
  metadata?: any;
  error?: string;
}

export class InstanceAssetsService {
  /**
   * Main public method to append assets context to system prompt
   */
  public static async getAssetsContext(
    instance_id: string
  ): Promise<{ text: string; images: { url: string; fileType: string; publicUrl?: string }[] }> {
    try {
      console.log(`📁 [InstanceAssetsService] Fetching assets for instance: ${instance_id}`);
      
      if (!instance_id) {
        console.log(`⚠️ [InstanceAssetsService] No instance_id provided, skipping assets`);
        return { text: '', images: [] };
      }

      const assets = await this.fetchInstanceAssets(instance_id);
      
      if (!assets || assets.length === 0) {
        console.log(`📁 [InstanceAssetsService] No assets found for instance: ${instance_id}`);
        return { text: '', images: [] };
      }

      console.log(`📁 [InstanceAssetsService] Found ${assets.length} assets for instance: ${instance_id}`);
      
      const processedAssets = await this.processAssets(assets);
      const assetsContext = this.buildAssetsContext(processedAssets);
      
      // Prefer short HTTP publicUrl for workflow serialization. Vision data URLs
      // are hydrated later inside the LLM step (see hydrateMessageImages).
      const images = processedAssets
        .filter(asset => asset.publicUrl || asset.base64Image)
        .map(asset => ({
          url: asset.publicUrl || asset.base64Image!,
          fileType: asset.file_type,
          publicUrl: asset.publicUrl
        }));

      if (!assetsContext.trim()) {
        console.log(`📁 [InstanceAssetsService] No valid asset content generated`);
        return { text: '', images };
      }

      console.log(`✅ [InstanceAssetsService] Assets context appended (${assetsContext.length} characters, ${images.length} images)`);
      return { text: assetsContext, images };

    } catch (error) {
      console.error(`❌ [InstanceAssetsService] Error processing assets:`, error);
      // Return empty on error to avoid breaking the assistant
      return { text: '', images: [] };
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
    const kind = this.resolveAssetKind(fileType, fileName, asset.file_path || asset.public_url || asset.url);

    console.log(`🔍 [InstanceAssetsService] Processing ${fileName} (type: ${fileType}, kind: ${kind})`);

    if (kind === 'text') {
      return await this.processTextFile(asset);
    }
    if (kind === 'image') {
      return await this.processImageFile(asset);
    }
    if (kind === 'document') {
      return await this.processDocumentFile(asset);
    }

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
   * Normalize MIME (`image/png`), extension (`png` / `.png`), and filename hints.
   * Uploads and AI routes often store `file_type` as a full MIME type.
   */
  private static resolveAssetKind(
    fileType: string,
    fileName: string,
    pathOrUrl?: string
  ): 'text' | 'image' | 'document' | 'other' {
    const normalized = this.normalizeFileTypeToken(fileType);
    if (this.isImageFile(normalized) || this.isImageFile(fileType)) return 'image';
    if (this.isTextFile(normalized) || this.isTextFile(fileType)) return 'text';
    if (this.isDocumentFile(normalized) || this.isDocumentFile(fileType)) return 'document';

    const fromName = this.extensionOf(fileName);
    if (fromName) {
      if (this.isImageFile(fromName)) return 'image';
      if (this.isTextFile(fromName)) return 'text';
      if (this.isDocumentFile(fromName)) return 'document';
    }

    const fromPath = this.extensionOf(pathOrUrl || '');
    if (fromPath) {
      if (this.isImageFile(fromPath)) return 'image';
      if (this.isTextFile(fromPath)) return 'text';
      if (this.isDocumentFile(fromPath)) return 'document';
    }

    return 'other';
  }

  /** `image/png` → `png`, `.PNG` → `png`, `png` → `png` */
  private static normalizeFileTypeToken(fileType: string): string {
    if (!fileType) return '';
    let token = fileType.trim().toLowerCase();
    if (token.includes('/')) {
      token = token.split('/').pop() || token;
    }
    // image/svg+xml → svg+xml → svg
    if (token.includes('+')) {
      token = token.split('+')[0] || token;
    }
    if (token.startsWith('.')) token = token.slice(1);
    // jpeg variants
    if (token === 'pjpeg') return 'jpg';
    return token;
  }

  private static extensionOf(nameOrPath: string): string {
    if (!nameOrPath) return '';
    // strip query/hash from URLs
    const clean = nameOrPath.split('?')[0]!.split('#')[0]!;
    const base = clean.split('/').pop() || clean;
    const dot = base.lastIndexOf('.');
    if (dot < 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
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
   * Process image files (.png, .jpg, .jpeg, .gif, .webp).
   * HTTP assets keep only the short publicUrl here so workflow step payloads
   * stay small; binary → data URL happens in hydrateMessageImages (LLM step).
   */
  private static async processImageFile(asset: any): Promise<ProcessedAsset | null> {
    try {
      console.log(`🖼️ [InstanceAssetsService] Processing image file: ${asset.name}`);

      const url = asset.file_path || asset.public_url || asset.url;
      const isHttp = url && (url.startsWith('http://') || url.startsWith('https://'));

      if (isHttp) {
        console.log(`✅ [InstanceAssetsService] Deferred HTTP image for LLM-step hydrate: ${url}`);
        return {
          id: asset.id,
          name: asset.name,
          file_type: asset.file_type,
          publicUrl: url,
        };
      }

      const content = await AgentService.getAgentFileContent(asset.file_path || asset.id);

      if (!content) {
        console.log(`⚠️ [InstanceAssetsService] No content found for image file: ${asset.name}`);
        return {
          id: asset.id,
          name: asset.name,
          file_type: asset.file_type,
          error: 'No content found',
        };
      }

      let base64Image = content;
      if (!content.startsWith('data:image/') && !content.startsWith('http')) {
        const mimeType = this.getMimeType(asset.file_type);
        base64Image = `data:${mimeType};base64,${content}`;
      }

      console.log(`✅ [InstanceAssetsService] Image file processed: ${asset.name} (${base64Image.length} chars)`);

      return {
        id: asset.id,
        name: asset.name,
        file_type: asset.file_type,
        base64Image,
      };
    } catch (error) {
      console.error(`❌ [InstanceAssetsService] Error processing image file ${asset.name}:`, error);
      return {
        id: asset.id,
        name: asset.name,
        file_type: asset.file_type,
        error: `Failed to process image: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
      } else if (asset.publicUrl || asset.base64Image) {
        if (asset.publicUrl) {
          context += `- URL: ${asset.publicUrl}\n`;
        }
        context += `- Content: [Image attached as a multimodal vision part in your user message - ${asset.file_type}]\n`;
        context += `- Note: You ALREADY have native vision capabilities. Analyze and describe this image directly. Do NOT claim you lack vision/OCR tools.\n`;
      } else if (asset.metadata) {
        context += `- Metadata: ${JSON.stringify(asset.metadata, null, 2)}\n`;
      }
      
      context += '\n';
    }

    console.log(`✅ [InstanceAssetsService] Context built (${context.length} characters)`);
    return context;
  }

  /**
   * Check if file type is a text file (extension or MIME subtype)
   */
  private static isTextFile(fileType: string): boolean {
    const token = this.normalizeFileTypeToken(fileType);
    const textTypes = ['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'xml', 'html', 'css', 'js', 'ts', 'plain'];
    return textTypes.includes(token);
  }

  /**
   * Check if file type is an image file (extension or MIME subtype, e.g. image/png → png)
   */
  private static isImageFile(fileType: string): boolean {
    const token = this.normalizeFileTypeToken(fileType);
    const imageTypes = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'svgz'];
    return imageTypes.includes(token);
  }

  /**
   * Check if file type is a document file (extension or MIME subtype)
   */
  private static isDocumentFile(fileType: string): boolean {
    const token = this.normalizeFileTypeToken(fileType);
    const docTypes = ['pdf', 'doc', 'docx', 'rtf', 'odt', 'msword', 'vnd.openxmlformats-officedocument.wordprocessingml.document'];
    // MIME subtypes like vnd.openxmlformats-... are awkward; also accept raw includes
    if (docTypes.includes(token)) return true;
    const raw = (fileType || '').toLowerCase();
    return raw.includes('pdf') || raw.includes('wordprocessingml') || raw.includes('msword');
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




