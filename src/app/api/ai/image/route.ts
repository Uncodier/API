import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabaseAdmin } from '@/lib/database/supabase-client';

type Provider = 'azure' | 'gemini' | 'vercel';

interface ImageRequestBody {
  prompt: string;
  site_id: string;
  provider?: Provider;
  size?: '256x256' | '512x512' | '1024x1024';
  n?: number;
  quality?: 'standard' | 'hd' | number;
  ratio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
  reference_images?: string[];
}

function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[image api] Missing environment variable ${name}`);
  }
  return value;
}

/**
 * Convert image URL to base64 data
 */
async function convertUrlToBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    console.log(`[Image API] Converting URL to base64: ${url.substring(0, 100)}...`);
    
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });
    
    if (!response.ok) {
      console.warn(`[Image API] Failed to fetch reference image: ${response.status} ${response.statusText}`);
      return null;
    }
    
    const buffer = await response.arrayBuffer();
    const base64Data = Buffer.from(buffer).toString('base64');
    const mimeType = response.headers.get('content-type') || 'image/png';
    
    console.log(`[Image API] Successfully converted to base64: ${mimeType}, ${buffer.byteLength} bytes`);
    
    return {
      data: base64Data,
      mimeType
    };
    
  } catch (error: any) {
    console.warn(`[Image API] Error converting URL to base64: ${error.message}`);
    return null;
  }
}

/**
 * Upload base64 image to Supabase Storage
 */
async function uploadImageToStorage(
  base64Data: string, 
  mimeType: string, 
  siteId: string, 
  provider: string, 
  prompt: string
): Promise<{ path: string; url: string; size: number; mimeType: string }> {
  try {
    // Convert base64 to Buffer
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Determine file extension from mimeType
    let ext = 'png';
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
      ext = 'jpg';
    } else if (mimeType.includes('gif')) {
      ext = 'gif';
    }
    
    // Generate unique path
    const timestamp = Date.now();
    const path = `${siteId}/${timestamp}.${ext}`;
    
    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabaseAdmin
      .storage
      .from('generative_images')
      .upload(path, buffer, {
        contentType: mimeType,
        upsert: false,
      });
    
    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }
    
    // Get public URL
    const { data: urlData } = supabaseAdmin.storage.from('generative_images').getPublicUrl(path);
    let url = urlData?.publicUrl || '';
    
    // If no public URL, create signed URL
    if (!url) {
      const { data: signedData, error: signError } = await supabaseAdmin
        .storage
        .from('generative_images')
        .createSignedUrl(path, 60 * 60 * 24 * 7); // 7 days
      
      if (signError || !signedData?.signedUrl) {
        throw new Error(`Failed to generate file URL: ${signError?.message}`);
      }
      url = signedData.signedUrl;
    }
    
    return {
      path: uploadData.path,
      url,
      size: buffer.length,
      mimeType
    };
    
  } catch (error: any) {
    console.error('[Image Storage] Upload error:', error);
    throw new Error(`Failed to upload image to storage: ${error.message}`);
  }
}

/**
 * Save file record to database
 */
async function saveFileRecord(
  siteId: string,
  path: string,
  url: string,
  size: number,
  mimeType: string,
  provider: string,
  prompt: string,
  model?: string,
  userId?: string
): Promise<any> {
  try {
    const timestamp = Date.now();
    const filename = `${provider}_image_${timestamp}.${mimeType.split('/')[1]}`;
    
    // Get site owner if userId not provided
    let ownerUserId = userId;
    if (!ownerUserId) {
      const { data: ownershipData, error: ownershipError } = await supabaseAdmin
        .from('site_ownership')
        .select('user_id')
        .eq('site_id', siteId)
        .single();
      
      if (ownershipError) {
        console.warn('[File Record] Could not get site owner:', ownershipError.message);
      } else {
        ownerUserId = ownershipData?.user_id;
        console.log(`[File Record] Found site owner: ${ownerUserId}`);
      }
    }
    
    console.log(`[File Record] Attempting to save:`, {
      siteId,
      filename,
      path,
      url: url.substring(0, 100) + '...',
      size,
      mimeType,
      provider,
      model,
      userId: ownerUserId
    });
    
    const insertData: any = {
      site_id: siteId,
      name: filename,
      file_path: url, // Use the public URL as file_path
      file_type: mimeType,
      file_size: size,
      metadata: {
        provider,
        prompt,
        generated_at: new Date().toISOString(),
        model: model || 'unknown',
        storage_path: path, // Store the internal storage path in metadata
        bucket: 'generative_images'
      },
      is_public: true
    };

    // Only add user_id if we have one (either provided or found from site ownership)
    if (ownerUserId) {
      insertData.user_id = ownerUserId;
    }

    const { data, error } = await supabaseAdmin
      .from('assets')
      .insert(insertData)
      .select()
      .single();
    
    if (error) {
      throw new Error(`Database insert failed: ${error.message || error.details || JSON.stringify(error)}`);
    }
    
    return data;
    
  } catch (error: any) {
    console.error('[File Record] Save error:', error);
    throw new Error(`Failed to save file record: ${error.message || error.details || JSON.stringify(error)}`);
  }
}

async function generateWithAzure(prompt: string, siteId: string, size?: string, n?: number, quality?: 'standard' | 'hd' | number, ratio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3', reference_images?: string[]) {
  try {
    // Use the same environment variables as the assistant service
    const endpoint = getEnv('MICROSOFT_AZURE_OPENAI_ENDPOINT');
    const apiKey = getEnv('MICROSOFT_AZURE_OPENAI_API_KEY');
    const deployment = getEnv('MICROSOFT_AZURE_OPENAI_IMAGES_DEPLOYMENT') || 'dall-e-3';
    const apiVersion = getEnv('MICROSOFT_AZURE_OPENAI_API_VERSION') || '2024-08-01-preview';

    if (!endpoint || !apiKey || !deployment) {
      const missing = [];
      if (!endpoint) missing.push('MICROSOFT_AZURE_OPENAI_ENDPOINT');
      if (!apiKey) missing.push('MICROSOFT_AZURE_OPENAI_API_KEY');
      if (!deployment) missing.push('MICROSOFT_AZURE_OPENAI_IMAGES_DEPLOYMENT');
      throw new Error(`Azure OpenAI image generation is not configured. Missing: ${missing.join(', ')}`);
    }

    // Map aspect ratio to Azure DALL-E 3 size parameters
    let azureSize = size || '1024x1024';
    if (ratio) {
      switch (ratio) {
        case '1:1':
          azureSize = '1024x1024';
          break;
        case '16:9':
          azureSize = '1792x1024';
          break;
        case '9:16':
          azureSize = '1024x1792';
          break;
        case '4:3':
          azureSize = '1024x1024'; // Azure doesn't have exact 4:3, use square
          break;
        case '3:4':
          azureSize = '1024x1024'; // Azure doesn't have exact 3:4, use square
          break;
        case '3:2':
          azureSize = '1024x1024'; // Azure doesn't have exact 3:2, use square
          break;
        case '2:3':
          azureSize = '1024x1024'; // Azure doesn't have exact 2:3, use square
          break;
        default:
          azureSize = '1024x1024';
      }
    }

  const url = `${endpoint.replace(/\/$/, '')}/openai/images/generations?api-version=${encodeURIComponent(apiVersion)}`;
  
  console.log(`[Azure] Using deployment: ${deployment}`);
  console.log(`[Azure] API version: ${apiVersion}`);
  console.log(`[Azure] Prompt: ${prompt.substring(0, 100)}...`);
  console.log(`[Azure] Size: ${azureSize} (ratio: ${ratio || 'default'})`);
  
  // Azure DALL-E doesn't support reference images natively
  if (reference_images && reference_images.length > 0) {
    console.warn(`[Azure] Reference images provided but Azure DALL-E doesn't support them. Continuing without reference images.`);
  }
  
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      model: deployment,
      prompt,
      size: azureSize,
      n: n || 1,
      quality,
    }),
    signal: AbortSignal.timeout(30000), // 30 second timeout
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 404) {
      throw new Error('Azure OpenAI deployment not found. Please check your deployment configuration.');
    } else if (resp.status === 401) {
      throw new Error('Azure OpenAI authentication failed. Please check your API key.');
    } else {
      throw new Error(`Azure image generation failed: ${resp.status} ${text}`);
    }
  }

  const data = await resp.json();
  
  // Process images and upload to storage
  const images = [];
  for (const item of data?.data || []) {
    try {
      // Download image from Azure URL
      const imageResp = await fetch(item.url);
      if (!imageResp.ok) continue;
      
      const imageBuffer = await imageResp.arrayBuffer();
      const base64Data = Buffer.from(imageBuffer).toString('base64');
      const mimeType = imageResp.headers.get('content-type') || 'image/png';
      
      // Upload to Supabase Storage
      const uploadResult = await uploadImageToStorage(
        base64Data,
        mimeType,
        siteId,
        'azure',
        prompt
      );
      
      // Save file record to database (with fallback)
      try {
        await saveFileRecord(
          siteId,
          uploadResult.path,
          uploadResult.url,
          uploadResult.size,
          uploadResult.mimeType,
          'azure',
          prompt,
          deployment
        );
        console.log('[Azure] File record saved successfully');
      } catch (dbError: any) {
        console.warn('[Azure] Database save failed, but continuing with image generation:', dbError.message);
        // Continue even if database save fails
      }
      
      images.push({
        url: uploadResult.url,
        b64_json: null
      });
      
    } catch (uploadError: any) {
      console.error('[Azure] Storage upload error:', uploadError);
      // Continue with other images even if one fails
    }
  }
  
  return { provider: 'azure', images };
  
  } catch (error: any) {
    console.error('[Azure] Image generation error:', error);
    
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      throw new Error('Azure API request timed out. Please try again.');
    } else if (error.message?.includes('fetch failed') || error.message?.includes('ConnectTimeoutError')) {
      throw new Error('Azure API connection failed. Please check your network connection.');
    } else if (error.message?.includes('404')) {
      throw new Error('Azure OpenAI deployment not found. Please check your deployment configuration.');
    } else {
      throw new Error(`Azure image generation failed: ${error.message || error}`);
    }
  }
}

