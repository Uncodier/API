import { randomBytes } from 'node:crypto';
import { selectRegionalSpeech, regionalSpeechRequest } from '../azure-regional-speech';
import { TTSServiceError } from '../azure-tts-config';

const voice = (Locale: string, name: string, Gender = 'Female') => ({
  Locale, ShortName: `${Locale}-${name}Neural`, Gender, VoiceType: 'Neural', Status: 'GA',
});
const rows = (data: unknown) => new Response(JSON.stringify(data));
const select = (language: string, profile?: string) => selectRegionalSpeech(language, profile, 'mp3');

describe('regional Azure Speech resolver', () => {
  let network: jest.SpyInstance;
  const env = process.env;
  beforeEach(() => {
    process.env = { NODE_ENV: 'test', AZURE_SPEECH_REGION: 'eastus', AZURE_SPEECH_KEY: randomBytes(24).toString('hex') };
    network = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
  });
  afterEach(() => { process.env = env; jest.restoreAllMocks(); });

  it('honors region, script, variants and canonical aliases without crossing dialects', async () => {
    network.mockResolvedValue(rows([
      voice('zh-CN', 'Xiaoxiao'), { ...voice('zh-CN-liaoning', 'Xiaobei'), Status: 'Preview' }, voice('sr-Latn-RS', 'Sophie'),
      voice('iu-Cans-CA', 'Siqiniq'), voice('he-IL', 'Hila'),
    ]));
    await expect(select('ZH-cn-LIAONING')).resolves.toMatchObject({ locale: 'zh-CN-liaoning', voice: 'zh-CN-liaoning-XiaobeiNeural' });
    await expect(select('zh-Hans-CN')).resolves.toMatchObject({ locale: 'zh-CN' });
    await expect(select('iu-Cans')).resolves.toMatchObject({ locale: 'iu-Cans-CA' });
    await expect(select('iw-IL')).resolves.toMatchObject({ locale: 'he-IL' });
    for (const tag of ['zh-TW', 'zh-Hant-CN', 'zh-CN-henan', 'sr-Cyrl-RS', 'iu-Latn-CA']) {
      await expect(select(tag)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('uses likely native locale for bare language, alternate native locale only for bare language', async () => {
    network.mockResolvedValue(rows([voice('pt-PT', 'Ana'), voice('pt-BR', 'Vera'), voice('fr-CA', 'Sylvie')]));
    await expect(select('pt')).resolves.toMatchObject({ locale: 'pt-BR' });
    await expect(select('fr')).resolves.toMatchObject({ locale: 'fr-CA' });
    await expect(select('fr-FR')).rejects.toMatchObject({ status: 400 });
  });

  it('keeps the Mexican Spanish default voices when available', async () => {
    network.mockResolvedValue(rows([voice('es-ES', 'Elvira'), voice('es-MX', 'Alba'), voice('es-MX', 'Dalia'),
      voice('es-MX', 'Andres', 'Male'), voice('es-MX', 'Jorge', 'Male')]));
    await expect(select('es', 'nova')).resolves.toMatchObject({ locale: 'es-MX', voice: 'es-MX-DaliaNeural' });
    await expect(select('es', 'onyx')).resolves.toMatchObject({ voice: 'es-MX-JorgeNeural' });
    await expect(select('es-es')).resolves.toMatchObject({ locale: 'es-ES' });
  });

  it.each([false, true])('prefers stable GA native neural voices regardless of catalog order (reverse=%s)', async reverse => {
    const catalog = [voice('fr-CA', 'Zoe'), voice('fr-CA', 'Claire'), voice('fr-CA', 'Adam', 'Male'),
      voice('fr-CA', 'AlphaMultilingual'), voice('fr-CA', 'Alpha:DragonHDLatest'),
      { ...voice('fr-CA', 'Alpha'), Status: 'Preview' }, { ...voice('fr-CA', 'Beta'), VoiceType: 'Standard' },
      { ...voice('de-DE', 'Clara'), Status: 'Deprecated' },
      { ...voice('fr-CA', 'Alpha'), ShortName: 'bad"><break/>' },
      { ...voice('en-US', 'AvaMultilingual'), SecondaryLocaleList: ['de-DE'] }];
    network.mockResolvedValue(rows(reverse ? catalog.reverse() : catalog));
    await expect(select('fr-CA')).resolves.toMatchObject({ voice: 'fr-CA-ClaireNeural' });
    await expect(select('fr-CA', 'fable')).resolves.toMatchObject({ voice: 'fr-CA-AdamNeural' });
    await expect(select('de-DE')).rejects.toMatchObject({ status: 400 });
  });

  it('coalesces concurrent lookups, scopes cache to region and credential, and refreshes on expiry', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(100);
    network.mockImplementation(async () => rows([voice('fr-CA', 'Sylvie')]));
    const [selected] = await Promise.all([select('fr-CA'), select('fr-CA')]);
    expect(network).toHaveBeenCalledTimes(1);
    const discovery = new Request(...network.mock.calls[0] as [RequestInfo, RequestInit]);
    expect(discovery.url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list');
    expect(discovery.method).toBe('GET');
    expect(discovery.redirect).toBe('error');
    expect(discovery.cache).toBe('no-store');
    expect(discovery.headers.get('Ocp-Apim-Subscription-Key')).toBe(process.env.AZURE_SPEECH_KEY);
    const request = regionalSpeechRequest(selected, 'A <say-as/> & B', 1.25);
    expect(request.url.href).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(request.headers['X-Microsoft-OutputFormat']).toBe('audio-24khz-96kbitrate-mono-mp3');
    expect(request.body).toContain('xml:lang="fr-CA"><voice name="fr-CA-SylvieNeural"><prosody rate="125%">A &lt;say-as/&gt; &amp; B');
    expect(request.body).not.toContain(process.env.AZURE_SPEECH_KEY);
    process.env.AZURE_SPEECH_REGION = 'westus';
    await select('fr-CA');
    process.env.AZURE_SPEECH_KEY = randomBytes(24).toString('hex');
    await select('fr-CA');
    clock.mockReturnValue(100 + 24 * 60 * 60_000);
    await select('fr-CA');
    expect(network).toHaveBeenCalledTimes(4);
  });

  it('bounds the number of cached catalogs even when credentials rotate frequently', async () => {
    network.mockImplementation(async () => rows([voice('de-DE', 'Katja')]));
    const first = process.env.AZURE_SPEECH_KEY!;
    await select('de-DE');
    for (let i = 0; i < 8; i++) {
      process.env.AZURE_SPEECH_KEY = randomBytes(24).toString('hex');
      await select('de-DE');
    }
    process.env.AZURE_SPEECH_KEY = first;
    await select('de-DE');
    expect(network).toHaveBeenCalledTimes(10);
  });

  it.each([['wav', 'riff-24khz-16bit-mono-pcm'], ['opus', 'ogg-24khz-16bit-mono-opus'],
    ['pcm', 'raw-24khz-16bit-mono-pcm']])('requests the native %s encoding', async (format, expected) => {
    network.mockResolvedValue(rows([voice('de-DE', 'Katja')]));
    const selected = await selectRegionalSpeech('de-DE', undefined, format);
    expect(regionalSpeechRequest(selected, 'Hallo').headers['X-Microsoft-OutputFormat']).toBe(expected);
  });

  it('sanitizes upstream exceptions, rejects malformed/oversize catalogs and never caches failures', async () => {
    const sensitive = process.env.AZURE_SPEECH_KEY!;
    network.mockRejectedValueOnce(new Error(sensitive)).mockResolvedValueOnce(new Response(sensitive, { status: 401 }))
      .mockResolvedValueOnce(new Response(sensitive)).mockResolvedValueOnce(rows({ message: sensitive }))
      .mockResolvedValueOnce(new Response('[]', { headers: { 'Content-Length': String(16 * 1024 * 1024) } }))
      .mockResolvedValueOnce(rows([voice('fr-CA', 'Sylvie')]));
    for (let i = 0; i < 5; i++) {
      const error = await select('fr-CA').catch(e => e);
      expect(error).toBeInstanceOf(TTSServiceError);
      expect(error.status).toBe(502);
      expect(error.message).not.toContain(sensitive);
    }
    await expect(select('fr-CA')).resolves.toMatchObject({ locale: 'fr-CA' });
    expect(network).toHaveBeenCalledTimes(6);
  });

  it('rejects invalid inputs or configuration before issuing authenticated requests', async () => {
    for (const tag of ['en-US-x-other', 'fr-u-ca-gregory', 'und', 'auto', 'bad_tag']) {
      await expect(select(tag)).rejects.toMatchObject({ status: 400 });
    }
    for (const format of ['aac', '__proto__']) {
      await expect(selectRegionalSpeech('fr-CA', 'nova', format)).rejects.toMatchObject({ status: 400 });
    }
    process.env.AZURE_SPEECH_REGION = 'example.invalid/';
    await expect(select('fr-CA')).rejects.toMatchObject({ status: 503 });
    process.env.AZURE_SPEECH_REGION = 'eastus';
    delete process.env.AZURE_SPEECH_KEY;
    await expect(select('fr-CA')).rejects.toMatchObject({ status: 503 });
    expect(network).not.toHaveBeenCalled();
  });
});