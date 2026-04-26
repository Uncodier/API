import { SandboxService } from '@/lib/services/sandbox-service';
import { liveSandbox, type SandboxToolsContext } from '@/app/api/agents/tools/sandbox/assistantProtocol';

export function sandboxReadLogsTool(sandbox?: any, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_read_logs',
    description: 'Reads the local development server logs (e.g. Next.js server) and browser console logs from the visual probe. Use this tool when you need to investigate 500 errors, hydration failures, or missing content that might be caused by backend/API issues.',
    parameters: {
      type: 'object',
      properties: {
        log_type: {
          type: 'string',
          enum: ['server', 'console'],
          description: 'Which logs to read: "server" for the Next.js/Node backend logs, "console" for the browser console errors.'
        },
        lines: {
          type: 'number',
          description: 'Number of lines to read from the end of the log (default 100, max 500).'
        }
      },
      required: ['log_type']
    },
    execute: async (args: { log_type: 'server' | 'console'; lines?: number }) => {
      const lines = Math.min(args.lines || 100, 500);
      const wd = SandboxService.WORK_DIR;
      
      try {
        if (!sandbox) {
           return {
             success: false,
             error: "Sandbox instance not provided to tool. Please use sandbox_run_command directly.",
             suggested_command: args.log_type === 'server' 
               ? `cd ${wd} && cat .next/server.log 2>/dev/null || cat server.log 2>/dev/null || echo "No server logs found"`
               : `cat /tmp/visual-probe-console.log 2>/dev/null || echo "No console logs found"`
           }
        }
        
        const s0 = liveSandbox(sandbox, toolsCtx);

        let script = '';
        if (args.log_type === 'server') {
          script = `
            cd ${wd}
            if [ -f ".next/server.log" ]; then
              tail -n ${lines} .next/server.log
            elif [ -f "server.log" ]; then
              tail -n ${lines} server.log
            else
              echo "No dedicated server.log file found. Checking recent error outputs..."
              find . -name "*.log" -not -path "*/node_modules/*" -exec tail -n 20 {} \\; | tail -n ${lines}
            fi
          `;
        } else {
          script = `
            if [ -f "/tmp/visual-probe-console.log" ]; then
              tail -n ${lines} /tmp/visual-probe-console.log
            else
              echo "Console logs not found. They are usually captured during the visual probe step."
            fi
          `;
        }
        
        const res = await s0.runCommand('sh', ['-c', script]);
        const out = await res.stdout();
        const err = await res.stderr();

        return {
          success: true,
          log_type: args.log_type,
          logs: out || err || "No logs found."
        };
      } catch (error: any) {
        return {
          success: false,
          error: `Failed to read logs: ${error.message}`
        };
      }
    }
  };
}