async function generateWithGemini(prompt: string, siteId: string, size?: string, n?: number, ratio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3', quality?: 'standard' | 'hd' | number, reference_images?: string[]) {
  const apiKey = getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_CLOUD_API_KEY');
  const model = getEnv('GOOGLE_CLOUD_IMAGES_MODEL') || 'gemini-2.5-flash-image';

  if (!apiKey) {
    throw new Error('Gemini API key is not configured. Set GEMINI_API_KEY or GOOGLE_CLOUD_API_KEY environment variable.');
  }

  try {
    // Map aspect ratio to specific dimensions and prompt instructions
    let finalPrompt = prompt;
    let targetDimensions = '';
    
    if (ratio) {
      // Calculate quality-based size multiplier
      const qualityMultiplier = quality === 'hd' ? 1.5 : 1.0;
      const qualityValue = typeof quality === 'number' ? Math.min(Math.max(quality / 100, 0.5), 2.0) : qualityMultiplier;
      
      const ratioConfig = {
        '1:1': { 
          description: 'square format (1:1 aspect ratio)',
          baseDimensions: '1024x1024',
          maxDimensions: '2048x2048',
          instruction: 'Create a square image with equal width and height'
        },
        '16:9': { 
          description: 'wide panoramic format (16:9 aspect ratio)',
          baseDimensions: '1792x1024',
          maxDimensions: '2688x1536',
          instruction: 'Create a wide panoramic image with 16:9 aspect ratio, landscape orientation'
        },
        '9:16': { 
          description: 'vertical mobile format (9:16 aspect ratio)',
          baseDimensions: '1024x1792',
          maxDimensions: '1536x2688',
          instruction: 'Create a vertical mobile image with 9:16 aspect ratio, portrait orientation'
        },
        '4:3': { 
          description: 'traditional format (4:3 aspect ratio)',
          baseDimensions: '1366x1024',
          maxDimensions: '2048x1536',
          instruction: 'Create a traditional 4:3 aspect ratio image, landscape orientation'
        },
        '3:4': { 
          description: 'vertical traditional format (3:4 aspect ratio)',
          baseDimensions: '1024x1366',
          maxDimensions: '1536x2048',
          instruction: 'Create a vertical traditional 3:4 aspect ratio image, portrait orientation'
        },
        '3:2': { 
          description: 'photographic format (3:2 aspect ratio)',
          baseDimensions: '1536x1024',
          maxDimensions: '2304x1536',
          instruction: 'Create a photographic 3:2 aspect ratio image, landscape orientation'
        },
        '2:3': { 
          description: 'vertical photographic format (2:3 aspect ratio)',
          baseDimensions: '1024x1536',
          maxDimensions: '1536x2304',
          instruction: 'Create a vertical photographic 2:3 aspect ratio image, portrait orientation'
        }
      };
      
      const config = ratioConfig[ratio];
      if (config) {
        // Calculate dynamic dimensions based on quality
        const [baseWidth, baseHeight] = config.baseDimensions.split('x').map(Number);
        const [maxWidth, maxHeight] = config.maxDimensions.split('x').map(Number);
        
        const width = Math.round(baseWidth + (maxWidth - baseWidth) * (qualityValue - 1));
        const height = Math.round(baseHeight + (maxHeight - baseHeight) * (qualityValue - 1));
        
        targetDimensions = `${width}x${height}`;
        finalPrompt = `${prompt}. ${config.instruction}. The image should be ${config.description}.`;
        
        console.log(`[Gemini] Quality: ${quality}, Multiplier: ${qualityValue.toFixed(2)}`);
        console.log(`[Gemini] Target dimensions: ${targetDimensions} for ratio: ${ratio}`);
      }
    }

    console.log(`[Gemini] Using model: ${model}`);
    console.log(`[Gemini] Prompt: ${prompt.substring(0, 100)}...`);
    console.log(`[Gemini] Aspect ratio: ${ratio || 'default'}`);
    if (targetDimensions) {
      console.log(`[Gemini] Target dimensions: ${targetDimensions}`);
    }
    
    // Initialize the Google Generative AI SDK with correct API
    const ai = new GoogleGenAI({
      apiKey: apiKey
    });
    
    // Generate image using the model with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    
    // Log aspect ratio information
    if (ratio) {
      console.log(`[Gemini] Using native aspect ratio: ${ratio}`);
    }

    // Use the correct Gemini API for image generation with proper config
    const config = {
      responseModalities: ['IMAGE'],
      imageConfig: ratio ? {
        aspectRatio: ratio
      } : undefined
    };
    
    // Process reference images if provided
    const parts: any[] = [
      {
        text: finalPrompt
      }
    ];

    if (reference_images && reference_images.length > 0) {
      console.log(`[Gemini] Processing ${reference_images.length} reference images...`);
      
      for (const refUrl of reference_images) {
        try {
          const base64Data = await convertUrlToBase64(refUrl);
          if (base64Data) {
            parts.push({
              inlineData: {
                mimeType: base64Data.mimeType,
                data: base64Data.data
              }
            });
            console.log(`[Gemini] Added reference image: ${base64Data.mimeType}`);
          } else {
            console.warn(`[Gemini] Failed to convert reference image: ${refUrl}`);
          }
        } catch (error: any) {
          console.warn(`[Gemini] Error processing reference image ${refUrl}: ${error.message}`);
        }
      }
    }

    const contents = [
      {
        role: 'user',
        parts
      }
    ];

    const response = await ai.models.generateContentStream({
      model,
      config,
      contents
    });
    
    clearTimeout(timeoutId);

    console.log(`[Gemini] Processing streaming response...`);

    // Extract images from streaming response and upload to storage
    const images = [];
    let fileIndex = 0;
    
    for await (const chunk of response) {
      if (!chunk.candidates || !chunk.candidates[0].content || !chunk.candidates[0].content.parts) {
        continue;
      }
      
      if (chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        try {
          const inlineData = chunk.candidates[0].content.parts[0].inlineData;
          const mimeType = inlineData.mimeType || 'image/png';
          
          // Upload to Supabase Storage
          const uploadResult = await uploadImageToStorage(
            inlineData.data || '',
            mimeType,
            siteId,
            'gemini',
            prompt
          );
          
          // Save file record to database (with fallback)
          try {
            await saveFileRecord(
              siteId,
              uploadResult.path,
              uploadResult.url,
              uploadResult.size,
              uploadResult.mimeType,
              'gemini',
              prompt,
              model
            );
            console.log('[Gemini] File record saved successfully');
          } catch (dbError: any) {
            console.warn('[Gemini] Database save failed, but continuing with image generation:', dbError.message);
            // Continue even if database save fails
          }
          
          images.push({
            url: uploadResult.url,
            b64_json: null // No longer return base64
          });
          
          fileIndex++;
          
        } catch (uploadError: any) {
          console.error('[Gemini] Storage upload error:', uploadError);
          // Continue with other images even if one fails
        }
      } else {
        // Handle text responses if any
        console.log('[Gemini] Text response:', chunk.text);
      }
    }

    if (images.length === 0) {
      throw new Error('No images generated by Gemini model. The model may not have returned image data.');
    }

    return { provider: 'gemini', images };
    
  } catch (error: any) {
    console.error('[Gemini] Image generation error:', error);
    
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      throw new Error('Gemini API request timed out. Please try again.');
    } else if (error.message?.includes('fetch failed')) {
      throw new Error('Gemini API connection failed. Please check your network connection.');
    } else if (error.message?.includes('404') || error.message?.includes('NOT_FOUND')) {
      throw new Error('Gemini model not found. Please check your model configuration.');
    } else {
      throw new Error(`Gemini image generation failed: ${error.message || error}`);
    }
  }
}

