import { NextRequest } from 'next/server';
import * as route from '../route';
import { listSystemNotificationCore, notifySystemNotificationCore } from '../core';
import { systemNotificationTool } from '../assistantProtocol';

// Offline: importing the HTTP/protocol adapters must not initialize providers.
jest.mock('../core', () => ({
  listSystemNotificationCore: jest.fn(),
  notifySystemNotificationCore: jest.fn(),
}));

function request(body: unknown): NextRequest {
  return new NextRequest('https://api.example.invalid/api/agents/tools/system_notification', {
    method: 'POST', body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('exports only the supported HTTP handler, never reusable core functions', () => {
  expect(Object.keys(route)).toEqual(['POST']);
});

it('preserves the HTTP list response', async () => {
  const members = [{ email: 'member@example.invalid' }];
  (listSystemNotificationCore as jest.Mock).mockResolvedValue(members);
  const response = await route.POST(request({ action: 'list', site_id: 'site-1' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, data: members });
  expect(listSystemNotificationCore).toHaveBeenCalledWith('site-1');
  expect(notifySystemNotificationCore).not.toHaveBeenCalled();
});

it('preserves the default notify action and all forwarded parameters', async () => {
  const params = { site_id: 'site-1', team_member_email: 'member@example.invalid', instance_id: 'instance-1',
    message: 'Message', title: 'Title', channels: ['email'], phone_number: '+15555550100' };
  (notifySystemNotificationCore as jest.Mock).mockResolvedValue({ email_sent: true });
  const response = await route.POST(request(params));
  expect(await response.json()).toEqual({ success: true, data: { email_sent: true } });
  expect(notifySystemNotificationCore).toHaveBeenCalledWith(params);
});

it.each([['site_id is required', 400], ['Service unavailable', 500]])(
  'preserves error status for %s', async (message, status) => {
    (listSystemNotificationCore as jest.Mock).mockRejectedValue(new Error(message));
    const response = await route.POST(request({ action: 'list' }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ success: false, error: message });
  },
);

it('lets the assistant protocol list members through the same core module', async () => {
  (listSystemNotificationCore as jest.Mock).mockResolvedValue([]);
  expect(await systemNotificationTool('site-1').execute({ action: 'list' })).toEqual({ success: true, data: [] });
  expect(listSystemNotificationCore).toHaveBeenCalledWith('site-1');
});

it('lets the assistant protocol notify with its pinned site', async () => {
  (notifySystemNotificationCore as jest.Mock).mockResolvedValue({ notification_sent: true });
  const args = { action: 'notify' as const, team_member_email: 'member@example.invalid', title: 'Title', message: 'Message' };
  expect(await systemNotificationTool('site-1').execute(args)).toEqual({ success: true, data: { notification_sent: true } });
  expect(notifySystemNotificationCore).toHaveBeenCalledWith(expect.objectContaining({ site_id: 'site-1', title: 'Title' }));
});

it('keeps assistant argument validation before notifying', async () => {
  await expect(systemNotificationTool('site-1').execute({ action: 'notify' })).rejects.toThrow('required');
  expect(notifySystemNotificationCore).not.toHaveBeenCalled();
});
