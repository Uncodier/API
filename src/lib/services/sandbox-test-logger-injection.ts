import type { Sandbox } from '@vercel/sandbox';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import { SandboxService } from '@/lib/services/sandbox-service';

export async function injectSandboxTestLogger(sandbox: Sandbox, workDir: string, auditCtx?: CronAuditContext) {
  // Extract info for the logger to phone home
  const instanceId = auditCtx?.instanceId || '';
  const siteId = auditCtx?.siteId || '';
  
  // This is the source code of the logger that will be injected into the sandbox.
  const loggerCode = `
import { AsyncLocalStorage } from 'async_hooks';
import { NextRequest, NextResponse } from 'next/server';

interface LogEntry {
  type: 'log' | 'error' | 'warn' | 'info';
  args: any[];
  timestamp: string;
}

const testLogsStorage = new AsyncLocalStorage<LogEntry[]>();

// Store original console methods
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
};

// Override console methods to capture logs if in test context
['log', 'error', 'warn', 'info'].forEach((method) => {
  const orig = (console as any)[method];
  (console as any)[method] = (...args: any[]) => {
    const store = testLogsStorage.getStore();
    if (store) {
      store.push({
        type: method as any,
        args: args.map(a => {
          try {
            return typeof a === 'object' ? JSON.stringify(a) : String(a);
          } catch (e) {
            return String(a);
          }
        }),
        timestamp: new Date().toISOString()
      });
    }
    // Always call original
    orig.apply(console, args);
  };
});

/**
 * HOC to wrap Next.js App Router Route Handlers.
 * Captures logs and sends them to the harness if a 500 error occurs.
 */
export function withTestLogs(handler: Function) {
  return async (req: NextRequest, ...context: any[]) => {
    // Only activate if X-Test-Signature is present
    const testSignature = req.headers.get('X-Test-Signature');
    
    if (!testSignature) {
      return handler(req, ...context);
    }

    const logs: LogEntry[] = [];
    
    return testLogsStorage.run(logs, async () => {
      try {
        const response = await handler(req, ...context);
        
        // If response is a 5xx error, report it
        if (response && response.status >= 500) {
          await reportLogsToHarness(req, logs, \`HTTP \${response.status} returned by handler\`, testSignature);
        }
        
        return response;
      } catch (error: any) {
        // Uncaught exception
        logs.push({
          type: 'error',
          args: [error?.stack || String(error)],
          timestamp: new Date().toISOString()
        });
        
        await reportLogsToHarness(req, logs, error?.message || 'Uncaught Exception', testSignature);
        
        // Re-throw or return 500
        return NextResponse.json({ 
          error: 'Internal Server Error', 
          message: error?.message,
          _testLogsReported: true 
        }, { status: 500 });
      }
    });
  };
}

async function reportLogsToHarness(req: NextRequest, logs: LogEntry[], errorMessage: string, signature: string) {
  try {
    // Prune logs to keep it small (last 50 logs)
    const prunedLogs = logs.slice(-50);
    
    const uncodieApiUrl = '${process.env.NEXT_PUBLIC_SITE_URL || 'https://api.makinari.com'}'; 
    const endpoint = \`\${uncodieApiUrl}/api/agents/tools/instance_logs\`;
    
    // Attempt to parse signature if it's JSON to extract IDs, 
    // or rely on env vars if passed via sandbox env
    const instanceId = process.env.SANDBOX_INSTANCE_ID || '${instanceId}';
    const siteId = process.env.SANDBOX_SITE_ID || '${siteId}';
    
    if (!instanceId) return;

    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer ${process.env.SERVICE_API_KEY || ''}\`
      },
      body: JSON.stringify({
        instance_id: instanceId,
        site_id: siteId,
        log_type: 'sandbox_test_failure',
        level: 'error',
        message: \`[Test Failure] \${req.method} \${req.nextUrl.pathname} - \${errorMessage}\`,
        details: {
          path: req.nextUrl.pathname,
          method: req.method,
          logs: prunedLogs
        }
      })
    }).catch(e => originalConsole.error('Failed to report logs to harness:', e));
  } catch (e) {
    originalConsole.error('Error in reportLogsToHarness:', e);
  }
}
`;

  // We write this file into the sandbox
  console.log('[Sandbox] Injecting src/lib/utils/sandbox-test-logger.ts');
  const mkdirRes = await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', 'src/lib/utils'], cwd: workDir });
  if (mkdirRes.exitCode !== 0) {
    console.warn('[Sandbox] Failed to create utils directory for test logger', await mkdirRes.stderr());
  }

  // Use base64 to safely transfer the code to the sandbox
  const base64Code = Buffer.from(loggerCode).toString('base64');
  const writeRes = await sandbox.runCommand({ 
    cmd: 'sh', 
    args: ['-c', `echo "${base64Code}" | base64 -d > src/lib/utils/sandbox-test-logger.ts`],
    cwd: workDir 
  });
  
  if (writeRes.exitCode !== 0) {
    console.warn('[Sandbox] Failed to write sandbox-test-logger.ts', await writeRes.stderr());
  }

  // Now, inject the Jest patch into jest.setup.js
  const jestPatchCode = `
// --- INJECTED BY HARNESS FOR TEST AGENT LOGGING ---
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(resource, options) {
  const opts = options || {};
  opts.headers = opts.headers || {};
  // Inject signature to trigger withTestLogs in the sandbox server
  opts.headers['X-Test-Signature'] = 'sandbox-qa-agent';
  
  const response = await originalFetch(resource, opts);
  
  if (!response.ok && response.status >= 500) {
    // Check if it's a JSON response that might have the _testLogsReported flag
    const cloned = response.clone();
    try {
      const data = await cloned.json();
      if (data && data._testLogsReported) {
        console.error('\\n\\n🚨 [SERVER INTERNAL LOGS REPORTED]');
        console.error('Test failed: Server returned 500. Detailed backend logs saved to instance_logs.');
        console.error('Use the instance_logs tool to fetch them for more context.\\n\\n');
      }
    } catch (e) {
      // Not JSON, ignore
    }
  }
  return response;
};
// ---------------------------------------------------
`;

  const base64JestPatch = Buffer.from(jestPatchCode).toString('base64');
  console.log('[Sandbox] Injecting Jest patch into jest.setup.js or jest.setup.ts');
  const injectJestRes = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `if [ -f "jest.setup.js" ]; then echo "${base64JestPatch}" | base64 -d >> jest.setup.js; elif [ -f "jest.setup.ts" ]; then echo "${base64JestPatch}" | base64 -d >> jest.setup.ts; fi`],
    cwd: workDir
  });

  if (injectJestRes.exitCode !== 0) {
    console.warn('[Sandbox] Failed to inject jest patch', await injectJestRes.stderr());
  }
}
