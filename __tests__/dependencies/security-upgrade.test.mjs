import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { compile } from '@mdx-js/mdx';
import tailwindPostcss from '@tailwindcss/postcss';
import { ImapFlow } from 'imapflow';
import katex from 'katex';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import postcss from 'postcss';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

const require = createRequire(import.meta.url);

test('Nodemailer and Mailparser round-trip MIME messages without an SMTP connection', async () => {
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  try {
    const info = await transporter.sendMail({
      from: 'Sender <sender@example.invalid>',
      to: 'Recipient <recipient@example.invalid>',
      subject: 'Dependency compatibility — español',
      text: 'Contenido de prueba',
      html: '<p>Contenido de prueba</p>',
      attachments: [{ filename: 'sample.txt', content: Buffer.from('Offline attachment') }],
    });
    assert.deepEqual(info.envelope.to, ['recipient@example.invalid']);
    const parsed = await simpleParser(info.message);
    assert.equal(parsed.subject, 'Dependency compatibility — español');
    assert.equal(parsed.from.value[0].address, 'sender@example.invalid');
    assert.equal(parsed.to.value[0].address, 'recipient@example.invalid');
    assert.equal(parsed.text.trim(), 'Contenido de prueba');
    assert.equal(parsed.attachments[0].filename, 'sample.txt');
    assert.equal(parsed.attachments[0].content.toString(), 'Offline attachment');
  } finally {
    transporter.close();
  }
});

test('ImapFlow can load the overridden Nodemailer HTTP proxy helper', () => {
  const imapRequire = createRequire(require.resolve('imapflow'));
  assert.equal(imapRequire('nodemailer/package.json').version, '10.2.1');
  assert.equal(typeof imapRequire('nodemailer/lib/smtp-connection/http-proxy-client'), 'function');
  assert.equal(typeof ImapFlow, 'function');
});

for (const status of [200, 403]) {
  test(`ImapFlow proxy helper handles HTTP CONNECT ${status} on loopback`, { timeout: 5000 }, async (t) => {
    const server = createServer();
    const sockets = new Set();
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    let target;
    server.on('connect', (request, socket) => {
      target = request.url;
      socket.write(`HTTP/1.1 ${status} ${status === 200 ? 'Connection Established' : 'Forbidden'}\r\n\r\n`);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const imapRequire = createRequire(require.resolve('imapflow'));
    const connect = promisify(imapRequire('nodemailer/lib/smtp-connection/http-proxy-client'));
    const proxyUrl = new URL('http://127.0.0.1');
    proxyUrl.port = String(server.address().port);
    if (status === 200) {
      const socket = await connect(proxyUrl.href, 143, '127.0.0.1');
      assert.equal(socket.destroyed, false);
      socket.destroy();
    } else {
      await assert.rejects(connect(proxyUrl.href, 143, '127.0.0.1'));
    }
    assert.equal(target, '127.0.0.1:143');
  });
}

test('MDX math rendering works with the patched KaTeX and rejects inherited trust', async () => {
  const output = await compile('Inline math: $x^2$.\n\n$$\n\\frac{1}{2}\n$$', {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
  });
  assert.match(String(output), /katex/);
  assert.match(String(output), /katex-display/);
  assert.doesNotMatch(String(output), /katex-error/);
  assert.equal(output.messages.length, 0);
  const settings = Object.create({ trust: true });
  settings.throwOnError = false;
  const html = katex.renderToString(String.raw`\href{https://example.invalid}{link}`, settings);
  assert.doesNotMatch(html, /<a\b/);
  const trustedHtml = katex.renderToString(String.raw`\href{https://example.invalid}{link}`, { trust: true });
  assert.match(trustedHtml, /<a\b/);
});

test('Tailwind typography compiles with the patched selector parser', async () => {
  const input = [
    '@import "tailwindcss" source(none);',
    '@plugin "@tailwindcss/typography";',
    '@source inline("prose");',
  ].join('\n');
  const result = await postcss([tailwindPostcss()]).process(input, {
    from: new URL('../../dependencies-smoke.css', import.meta.url).pathname,
  });
  assert.match(result.css, /\.prose\b/);
  assert.match(result.css, /--tw-prose-body/);
  assert.match(result.css, /not-prose/);
  assert.match(result.css, /::before/);
  assert.match(result.css, /::after/);
});