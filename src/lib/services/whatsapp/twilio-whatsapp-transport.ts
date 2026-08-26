import { WhatsAppTemplateService } from './WhatsAppTemplateService';
import { twilioWhatsAppFromCandidates } from '@/lib/services/twilio/whatsapp-number-match';

export interface TwilioWhatsAppSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  errorCode?: number;
  errorType?: string;
  suggestion?: string;
}

export async function sendTwilioWhatsAppMessage(params: {
  phoneNumber: string;
  message: string;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  mediaUrls?: string[];
  messagingServiceSid?: string;
}): Promise<TwilioWhatsAppSendResult> {
  try {
    console.log('📤 [WhatsAppSendService] Enviando via API de Twilio WhatsApp...');

    const chunks = chunkWhatsAppMessage(params.message, 1500);
    let lastSid: string | undefined;
    const fromCandidates = twilioWhatsAppFromCandidates(params.fromNumber);

    for (let i = 0; i < chunks.length; i++) {
      const mediaForChunk = i === 0 ? params.mediaUrls : undefined;

      if (params.messagingServiceSid) {
        console.log(`📋 [WhatsAppSendService] Usando Messaging Service: ${params.messagingServiceSid}`);
        const posted = await postTwilioWhatsAppMessage({
          accountSid: params.accountSid,
          authToken: params.authToken,
          phoneNumber: params.phoneNumber,
          body: chunks[i],
          mediaUrls: mediaForChunk,
          messagingServiceSid: params.messagingServiceSid,
          chunkIndex: i,
          chunkCount: chunks.length,
        });
        if (!posted.success) return posted;
        lastSid = posted.messageId;
      } else {
        let posted: TwilioWhatsAppSendResult | null = null;
        for (const candidate of fromCandidates) {
          posted = await postTwilioWhatsAppMessage({
            accountSid: params.accountSid,
            authToken: params.authToken,
            phoneNumber: params.phoneNumber,
            body: chunks[i],
            mediaUrls: mediaForChunk,
            fromNumber: candidate,
            chunkIndex: i,
            chunkCount: chunks.length,
          });
          if (posted.success) break;
          if (posted.errorCode === 63007 && candidate !== fromCandidates[fromCandidates.length - 1]) {
            console.warn(`⚠️ [WhatsAppSendService] 63007 con From ${candidate}, reintentando con el siguiente candidato`);
            continue;
          }
          return posted;
        }
        if (!posted?.success) {
          return posted || { success: false, error: 'Failed to send WhatsApp message' };
        }
        lastSid = posted.messageId;
      }

      if (chunks.length > 1 && i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return { success: true, messageId: lastSid };
  } catch (error) {
    console.error('❌ [WhatsAppSendService] Error en llamada a API de Twilio:', error);
    return {
      success: false,
      error: `Exception: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function postTwilioWhatsAppMessage(params: {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  body: string;
  mediaUrls?: string[];
  fromNumber?: string;
  messagingServiceSid?: string;
  chunkIndex: number;
  chunkCount: number;
}): Promise<TwilioWhatsAppSendResult> {
  const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${params.accountSid}/Messages.json`;
  const credentials = Buffer.from(`${params.accountSid}:${params.authToken}`).toString('base64');
  const formData = new URLSearchParams();

  if (params.messagingServiceSid) {
    formData.append('MessagingServiceSid', params.messagingServiceSid);
  } else if (params.fromNumber) {
    formData.append('From', `whatsapp:${params.fromNumber}`);
  }

  formData.append('To', `whatsapp:${params.phoneNumber}`);
  formData.append('Body', params.body);

  if (params.mediaUrls && params.mediaUrls.length > 0) {
    params.mediaUrls.slice(0, 10).forEach((url) => formData.append('MediaUrl', url));
  }

  console.log(`🔐 [WhatsAppSendService] Datos de envío chunk ${params.chunkIndex + 1}/${params.chunkCount}:`, {
    url: apiUrl,
    from: params.messagingServiceSid
      ? `MessagingService:${params.messagingServiceSid}`
      : `whatsapp:${params.fromNumber}`,
    to: `whatsapp:${params.phoneNumber}`,
    messageLength: params.body.length,
    hasMedia: !!params.mediaUrls?.length,
  });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    const errorData = await response.json();
    const twilioErrorCode = errorData.code;
    const errorMessage = errorData.message || response.statusText;
    const fromLabel = params.messagingServiceSid || params.fromNumber;

    console.error(`❌ [WhatsAppSendService] Error de API de Twilio en chunk ${params.chunkIndex + 1}:`, {
      status: response.status,
      twilioErrorCode,
      errorMessage,
      fullError: errorData,
      to: params.phoneNumber,
      from: fromLabel,
    });

    const errorInfo = WhatsAppTemplateService.getTwilioErrorInfo(twilioErrorCode);
    console.error(`🚨 [WhatsAppSendService] ERROR ${twilioErrorCode}: ${errorInfo.description}`);
    console.error(`💡 [WhatsAppSendService] Sugerencia: ${errorInfo.suggestion}`);

    return {
      success: false,
      error: `${errorInfo.description}: ${errorMessage}`,
      errorCode: twilioErrorCode,
      errorType: errorInfo.type,
      suggestion: errorInfo.suggestion,
    };
  }

  const responseData = await response.json();
  console.log(`✅ [WhatsAppSendService] Respuesta exitosa de Twilio chunk ${params.chunkIndex + 1}:`, {
    sid: responseData.sid,
    status: responseData.status,
    from: responseData.from,
    to: responseData.to,
  });

  return { success: true, messageId: responseData.sid };
}

export function chunkWhatsAppMessage(text: string, maxLength = 1500): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let currentChunk = '';
  const paragraphs = text.split('\n\n');

  for (const paragraph of paragraphs) {
    if ((currentChunk ? currentChunk + '\n\n' + paragraph : paragraph).length <= maxLength) {
      currentChunk = currentChunk ? currentChunk + '\n\n' + paragraph : paragraph;
    } else {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      if (paragraph.length > maxLength) {
        const lines = paragraph.split('\n');
        for (const line of lines) {
          if ((currentChunk ? currentChunk + '\n' + line : line).length <= maxLength) {
            currentChunk = currentChunk ? currentChunk + '\n' + line : line;
          } else {
            if (currentChunk.length > 0) {
              chunks.push(currentChunk);
              currentChunk = '';
            }
            if (line.length > maxLength) {
              let remaining = line;
              while (remaining.length > 0) {
                chunks.push(remaining.substring(0, maxLength));
                remaining = remaining.substring(maxLength);
              }
            } else {
              currentChunk = line;
            }
          }
        }
      } else {
        currentChunk = paragraph;
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
