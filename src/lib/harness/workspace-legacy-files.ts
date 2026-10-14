import { Readable } from 'node:stream';

/** Host-only SDK compatibility. Never expose this scratch-file API as a model tool.
 * Commands must use the same guarded UID as the workspace, not the SDK file user. */
export const LEGACY_FILE_PROGRAM = String.raw`
import os,sys,json,stat,base64,re
try:
    p=json.loads(''.join(sys.argv[1:]));path=p['path'];op=p['op']
    if not isinstance(path,str) or '\\' in path or '\x00' in path: raise ValueError()
    if not path.startswith('/') or any(s in ('','..','.') for s in path[1:].split('/')): raise ValueError()
    source=path.startswith('/vercel/sandbox/')
    scratch=bool(re.fullmatch(r'/tmp/(?:visual-probe\.js|visual-probe-captures/[A-Za-z0-9_.-]+|makinari-(?:server|probe)-[A-Za-z0-9_.-]+)',path))
    if not source and not scratch: raise ValueError()
    parts=path.strip('/').split('/')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for component in parts[:-1]:
            nxt=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
        name=parts[-1]
        if op=='write':
            data=base64.b64decode(p['data'],validate=True)
            if len(data)>262144: raise ValueError()
            file=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=fd)
        else: file=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
            st=os.fstat(file)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_uid!=os.getuid(): raise ValueError()
            if op=='write':
                os.ftruncate(file,0)
                with os.fdopen(os.dup(file),'wb') as out:out.write(data)
                result={'ok':True}
            elif op=='read':
                if st.st_size>262144: raise ValueError()
                with os.fdopen(os.dup(file),'rb') as inp:data=inp.read(262145)
                if len(data)>262144: raise ValueError()
                result={'ok':True,'data':base64.b64encode(data).decode('ascii')}
            elif op=='rm':
                os.unlink(name,dir_fd=fd);result={'ok':True}
            else:raise ValueError()
        finally:os.close(file)
    finally:os.close(fd)
    print(json.dumps(result))
except FileNotFoundError:print(json.dumps({'ok':False,'missing':True}))
except Exception:print(json.dumps({'ok':False}))
`;

type Command = { exitCode: number | null; stdout(): Promise<string> };
export type LegacyFileRun = (input: { cmd: string; args: string[]; timeoutMs: number; signal?: AbortSignal }) => Promise<Command>;
const failure = () => new Error('Legacy workspace file operation unavailable');
type Options = { signal?: AbortSignal; encoding?: BufferEncoding };

export function createLegacyFiles(run: LegacyFileRun) {
  const operation = async (op: string, path: string, data?: Buffer, options?: Options) => {
    if (typeof path !== 'string' || path.length > 4096 || (data && data.length > 262144)) throw failure();
    options?.signal?.throwIfAborted();
    const payload = JSON.stringify({ op, path, ...(data ? { data: data.toString('base64') } : {}) });
    const command = await run({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', LEGACY_FILE_PROGRAM,
      ...(payload.match(/[\s\S]{1,16000}/g) || [])], timeoutMs: 10000, signal: options?.signal });
    if (command.exitCode !== 0) throw failure();
    const text = await command.stdout();
    if (text.length > 360000) throw failure();
    let result: { ok?: boolean; missing?: boolean; data?: string };
    try { result = JSON.parse(text); } catch { throw failure(); }
    if (!result.ok && !result.missing) throw failure();
    options?.signal?.throwIfAborted();
    return result;
  };
  const read = async (path: string, options?: Options) => {
    const result = await operation('read', path, undefined, options);
    if (result.missing) return null;
    if (typeof result.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data)) throw failure();
    const data = Buffer.from(result.data, 'base64');
    if (data.length > 262144) throw failure();
    return data;
  };
  return {
    readFileToBuffer: ({ path }: { path: string }, options?: Options) => read(path, options),
    readFile: async ({ path }: { path: string }, options?: Options) => {
      const data = await read(path, options); return data === null ? null : Readable.from([data]);
    },
    writeFiles: async (files: Array<{ path: string; content: Buffer }>, options?: Options) => {
      if (!Array.isArray(files) || files.length > 64) throw failure();
      for (const file of files) {
        if (!Buffer.isBuffer(file.content)) throw failure();
        const result = await operation('write', file.path, file.content, options);
        if (!result.ok) throw failure();
      }
    },
    fs: {
      readFile: async (path: string, options?: BufferEncoding | Options) => {
        const opts = typeof options === 'string' ? { encoding: options } : options;
        const data = await read(path, opts); if (data === null) throw failure();
        return opts?.encoding ? data.toString(opts.encoding) : data;
      },
      rm: async (path: string, options?: { force?: boolean; recursive?: boolean; signal?: AbortSignal }) => {
        if (options?.recursive) throw failure();
        const result = await operation('rm', path, undefined, options);
        if (result.missing && !options?.force) throw failure();
      },
    },
  };
}