async function generateWithVercelGateway(prompt: string, siteId: string, size?: string, n?: number, ratio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3', reference_images?: string[]) {
  const baseURL = getEnv('VERCEL_AI_GATEWAY_OPENAI');
  const apiKey = getEnv('VERCEL_AI_GATEWAY_API_KEY');

  if (!baseURL || !apiKey) {
    throw new Error('Vercel AI Gateway is not configured');
  }

  // Map aspect ratio to Vercel Gateway size parameters (similar to Azure)
  let vercelSize = size || '1024x1024';
  if (ratio) {
    switch (ratio) {
      case '1:1':
        vercelSize = '1024x1024';
        break;
      case '16:9':
        vercelSize = '1792x1024';
        break;
      case '9:16':
        vercelSize = '1024x1792';
        break;
      case '4:3':
        vercelSize = '1024x1024'; // Vercel doesn't have exact 4:3, use square
        break;
      case '3:4':
        vercelSize = '1024x1024'; // Vercel doesn't have exact 3:4, use square
        break;
      case '3:2':
        vercelSize = '1024x1024'; // Vercel doesn't have exact 3:2, use square
        break;
      case '2:3':
        vercelSize = '1024x1024'; // Vercel doesn't have exact 2:3, use square
        break;
      default:
        vercelSize = '1024x1024';
    }
  }

  console.log(`[Vercel] Size: ${vercelSize} (ratio: ${ratio || 'default'})`);
  
  // Vercel Gateway doesn't support reference images natively
  if (reference_images && reference_images.length > 0) {
    console.warn(`[Vercel] Reference images provided but Vercel Gateway doesn't support them. Continuing without reference images.`);
  }

  const resp = await fetch(`${baseURL.replace(/\/$/, '')}/v1/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: vercelSize,
      n: n || 1,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Vercel Gateway image generation failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  
  // Process images and upload to storage
  const images = [];
  for (const item of data?.data || []) {
    try {
      // Download image from Vercel URL
      const imageResp = await fetch(item.url);
      if (!imageResp.ok) continue;
      
      const imageBuffer = await imageResp.arrayBuffer();
      const base64Data = Buffer.from(imageBuffer).toString('base64');
      const mimeType = imageResp.headers.get('content-type') || 'image/png';
      
      // Upload to Supabase Storage
      const uploadResult = await uploadImageToStorage(
        base64Data,
        mimeType,
        siteId,
        'vercel',
        prompt
      );
      
      // Save file record to database (with fallback)
      try {
        await saveFileRecord(
          siteId,
          uploadResult.path,
          uploadResult.url,
          uploadResult.size,
          uploadResult.mimeType,
          'vercel',
          prompt,
          'gpt-image-1'
        );
        console.log('[Vercel] File record saved successfully');
      } catch (dbError: any) {
        console.warn('[Vercel] Database save failed, but continuing with image generation:', dbError.message);
        // Continue even if database save fails
      }
      
      images.push({
        url: uploadResult.url,
        b64_json: null
      });
      
    } catch (uploadError: any) {
      console.error('[Vercel] Storage upload error:', uploadError);
      // Continue with other images even if one fails
    }
  }
  
  return { provider: 'vercel', images };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ImageRequestBody;
    const { prompt, site_id, provider = 'gemini', size, n, quality, ratio, reference_images } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Parameter "prompt" is required' }, { status: 400 });
    }

    if (!site_id || typeof site_id !== 'string') {
      return NextResponse.json({ error: 'Parameter "site_id" is required' }, { status: 400 });
    }

    // Validate site_id is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(site_id)) {
      return NextResponse.json({ error: 'Parameter "site_id" must be a valid UUID' }, { status: 400 });
    }

    // Validate reference_images if provided
    if (reference_images !== undefined) {
      if (!Array.isArray(reference_images)) {
        return NextResponse.json({ error: 'Parameter "reference_images" must be an array of URLs' }, { status: 400 });
      }
      
      // Validate each URL
      const urlRegex = /^https?:\/\/.+/i;
      for (const url of reference_images) {
        if (typeof url !== 'string' || !urlRegex.test(url)) {
          return NextResponse.json({ error: 'All reference_images must be valid HTTP/HTTPS URLs' }, { status: 400 });
        }
      }
    }

    if (provider === 'azure') {
      try {
        const result = await generateWithAzure(prompt, site_id, size, n, quality, ratio, reference_images);
        return NextResponse.json(result);
      } catch (err) {
        console.warn('[image api] Azure provider failed, trying Vercel fallback...', err);
        const fallback = await generateWithVercelGateway(prompt, site_id, size, n, ratio, reference_images);
        return NextResponse.json({ ...fallback, fallbackFrom: 'azure' });
      }
    }

    if (provider === 'gemini') {
      try {
        const result = await generateWithGemini(prompt, site_id, size, n, ratio, quality, reference_images);
        return NextResponse.json(result);
      } catch (err) {
        console.warn('[image api] Gemini provider failed, trying Azure fallback...', err);
        try {
          const fallback = await generateWithAzure(prompt, site_id, size, n, quality, ratio, reference_images);
          return NextResponse.json({ ...fallback, fallbackFrom: 'gemini' });
        } catch (fallbackErr: any) {
          console.error('[image api] Azure fallback also failed:', fallbackErr);
          throw new Error(`Both Gemini and Azure providers failed. Gemini: ${err instanceof Error ? err.message : String(err)}. Azure: ${fallbackErr.message || fallbackErr}`);
        }
      }
    }

    if (provider === 'vercel') {
      const result = await generateWithVercelGateway(prompt, site_id, size, n, ratio, reference_images);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: `Unsupported provider: ${provider}` }, { status: 400 });
  } catch (error: any) {
    console.error('[image api] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to process request' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Image Generation API',
    usage: {
      method: 'POST',
      body: {
        prompt: 'string (required)',
        site_id: 'string (required) - UUID of the site',
        provider: "'azure' | 'gemini' | 'vercel' (default: 'azure')",
        size: "'256x256' | '512x512' | '1024x1024'",
        n: 'number',
        quality: "'standard' | 'hd'",
      },
    },
    providers: ['azure', 'gemini', 'vercel'],
    env: {
      requiredForAzure: ['MICROSOFT_AZURE_OPENAI_ENDPOINT', 'MICROSOFT_AZURE_OPENAI_API_KEY', 'MICROSOFT_AZURE_OPENAI_IMAGES_DEPLOYMENT'],
      requiredForVercelFallback: ['VERCEL_AI_GATEWAY_OPENAI', 'VERCEL_AI_GATEWAY_API_KEY'],
      requiredForGemini: ['GEMINI_API_KEY (or GOOGLE_CLOUD_API_KEY)'],
      optionalForGemini: ['GOOGLE_CLOUD_IMAGES_MODEL (default: gemini-2.5-flash-image)'],
    },
    notes: {
      gemini: 'Uses @google/genai SDK with simple API key authentication. Get your API key from https://aistudio.google.com',
      models: 'Available models: gemini-2.5-flash-image (default), or set custom model via GOOGLE_CLOUD_IMAGES_MODEL',
      storage: 'Images are automatically saved to Supabase Storage bucket "generative_images" and file records are created in the "files" table',
      urls: 'Response contains public URLs instead of base64 data. Images are organized by site_id in Storage.',
    },
  });
}


