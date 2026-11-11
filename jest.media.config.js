import base from './jest.commands.config.js';

export default {
  ...base,
  testMatch: [
    '<rootDir>/src/lib/services/channels/__tests__/outbound-media.test.ts',
    '<rootDir>/src/lib/services/channels/__tests__/ChannelSendService.test.ts',
    '<rootDir>/src/lib/services/channels/__tests__/*media*.test.ts',
    '<rootDir>/src/lib/services/whatsapp/__tests__/WhatsAppSendService.test.ts',
    '<rootDir>/src/app/api/agents/tools/sendWhatsApp/__tests__/*.test.ts',
    '<rootDir>/src/app/api/agents/tools/sendChannelMessage/__tests__/*.test.ts',
    '<rootDir>/src/lib/messaging/__tests__/exact-email-attachments.test.ts',
    '<rootDir>/src/app/api/agents/chat/intervention/__tests__/send-intervention-by-channel.test.ts',
    '<rootDir>/src/app/api/agents/chat/intervention/__tests__/reuse-intervention-message.test.ts',
    '<rootDir>/src/lib/services/email/__tests__/native-attachments.test.ts',
    '<rootDir>/src/app/api/agents/tools/sendEmail/__tests__/*.test.ts',
  ],
};