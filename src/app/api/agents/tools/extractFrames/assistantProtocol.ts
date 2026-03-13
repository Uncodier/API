import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { CreditService } from '@/lib/services/billing/CreditService';

export interface ExtractFramesToolParams {
  video_url: string;
  frame_count?: number;
}

export function extractFramesTool(site_id?: string) {
  return {
    name: 'extract_frames',
    description: 'Extracts frames (images) from a video or GIF URL. Returns an array of base64 images that can be analyzed or stored. Useful for visually understanding a video.',
    parameters: {
      type: 'object',
      properties: {
        video_url: {
          type: 'string',
          description: 'The valid public URL of the video or GIF to extract frames from.'
        },
        frame_count: {
          type: 'number',
          description: 'Number of frames to extract evenly spaced across the video (default 5, max 10).'
        }
      },
      required: ['video_url']
    },
    execute: async (args: ExtractFramesToolParams) => {
      const frameCount = Math.min(Math.max(args.frame_count || 5, 1), 10); // cap between 1 and 10
      const tmpDir = os.tmpdir();
      const sessionId = uuidv4();
      let tmpVideoFile = '';
      let outFolder = '';
      
      try {
        if (site_id) {
          const requiredCredits = CreditService.PRICING.FRAME_EXTRACTION * frameCount;
          const hasCredits = await CreditService.validateCredits(site_id, requiredCredits);
          if (!hasCredits) {
            throw new Error(`Insufficient credits for extracting ${frameCount} frames`);
          }
          await CreditService.deductCredits(site_id, requiredCredits, 'frame_extraction', `Video frame extraction (${frameCount} frames)`, { video_url: args.video_url });
        }
        
        // We'll keep the extension or default to .mp4
        let ext = '.mp4';
        try {
          const urlObj = new URL(args.video_url);
          ext = path.extname(urlObj.pathname) || '.mp4';
        } catch (e) {
          // Ignored
        }
        
        tmpVideoFile = path.join(tmpDir, `${sessionId}${ext}`);
        outFolder = path.join(tmpDir, sessionId);

        console.log(`[ExtractFramesTool] Extracting ${frameCount} frames from: ${args.video_url}`);
        
        // 1. Fetch the video/gif
        const response = await fetch(args.video_url);
        if (!response.ok) {
          throw new Error(`Failed to fetch video: ${response.statusText}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Save temporary video file
        fs.writeFileSync(tmpVideoFile, buffer);
        
        // Output folder
        if (!fs.existsSync(outFolder)) {
          fs.mkdirSync(outFolder);
        }
        
        console.log(`[ExtractFramesTool] Video saved to ${tmpVideoFile}, processing with ffmpeg...`);
        
        // Lazy load ffmpeg to avoid initialization errors in serverless environments
        // We use eval('require') to prevent Webpack from hoisting the require to the top level,
        // which causes the whole workflow route to crash at startup if the binary is missing.
        const req = eval('require');
        const ffmpeg = req('fluent-ffmpeg');
        const ffmpegInstaller = req('@ffmpeg-installer/ffmpeg');
        const ffprobeInstaller = req('@ffprobe-installer/ffprobe');
        
        // Set paths to binaries
        ffmpeg.setFfmpegPath(ffmpegInstaller.path);
        ffmpeg.setFfprobePath(ffprobeInstaller.path);
        
        // 2. Run ffmpeg to extract screenshots
        await new Promise<void>((resolve, reject) => {
          ffmpeg(tmpVideoFile)
            .screenshots({
              count: frameCount,
              folder: outFolder,
              filename: 'frame-%i.jpg',
              size: '640x?' // Scale width to 640px to reduce payload size, maintaining aspect ratio
            })
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
        });
        
        // 3. Read the extracted frames
        const files = fs.readdirSync(outFolder).sort(); // Keep order
        const base64Frames: string[] = [];
        
        for (const file of files) {
          if (!file.endsWith('.jpg')) continue;
          
          const filePath = path.join(outFolder, file);
          const fileData = fs.readFileSync(filePath);
          const base64 = `data:image/jpeg;base64,${fileData.toString('base64')}`;
          base64Frames.push(base64);
          
          // Clean up frame right after reading
          try {
            fs.unlinkSync(filePath);
          } catch (e) {}
        }
        
        console.log(`[ExtractFramesTool] Successfully extracted ${base64Frames.length} frames.`);
        
        return {
          success: true,
          count: base64Frames.length,
          frames: base64Frames
        };
      } catch (error: any) {
        console.error(`[ExtractFramesTool] Error:`, error);
        return {
          success: false,
          error: error.message || 'Unknown error occurred during frame extraction'
        };
      } finally {
        // 4. Global cleanup
        try {
          if (fs.existsSync(tmpVideoFile)) fs.unlinkSync(tmpVideoFile);
          if (fs.existsSync(outFolder)) fs.rmdirSync(outFolder, { recursive: true });
        } catch (e) {
          console.error(`[ExtractFramesTool] Cleanup error:`, e);
        }
      }
    }
  };
}
