import { zavuFetch } from './client';
import { isAcceptedZavuMessage } from '@/lib/messaging/exact-zavu-response';

export interface ZavuTemplate {
  id: string; name: string; body: string; language: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  whatsapp?: { status?: string };
}
function template(value: any): ZavuTemplate {
  const row = value?.template ?? value;
  if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string'
    || typeof row.body !== 'string' || typeof row.language !== 'string'
    || !['draft', 'pending', 'approved', 'rejected'].includes(row.status)) {
    throw new Error('Template provider returned an invalid response');
  }
  return row;
}
export async function createZavuTemplate(input: { name: string; body: string; language: string }): Promise<ZavuTemplate> {
  return template(await zavuFetch('/templates', { method: 'POST', signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ ...input, whatsappCategory: 'UTILITY', variables: [] }) }));
}
export async function submitZavuTemplate(id: string, senderId: string): Promise<ZavuTemplate> {
  return template(await zavuFetch(`/templates/${encodeURIComponent(id)}/submit`, { method: 'POST',
    signal: AbortSignal.timeout(30_000), body: JSON.stringify({ senderId, category: 'UTILITY' }) }));
}
export async function getZavuTemplate(id: string): Promise<ZavuTemplate> {
  return template(await zavuFetch(`/templates/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) }));
}
export async function sendZavuTemplate(input: { templateId: string; senderId: string; to: string; idempotencyKey: string }): Promise<string> {
  const result = await zavuFetch('/messages', { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'Zavu-Sender': input.senderId }, body: JSON.stringify({ to: input.to, channel: 'whatsapp',
      messageType: 'template', content: { templateId: input.templateId }, idempotencyKey: input.idempotencyKey }) },
  { acceptMessageReplay: true });
  if (!isAcceptedZavuMessage(result)) throw new Error('Template provider did not confirm acceptance');
  return result.message.id;
}