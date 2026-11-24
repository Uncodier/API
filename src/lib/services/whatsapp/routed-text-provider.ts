import { createHash } from 'node:crypto';
import { getSiteLicensedResources } from '@/lib/billing/licensed-resources';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { exactWhatsAppConfig } from '@/lib/messaging/exact-whatsapp';
import { isAcceptedZavuMessage } from '@/lib/messaging/exact-zavu-response';
import { sendChannelMessage, ZavuWhatsAppChannelNotConnected } from '@/lib/services/zavu/client';
import { createZavuTemplate, getZavuTemplate, sendZavuTemplate, submitZavuTemplate, type ZavuTemplate } from '@/lib/services/zavu/templates';
import { textRoutes } from './routed-text-policy';
import { loadSiteTemplateLanguage } from './template-language';
import { sendTwilioWhatsAppMessage } from './twilio-whatsapp-transport';
import { isTerminalWhatsAppApprovalStatus } from './whatsappTemplateApproval';

export type TextRoute = { connectionId: string; provider: 'twilio' | 'zavu'; sender: string };
export type TextTemplate = { id: string; name?: string; language?: string };
export type RoutedTextResult =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'pending'; template: TextTemplate }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'unknown'; reason: string };

type Input = {
  siteId: string; messageId: string; conversationId: string; recipient: string; text: string;
  route: TextRoute; template?: TextTemplate; forceTemplate: boolean; verifyBinding: () => Promise<void>;
};
type StopResult = Exclude<RoutedTextResult, { kind: 'accepted' }>;
type TwilioConfig = NonNullable<Awaited<ReturnType<typeof exactWhatsAppConfig>>>;
const TIMEOUT_MS = 30_000;
const failed = (reason: string) => ({ kind: 'failed', reason } as const);
const unavailable = (reason: string) => ({ kind: 'unavailable', reason } as const);
const unknown = (reason: string) => ({ kind: 'unknown', reason } as const);
const pending = (template: TextTemplate) => ({ kind: 'pending', template } as const);
const readFailure = (template?: TextTemplate) => template ? pending(template) : failed('WhatsApp preparation could not be verified.');
const mismatch = () => failed('WhatsApp template does not match the selected route, content or language.');
const rejected = () => failed('WhatsApp template approval was denied.');
const unconfirmed = () => unknown('WhatsApp message acceptance is unconfirmed; reconcile before retrying.');
const present = (s: unknown): s is string => typeof s === 'string' && !!s.trim();
const validId = (s: unknown): s is string => present(s) && s.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(s)
  && s !== 'unknown' && s !== '.' && s !== '..';
const statusOf = (e: unknown) => e && typeof e === 'object' && 'status' in e && typeof e.status === 'number' ? e.status : undefined;

// Only our own classified stops become results. Exceptions from verifyBinding
// (including suppression, lost ownership and lookup failures) escape unchanged.
class Stop extends Error { constructor(readonly result: StopResult) { super(result.kind); } }
function stop(result: StopResult): never { throw new Stop(result); }

// Bound individual I/O, never race the orchestration: a late read/guard must not
// resume a timed-out attempt and dispatch. The legacy Twilio transport has no
// abort parameter; timing out its single in-flight POST is *not* non-placement.
async function bounded<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('WhatsApp operation timed out')), TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}
async function io<T>(operation: () => PromiseLike<T>, onError: (error: unknown) => StopResult): Promise<T> {
  try { return await bounded(operation()); }
  catch (error) { return stop(onError(error)); }
}

function pollError(error: unknown, ref: TextTemplate): StopResult {
  return [400, 401, 403, 404, 410, 422].includes(statusOf(error) ?? 0)
    ? failed('The selected WhatsApp template could not be read.') : pending(ref);
}
function mutationError(error: unknown, operation: string): StopResult {
  // Generic request errors do not prove a sender-specific refusal. In
  // particular an undecodable idempotency conflict is ambiguous.
  return [400, 401, 403, 404, 413, 415, 422].includes(statusOf(error) ?? 0)
    ? failed(`WhatsApp ${operation} was rejected.`) : unknown(`WhatsApp ${operation} is unconfirmed; reconcile before retrying.`);
}
function zavuSendError(error: unknown): StopResult {
  return error instanceof ZavuWhatsAppChannelNotConnected
    ? unavailable('Zavu channel_not_connected: the selected WhatsApp sender is not connected.') : mutationError(error, 'send');
}
function acceptance(id: unknown, input: Input): RoutedTextResult {
  return validId(id) && id !== input.messageId ? { kind: 'accepted', providerMessageId: id } : unconfirmed();
}
function templateName(input: Input, language: string): string {
  const { route } = input;
  const hash = createHash('sha256').update(JSON.stringify([input.siteId, input.conversationId, input.messageId,
    route.provider, route.connectionId, route.sender, input.recipient, input.text, language])).digest('hex');
  return `routed_reply_${hash.slice(0, 40)}`;
}

