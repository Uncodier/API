import { createHash } from 'node:crypto';
import { readResponseWithLimit } from '../../security/limited-response';
import { TTSServiceError } from './azure-tts-config';
import { normalizeSpeechLanguage } from './speech-options';

const formats = {
  mp3: 'audio-24khz-96kbitrate-mono-mp3', pcm: 'raw-24khz-16bit-mono-pcm',
  wav: 'riff-24khz-16bit-mono-pcm', opus: 'ogg-24khz-16bit-mono-opus',
} as const;

interface Voice {
  locale: string;
  language: string;
  maximized: string;
  name: string;
  preview: boolean;
  gender: string;
  specialized: boolean;
}

function parseVoice(row: unknown): Voice | undefined {
  if (!row || typeof row !== 'object') return;
  const { Locale, ShortName, Gender, VoiceType, Status, SecondaryLocaleList } = row as Record<string, unknown>;
  if (VoiceType !== 'Neural' || (Status !== 'GA' && Status !== 'Preview') || typeof ShortName !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(ShortName)) return;
  let canonical;
  try { canonical = normalizeSpeechLanguage(Locale); } catch { return; }
  if (!canonical) return;
  const tag = new Intl.Locale(canonical);
  if (!tag.region) return;
  // Only the primary Locale is a claim about the voice's native accent.
  return { locale: tag.baseName, language: tag.language, maximized: tag.maximize().baseName, name: ShortName, preview: Status === 'Preview',
    gender: typeof Gender === 'string' ? Gender : '', specialized: /:|multilingual|multitalker|turbo|dragonhd/i.test(ShortName)
      || (Array.isArray(SecondaryLocaleList) && SecondaryLocaleList.length > 0) };
}

async function fetchCatalog(region: string, apiKey: string): Promise<Voice[]> {
  try {
    const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey }, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    const rows: unknown = JSON.parse((await readResponseWithLimit(response, 4 * 1024 * 1024)).toString('utf8'));
    if (!Array.isArray(rows) || rows.length > 8192) throw new Error();
    const voices = rows.map(parseVoice).filter((voice): voice is Voice => voice !== undefined);
    if (!voices.length) throw new Error();
    return voices;
  } catch {
    // Neither the upstream response body nor exception is safe to propagate.
    throw new TTSServiceError('Azure Speech voice catalog unavailable', 502);
  }
}

const catalogCache = new Map<string, { until: number; voices: Promise<Voice[]> }>();
function catalog(region: string, apiKey: string) {
  const key = region + ':' + createHash('sha256').update(apiKey).digest('hex');
  const now = Date.now();
  const cached = catalogCache.get(key);
  if (cached && now < cached.until) return cached.voices;
  catalogCache.delete(key);
  if (catalogCache.size >= 8) catalogCache.delete(catalogCache.keys().next().value!);
  const voices = fetchCatalog(region, apiKey).catch(error => {
    if (catalogCache.get(key)?.voices === voices) catalogCache.delete(key);
    throw error;
  });
  catalogCache.set(key, { until: now + 15 * 60_000, voices });
  return voices;
}

export async function selectRegionalSpeech(language: string, profile: string | undefined, format: string) {
  if (typeof window !== 'undefined') throw new TTSServiceError('Azure Speech is server-only', 503);
  const canonical = normalizeSpeechLanguage(language);
  if (!canonical) throw new TTSServiceError('Invalid Azure Speech locale', 400);
  const requested = new Intl.Locale(canonical);
  if (!Object.hasOwn(formats, format)) throw new TTSServiceError('Unsupported regional speech format', 400);
  const region = process.env.AZURE_SPEECH_REGION?.trim();
  const apiKey = process.env.AZURE_SPEECH_KEY?.trim();
  if (!region || !/^[a-z0-9]{2,40}$/.test(region) || !apiKey || !/^[!-~]{1,512}$/.test(apiKey)) {
    throw new TTSServiceError('Regional speech requires valid AZURE_SPEECH_REGION and AZURE_SPEECH_KEY', 503);
  }
  const target = requested.baseName === 'es' ? new Intl.Locale('es-MX') : requested;
  const likely = target.maximize().baseName;
  const gender = ['onyx', 'echo', 'fable'].includes(profile ?? '') ? 'Male' : 'Female';
  const mexicanDefault = gender === 'Male' ? 'es-MX-JorgeNeural' : 'es-MX-DaliaNeural';
  // Never relax a territory, script or variant supplied by the caller. Only a
  // bare language permits an alternate native locale if its likely one is absent.
  const bare = canonical === requested.language;
  const choices = (await catalog(region, apiKey)).filter(v => v.maximized === likely || (bare && v.language === canonical));
  choices.sort((a, b) => Number(b.maximized === likely) - Number(a.maximized === likely)
    || Number(a.preview) - Number(b.preview)
    || Number(b.locale === target.baseName) - Number(a.locale === target.baseName)
    || Number(a.specialized) - Number(b.specialized)
    || Number(b.gender === gender) - Number(a.gender === gender)
    || Number(b.name === mexicanDefault) - Number(a.name === mexicanDefault)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const best = choices[0];
  if (!best) throw new TTSServiceError('No regional Azure Speech voice for the requested locale', 400);
  return { locale: best.locale, voice: best.name, region, apiKey, format: formats[format as keyof typeof formats] };
}

export function regionalSpeechRequest(selected: Awaited<ReturnType<typeof selectRegionalSpeech>>, text: string, speed?: number) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const content = speed === undefined ? escaped : `<prosody rate="${speed * 100}%">${escaped}</prosody>`;
  return {
    url: new URL(`https://${selected.region}.tts.speech.microsoft.com/cognitiveservices/v1`),
    headers: { 'Ocp-Apim-Subscription-Key': selected.apiKey, 'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': selected.format, 'User-Agent': 'Gear' },
    body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${selected.locale}"><voice name="${selected.voice}">${content}</voice></speak>`,
  };
}