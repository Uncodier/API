import { probeAzureText, probeGeminiText, probePortkeyProvider } from './src/lib/status/handlers/ai/provider-probes';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function run() {
  console.log('Testing Azure...');
  try {
    const az = await probeAzureText();
    console.log('Azure Result:', JSON.stringify(az, null, 2));
  } catch (e) {
    console.error('Azure Error:', e);
  }

  console.log('Testing Gemini...');
  try {
    const gem = await probeGeminiText();
    console.log('Gemini Result:', JSON.stringify(gem, null, 2));
  } catch (e) {
    console.error('Gemini Error:', e);
  }

  console.log('Testing Portkey (OpenAI)...');
  try {
    const pkO = await probePortkeyProvider('openai');
    console.log('Portkey OpenAI Result:', JSON.stringify(pkO, null, 2));
  } catch (e) {
    console.error('Portkey OpenAI Error:', e);
  }

  console.log('Testing Portkey (Gemini)...');
  try {
    const pkG = await probePortkeyProvider('gemini');
    console.log('Portkey Gemini Result:', JSON.stringify(pkG, null, 2));
  } catch (e) {
    console.error('Portkey Gemini Error:', e);
  }
}

run().catch(console.error);