async function liveChannels(input: Input) {
  const { channels, routes } = await io(async () => {
    const { channels } = await getSiteLicensedResources(input.siteId);
    return { channels, routes: textRoutes(channels) };
  }, () => readFailure(input.template));
  const live = routes.find(r => r.connectionId === input.route.connectionId);
  if (!live) stop(unavailable('The selected WhatsApp connection is not active or licensed.'));
  if (live.provider !== input.route.provider || live.sender !== input.route.sender) stop(failed('The selected WhatsApp sender changed.'));
  return channels;
}
async function admitZavu(input: Input) {
  await liveChannels(input);
  if (!process.env.ZAVUDEV_API_KEY?.trim()) stop(unavailable('Selected WhatsApp provider credentials are missing.'));
  await bounded(input.verifyBinding());
}
async function admitTwilio(input: Input): Promise<TwilioConfig> {
  const channels = await liveChannels(input);
  const key = input.route.connectionId === 'legacy:whatsapp' ? 'whatsapp'
    : input.route.connectionId === 'legacy:agent_whatsapp' ? 'agent_whatsapp' : undefined;
  if (!key) return stop(failed('Invalid exact Twilio connection.'));
  // Resolve credentials from precisely the live licensed row. Do not use a
  // default Twilio account, an environment token or a Messaging Service as From.
  const config = await io(() => exactWhatsAppConfig(input.siteId, { id: key, channel: 'whatsapp', provider: key, config: channels[key] }), error => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    return code === 'EXACT_CREDENTIALS_UNAVAILABLE' || code === 'EXACT_SENDER_UNAVAILABLE'
      ? unavailable('Selected Twilio sender credentials are unavailable.') : readFailure(input.template);
  });
  if (!config || !present(config.accessToken)) return stop(unavailable('Selected Twilio sender credentials are unavailable.'));
  if (!/^AC[a-f\d]{32}$/i.test(config.phoneNumberId) || input.route.sender !== JSON.stringify([config.phoneNumberId, config.fromNumber])) {
    return stop(failed('Invalid exact Twilio sender identity.'));
  }
  await bounded(input.verifyBinding());
  return config;
}

async function zavu(input: Input, language?: string): Promise<RoutedTextResult> {
  const senderId = input.route.sender;
  const delivery = { to: input.recipient, senderId, idempotencyKey: `routed-text:${input.siteId}:${input.messageId}` };
  await admitZavu(input);
  if (language === undefined) {
    const result = await io(() => sendChannelMessage({ ...delivery, channel: 'whatsapp', text: input.text,
      signal: AbortSignal.timeout(TIMEOUT_MS) }), zavuSendError);
    if (isAcceptedZavuMessage(result)) return acceptance(result.message.id, input);
    return result?.message?.status === 'failed' && validId(result.message.id) ? failed('WhatsApp reported message failure.') : unconfirmed();
  }

  // Zavu's GET is project-scoped, not sender-scoped. A route-specific name
  // binds the resource to this route/message/body in addition to the caller's
  // receipt and the exact sender supplied to submit and send.
  const name = templateName(input, language);
  const matches = (row: ZavuTemplate, id: string) => validId(id) && row.id === id && row.name === name
    && row.body === input.text && row.language === language;
  const terminal = (row: ZavuTemplate) => row.status === 'rejected' || (typeof row.whatsapp?.status === 'string'
    && isTerminalWhatsAppApprovalStatus(row.whatsapp.status));
  if (!input.template) {
    const created = await io(() => createZavuTemplate({ name, language, body: input.text }), error => mutationError(error, 'template creation'));
    if (created.status !== 'draft' || !matches(created, created.id)) return mismatch();
    await admitZavu(input);
    const submitted = await io(() => submitZavuTemplate(created.id, senderId), error => mutationError(error, 'template submission'));
    if (!matches(submitted, created.id)) return mismatch();
    return terminal(submitted) ? rejected() : pending({ id: created.id, name, language });
  }

  const ref = input.template;
  if (ref.name !== undefined && ref.name !== name) return mismatch();
  const current = await io(() => getZavuTemplate(ref.id), error => pollError(error, ref));
  if (!matches(current, ref.id)) return mismatch();
  if (terminal(current)) return rejected();
  if (current.status !== 'approved' || (current.whatsapp?.status !== undefined &&
    (typeof current.whatsapp.status !== 'string' || current.whatsapp.status.toLowerCase() !== 'approved'))) return pending(ref);
  await admitZavu(input);
  return acceptance(await io(() => sendZavuTemplate({ ...delivery, templateId: ref.id }), zavuSendError), input);
}

