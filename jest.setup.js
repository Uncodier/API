// Mock environment variables
globalThis.process = globalThis.process || {};
globalThis.process.env = globalThis.process.env || {};
globalThis.process.env.ENCRYPTION_KEY = 'test_encryption_key_32_bytes_length!!';
globalThis.process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
globalThis.process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

// Mock Next.js router
globalThis.jest = globalThis.jest || {};
globalThis.jest.mock = globalThis.jest.mock || function() {};

globalThis.jest.mock('next/router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    query: {}
  })
})); 