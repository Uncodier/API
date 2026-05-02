import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const REPO_URL = process.env.REPOSITORY_SUPABASE_URL;
  const REPO_KEY = process.env.REPOSITORY_SUPABASE_ANON_KEY;
  const BUCKET = process.env.SUPABASE_BUCKET || 'workspaces';

  const storagePath = `probe-screenshots/test-upload/step-1/test.png`;
  const url = `${REPO_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  
  const buffer = Buffer.from('test image content');
  
  console.log('Uploading to:', url);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPO_KEY}`,
        'apikey': REPO_KEY!,
        'Content-Type': 'image/png'
      },
      body: buffer
    });
    
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text);
  } catch (e) {
    console.error('Error:', e);
  }
}

main();