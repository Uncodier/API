#!/usr/bin/env node

// Local WebSocket proxy; protected chat is unavailable without the real database.
import { config } from 'dotenv';
import { createServer } from 'node:http';
import { parse } from 'node:url';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { authorizeWebSocketUpgrade, selectVisitorSessionProtocol } from './wsServerAuth.cjs';
import { handleConnection } from './wsServerConnection.cjs';

config({ path: '.env.local' });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = url && key ? createClient(url, key) : null;
const server = createServer();
const wss = new WebSocketServer({ noServer: true, handleProtocols: selectVisitorSessionProtocol });
const activeConnections = new Map();

wss.on('connection', (ws, _request, params) => {
  void handleConnection(ws, params, supabase, activeConnections);
});

server.on('upgrade', (request, socket, head) => {
  const { pathname, query } = parse(request.url, true);
  if (pathname !== '/ws' && pathname !== '/api/agents/chat/websocket') {
    socket.destroy();
    return;
  }
  const claims = authorizeWebSocketUpgrade(request, {
    siteId: query.site_id, sessionId: query.session_id, visitorId: query.visitor_id,
  });
  if (!claims) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request, {
      site_id: claims.siteId, session_id: claims.sessionId,
      conversation_id: query.conversation_id, claims,
    });
  });
});

server.listen(3002, () => {
  console.log('WebSocket proxy listening on port 3002 (/ws, /api/agents/chat/websocket)');
  if (!supabase) console.warn('Protected realtime is unavailable without database configuration');
});
const statusInterval = setInterval(() => {
  console.log(`WebSocket connections: ${activeConnections.size}; heap: ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`);
}, 60_000);
statusInterval.unref();