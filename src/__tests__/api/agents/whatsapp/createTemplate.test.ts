import { NextRequest } from 'next/server';

// Storage for captured inserts
const trackingInserts: any[] = [];

// Mocks
jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({
	WhatsAppTemplateService: {
		checkResponseWindow: jest.fn(),
		findExistingTemplate: jest.fn(),
		createTemplate: jest.fn(),
	}
}));

jest.mock('@/lib/services/whatsapp/WhatsAppSendService', () => ({
	WhatsAppSendService: {
		getWhatsAppConfig: jest.fn(),
		isValidPhoneNumber: jest.fn(() => true),
	}
}));

// Mock Supabase admin client minimal API used in route
jest.mock('@/lib/database/supabase-client', () => ({
	supabaseAdmin: {
		from: jest.fn((tableName: string) => {
			if (tableName === 'sites') {
				return {
					select: jest.fn(() => ({
						eq: jest.fn(() => ({
							single: jest.fn(() => Promise.resolve({
								data: {
									business_name: 'Mi Empresa Ñ',
									business_website: 'https://mi-empresa.es',
									business_description: 'Descripción de prueba',
								},
								error: null,
							}))
						}))
					}))
				};
			}
			if (tableName === 'whatsapp_template_tracking') {
				return {
					insert: jest.fn((rows) => {
						if (Array.isArray(rows) && rows[0]) {
							trackingInserts.push(rows[0]);
						}
						return Promise.resolve({ data: null, error: null });
					}),
					select: jest.fn(() => ({
						eq: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: {
							message_id: 'msg-123', template_sid: 'tmpl-123', status: 'created', phone_number: '+5215512345678', created_at: new Date().toISOString()
						}, error: null })) }))
					}))
				};
			}
			return {
				insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
				select: jest.fn(() => ({ eq: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: null, error: null })) })) }))
			};
		}),
	},
}));

// Import after mocks
const { POST, GET } = require('@/app/api/agents/whatsapp/createTemplate/route');
const { WhatsAppTemplateService } = require('@/lib/services/whatsapp/WhatsAppTemplateService');
const { WhatsAppSendService } = require('@/lib/services/whatsapp/WhatsAppSendService');

