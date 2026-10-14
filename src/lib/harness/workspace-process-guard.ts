/** Trusted Linux launcher, sent inline rather than loaded from the repository.
 * IPv6 CIDRs are rejected by the provider API. Keep IPv4 private-network denies
 * there and prohibit non-IPv4 sockets here, including mapped IPv6 addresses.
 * Anonymous Unix socketpairs remain available for child IPC; pathname/abstract
 * Unix sockets cannot reach the privileged VM control plane or receive its FDs.
 * seccomp + no_new_privs survive exec/fork; dropping capabilities prevents sudo
 * or network administration from undoing the process boundary. No fallback. */
export const WORKSPACE_ISOLATION_VERSION = 'ipv4-process-v1';

/** Only on a newly created trusted image, before repository code can run. The
 * current universal image has no /vercel/sandbox. Do not accept symlink parents,
 * chown existing content, or overwrite anything. Never used for adoption. */
export const WORKSPACE_ROOT_INIT = String.raw`
import os, stat, sys
try:
    if os.getuid() != 0: sys.exit(73)
    # Dedicated workload UID cannot access the privileged SDK/launcher process.
    if any(line.split(':')[2] == '1001' for line in open('/etc/passwd')): sys.exit(73)
    for path in ('/vercel', '/vercel/sandbox'):
        try: os.mkdir(path, 0o755)
        except FileExistsError: pass
        if not stat.S_ISDIR(os.lstat(path).st_mode): sys.exit(73)
    if os.listdir('/vercel/sandbox'): sys.exit(73)
    os.chown('/vercel', 1001, 1001)
    os.chown('/vercel/sandbox', 1001, 1001)
except OSError:
    sys.exit(73)
`;

export const WORKSPACE_PROCESS_GUARD = String.raw`
import ctypes, os, platform, sys
def deny():
    os.write(2, b'Workspace process isolation unavailable.\n')
    sys.exit(126)
try:
    if sys.platform != 'linux' or len(sys.argv) < 2: deny()
    machine = platform.machine()
    if machine == 'x86_64':
        arch, sockets = 0xc000003e, (41, 53)
        blocked = (101, 310, 311, 438, 425, 426, 427)
    elif machine == 'aarch64':
        arch, sockets = 0xc00000b7, (198, 199)
        blocked = (117, 270, 271, 438, 425, 426, 427)
    else: deny()
    if os.getuid() != 0: deny()
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
    # BPF: verify ABI; reject x32; deny cross-process escape and io_uring socket
    # creation. clone3 returns ENOSYS so libc can use the filtered clone syscall.
    instructions = [(0x20,0,0,4), (0x15,1,0,arch), (0x06,0,0,0x80000000),
        (0x20,0,0,0), (0x35,0,1,0x40000000), (0x06,0,0,0x80000000)]
    for nr in blocked:
        instructions += [(0x15,0,1,nr), (0x06,0,0,0x00050001)]
    instructions += [(0x15,0,1,435), (0x06,0,0,0x00050026)]
    instructions += [(0x15,0,4,sockets[0]), (0x20,0,0,16), (0x15,1,0,2),
        (0x06,0,0,0x00050061), (0x06,0,0,0x7fff0000),
        (0x15,0,4,sockets[1]), (0x20,0,0,16), (0x15,1,0,1),
        (0x06,0,0,0x00050061), (0x06,0,0,0x7fff0000), (0x06,0,0,0x7fff0000)]
    filters = (Filter * len(instructions))(*(Filter(*entry) for entry in instructions))
    program = Program(len(filters), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    # Filter installed as root, before switching to the dedicated workload UID.
    # There is no same-UID unfiltered launch window for /proc/pid/mem attacks.
    if libc.prctl(4, 0, 0, 0, 0) != 0: deny()
    if libc.prctl(38, 1, 0, 0, 0) != 0: deny()
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0: deny()
    last_cap = int(open('/proc/sys/kernel/cap_last_cap').read())
    for cap in range(last_cap + 1):
        if libc.prctl(24, cap, 0, 0, 0) != 0: deny()
    os.setgroups([])
    os.setgid(1001)
    os.setuid(1001)
    class CapHeader(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint), ('pid', ctypes.c_int)]
    class CapData(ctypes.Structure):
        _fields_ = [('effective', ctypes.c_uint), ('permitted', ctypes.c_uint), ('inheritable', ctypes.c_uint)]
    caps = (CapData * 2)()
    if libc.capset(ctypes.byref(CapHeader(0x20080522, 0)), caps) != 0: deny()
    status = dict(line.split(':', 1) for line in open('/proc/self/status') if ':' in line)
    if any(int(status[key].strip(), 16) for key in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')): deny()
    if status['NoNewPrivs'].strip() != '1': deny()
    # No inherited side-channel descriptors into an unfiltered SDK process.
    for entry in os.listdir('/proc/self/fd'):
        fd = int(entry)
        if fd > 2:
            try: os.close(fd)
            except OSError: pass
    os.execvp(sys.argv[1], sys.argv[1:])
except Exception:
    deny()
`;

export function guardedWorkspaceCommand(environmentArgs: string[], program: string, args: string[]): { cmd: string; args: string[]; sudo: true } {
  return { cmd: '/usr/bin/env', args: [...environmentArgs, '/usr/bin/python3', '-I', '-S', '-c', WORKSPACE_PROCESS_GUARD, program, ...args], sudo: true };
}