// The legacy Twilio creator reformats/truncates bodies, hard-codes a language,
// retries POST and combines create+submit. Use the same Content endpoints with
// one mutation per admission and a fresh, account-authenticated approval read.
const contentApi = 'https://content.twilio.com/v1/Content';
const contentSid = (value: unknown): value is string => typeof value === 'string' && /^HX[0-9a-f]{32}$/i.test(value);
async function contentRequest(config: TwilioConfig, path: string, body?: object): Promise<unknown> {
  const response = await fetch(`${contentApi}${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Authorization: `Basic ${Buffer.from(`${config.phoneNumberId}:${config.accessToken}`).toString('base64')}`,
      'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Object.assign(new Error('Twilio Content request failed'), { status: response.status });
  return response.json();
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function exactContent(value: unknown, input: Input, config: TwilioConfig, language: string, ref: Partial<TextTemplate>): value is {
  sid: string; friendly_name: string;
} {
  return record(value) && contentSid(value.sid) && (!ref.id || ref.id === value.sid)
    && value.account_sid === config.phoneNumberId && value.language === language
    && present(value.friendly_name) && (ref.name === undefined || ref.name === value.friendly_name)
    && record(value.types) && Object.keys(value.types).length === 1 && record(value.types['twilio/text'])
    && value.types['twilio/text'].body === input.text;
}

async function findTwilioTemplate(input: Input, config: TwilioConfig, language: string) {
  const { data, error } = await supabaseAdmin.from('whatsapp_templates').select('template_sid,template_name')
    .eq('site_id', input.siteId).eq('account_sid', config.phoneNumberId).eq('language', language)
    .eq('templated_body', input.text).in('status', ['active', 'approved', 'pending'])
    .order('created_at', { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(TIMEOUT_MS)).maybeSingle();
  if (error) throw new Error('Twilio template lookup failed'); // A lookup outage is not a cache miss.
  if (!data) return undefined;
  if (!contentSid(data.template_sid) || !present(data.template_name)) throw new Error('Invalid Twilio template reference');
  return { id: data.template_sid, name: data.template_name, language };
}

async function createTwilioTemplate(input: Input, language: string): Promise<RoutedTextResult> {
  const name = templateName(input, language);
  const config = await admitTwilio(input);
  const created = await io(() => contentRequest(config, '', { friendly_name: name, language,
    types: { 'twilio/text': { body: input.text } } }), error => mutationError(error, 'template creation'));
  if (!exactContent(created, input, config, language, { name })) return mismatch();
  const ref = { id: created.sid, name, language };
  const live = await admitTwilio(input);
  const submission = await io(() => contentRequest(live, `/${ref.id}/ApprovalRequests/whatsapp`, { name, category: 'UTILITY' }),
    error => mutationError(error, 'template submission'));
  if (!record(submission) || !present(submission.status)) return unknown('Twilio template submission was not confirmed.');
  if ((submission.name !== undefined && submission.name !== name)
    || (submission.content_sid !== undefined && submission.content_sid !== ref.id)
    || (submission.account_sid !== undefined && submission.account_sid !== live.phoneNumberId)) return mismatch();
  if (isTerminalWhatsAppApprovalStatus(submission.status)) return rejected();
  // Catalog only, never a delivery receipt. If catalog persistence fails, the
  // caller can still poll *this exact submitted SID*, without another creation.
  try {
    await bounded(supabaseAdmin.from('whatsapp_templates').insert({ site_id: input.siteId, account_sid: config.phoneNumberId,
      template_sid: ref.id, template_name: name, language, content: input.text, original_message: input.text,
      templated_body: input.text, placeholder_map: [], status: 'pending' }).abortSignal(AbortSignal.timeout(TIMEOUT_MS)));
  } catch { /* Best-effort cache, not authorization or message state. */ }
  return pending(ref);
}

async function dispatchTwilio(input: Input, sid?: string): Promise<RoutedTextResult> {
  const config = await admitTwilio(input);
  const sent = await io(() => sendTwilioWhatsAppMessage({ phoneNumber: input.recipient, message: input.text,
    accountSid: config.phoneNumberId, authToken: config.accessToken, fromNumber: config.fromNumber,
    messagingServiceSid: config.messagingServiceSid, contentSid: sid, pinFromNumber: true, strictSingleMessage: true }), unconfirmed);
  if (sent.success) return acceptance(sent.messageId, input);
  // A server/gateway error is not a confirmed refusal, even if its body echoes
  // an earlier 63007. Never select a second sender based only on an error body.
  if (sent.httpStatus !== 400 || sent.messageId) return unconfirmed();
  if (sent.errorCode === 63007) return unavailable('Twilio 63007: the selected WhatsApp sender was not recognized.');
  if ([21211, 21610, 21614, 63003, 63016, 63018, 63020, 63021, 63022, 63024, 63032].includes(sent.errorCode ?? 0)) {
    return failed('Twilio rejected the WhatsApp message.');
  }
  return unconfirmed();
}

async function twilio(input: Input, language?: string): Promise<RoutedTextResult> {
  if (language === undefined) return dispatchTwilio(input);
  const config = await admitTwilio(input);
  const ref = input.template ?? await io(() => findTwilioTemplate(input, config, language), () => readFailure());
  if (!ref) return createTwilioTemplate(input, language);
  if (!contentSid(ref.id)) return mismatch();
  const current = await io(() => contentRequest(config, `/${ref.id}`), error => pollError(error, ref));
  if (!exactContent(current, input, config, language, ref)) return mismatch();
  const approval = await io(() => contentRequest(config, `/${ref.id}/ApprovalRequests`), error => pollError(error, ref));
  if (!record(approval) || !record(approval.whatsapp) || !present(approval.whatsapp.status)) return pending(ref);
  if (approval.content_sid !== undefined && approval.content_sid !== ref.id) return mismatch();
  if (approval.account_sid !== undefined && approval.account_sid !== config.phoneNumberId) return mismatch();
  const status = approval.whatsapp.status.toLowerCase();
  if (isTerminalWhatsAppApprovalStatus(status)) return rejected();
  if (status !== 'approved') return pending(ref);
  return dispatchTwilio(input, ref.id);
}

/** One exclusive caller, one route, at most one message POST. Caller owns the
 * saved-message CAS, sender-specific window, suppression guard and result write.
 * Pass the full pending template back on the same route; never retry unknown. */
export async function attemptRoutedText(input: Input): Promise<RoutedTextResult> {
  if (![input.siteId, input.conversationId, input.messageId, input.route?.connectionId, input.route?.sender].every(present)
    || !['zavu', 'twilio'].includes(input.route.provider) || typeof input.forceTemplate !== 'boolean'
    || !/^\+[1-9]\d{6,14}$/.test(input.recipient) || !present(input.text) || /\{\{|\}\}|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)) {
    return failed('Invalid saved WhatsApp text, route or recipient.');
  }
  const useTemplate = input.forceTemplate || input.template !== undefined;
  if (input.template !== undefined && (!validId(input.template?.id) || (input.template.language !== undefined && !present(input.template.language)))) return mismatch();
  if (useTemplate && input.text.length > 1024) return failed('WhatsApp template exceeds the 1024-character limit.');
  if (input.route.provider === 'twilio' && input.text.length > 1500) return failed('Text exceeds the single-message Twilio limit.');
  try {
    const language = useTemplate
      ? input.template?.language ?? await io(() => loadSiteTemplateLanguage(input.siteId), () => readFailure(input.template)) : undefined;
    if (useTemplate && !present(language)) return failed('A WhatsApp template language is required.');
    return input.route.provider === 'zavu' ? await zavu(input, language) : await twilio(input, language);
  } catch (error) {
    if (error instanceof Stop) return error.result;
    throw error;
  }
}