const VALID_SITE_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('/api/agents/whatsapp/createTemplate', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		trackingInserts.length = 0;
	});

	test('within 24h window → template not required', async () => {
		WhatsAppTemplateService.checkResponseWindow.mockResolvedValue({ withinWindow: true, hoursElapsed: 2 });

		const req = new NextRequest('http://localhost:3000/api/agents/whatsapp/createTemplate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				phone_number: '+5215512345678',
				message: 'Hola José Muñoz, visita https://ejemplo.com/acción',
				site_id: VALID_SITE_UUID,
				conversation_id: 'conv-1',
				from: 'Mi Empresa Ñ'
			}),
		});

		const res = await POST(req);
		const data = await res.json();
		expect(res.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.template_required).toBe(false);
		expect(data.within_window).toBe(true);
		expect(typeof data.message_id).toBe('string');
		// No debe guardar tracking en ventana
		expect(trackingInserts.length).toBe(0);
	});

	test('outside window + existing template found', async () => {
		WhatsAppTemplateService.checkResponseWindow.mockResolvedValue({ withinWindow: false, hoursElapsed: 30 });
		WhatsAppSendService.getWhatsAppConfig.mockResolvedValue({ phoneNumberId: 'PN123', accessToken: 'AT123', fromNumber: '+525512345678' });
		WhatsAppTemplateService.findExistingTemplate.mockResolvedValue({ templateSid: 'TEMPLATE_EXISTENTE_123' });

		const req = new NextRequest('http://localhost:3000/api/agents/whatsapp/createTemplate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				phone_number: '+5215512345678',
				message: 'Oferta para niños – más info en https://ejemplo.com/niños',
				site_id: VALID_SITE_UUID,
			}),
		});

		const res = await POST(req);
		const data = await res.json();
		expect(res.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.template_required).toBe(true);
		expect(data.template_id).toBe('TEMPLATE_EXISTENTE_123');
		expect(data.template_status).toBe('approved');
		// No debe guardar tracking si reusa plantilla
		expect(trackingInserts.length).toBe(0);
	});

	test('outside window + create new template saves original/formatted message', async () => {
		WhatsAppTemplateService.checkResponseWindow.mockResolvedValue({ withinWindow: false, hoursElapsed: 50 });
		WhatsAppSendService.getWhatsAppConfig.mockResolvedValue({ phoneNumberId: 'PN123', accessToken: 'AT123', fromNumber: '+525512345678' });
		WhatsAppTemplateService.findExistingTemplate.mockResolvedValue(null);
		WhatsAppTemplateService.createTemplate.mockResolvedValue({ success: true, templateSid: 'NEW_TEMPLATE_456' });

		const original = '¡Promoción de otoño! Visita https://mi-sitio.es/acción';
		const req = new NextRequest('http://localhost:3000/api/agents/whatsapp/createTemplate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				phone_number: '+5215512345678',
				message: original,
				site_id: VALID_SITE_UUID,
			})
		});

		const res = await POST(req);
		const data = await res.json();
		expect(res.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.template_required).toBe(true);
		expect(data.template_id).toBe('NEW_TEMPLATE_456');
		expect(data.template_status).toBe('created');

		// Verificar insert en tracking
		expect(trackingInserts.length).toBeGreaterThanOrEqual(1);
		const last = trackingInserts[trackingInserts.length - 1];
		expect(last.site_id).toBe(VALID_SITE_UUID);
		expect(last.template_sid).toBe('NEW_TEMPLATE_456');
		expect(last.status).toBe('created');
		expect(last.original_message).toBe(original);
		expect(last.formatted_message).toContain(original);
		expect(last.formatted_message).toContain('---');
		expect(last.formatted_message).toContain('Mi Empresa Ñ');
		expect(last.formatted_message).toContain('https://mi-empresa.es');
	});

	test('outside window + connectivity fallback saves pending_retry with messages', async () => {
		WhatsAppTemplateService.checkResponseWindow.mockResolvedValue({ withinWindow: false, hoursElapsed: 49 });
		WhatsAppSendService.getWhatsAppConfig.mockResolvedValue({ phoneNumberId: 'PN123', accessToken: 'AT123', fromNumber: '+525512345678' });
		WhatsAppTemplateService.findExistingTemplate.mockResolvedValue(null);
		WhatsAppTemplateService.createTemplate.mockResolvedValue({ success: false, error: 'DNS resolution failed' });

		const original = 'Consulta nuestro blog: https://ejemplo.com/acción';
		const req = new NextRequest('http://localhost:3000/api/agents/whatsapp/createTemplate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				phone_number: '+5215512345678',
				message: original,
				site_id: VALID_SITE_UUID,
			})
		});

		const res = await POST(req);
		const data = await res.json();
		expect(res.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.template_required).toBe(true);
		expect(data.fallback_mode).toBe(true);
		expect(data.template_status).toBe('pending_approval');
		expect(typeof data.template_id).toBe('string');
		expect(data.template_id).toMatch(/^fallback_/);

		// Verificar insert en tracking
		expect(trackingInserts.length).toBeGreaterThanOrEqual(1);
		const last = trackingInserts[trackingInserts.length - 1];
		expect(last.status).toBe('pending_retry');
		expect(last.original_message).toBe(original);
		expect(last.formatted_message).toContain(original);
		expect(last.formatted_message).toContain('Mi Empresa Ñ');
		expect(last.formatted_message).toContain('https://mi-empresa.es');
	});

	test('invalid inputs → 400', async () => {
		const req = new NextRequest('http://localhost:3000/api/agents/whatsapp/createTemplate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				phone_number: '+5215512345678',
				message: 'Hola',
				// missing site_id
			})
		});

		const res = await POST(req);
		const data = await res.json();
		expect(res.status).toBe(400);
		expect(data.success).toBe(false);
		expect(data.error).toBeDefined();
	});

	test('GET status by message_id', async () => {
		const req = new NextRequest('http://localhost:3000/api/agents/whatsapp/createTemplate?message_id=msg-123');
		const res = await GET(req);
		const data = await res.json();
		expect(res.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.template_id).toBeDefined();
		expect(data.template_status).toBeDefined();
	});
});
