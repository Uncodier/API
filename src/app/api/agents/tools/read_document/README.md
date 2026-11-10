# PDF image fallback

`pdf.ts` extracts text without requesting an image operator list. Only selected
pages without embedded text are sent to `pdf-decoder.cjs` through
`pdf-isolation.ts`. The child handles packed 1-bit grayscale and RGB/RGBA pixels
and returns complete PNG data URLs; prompt text excludes their base64 payload.

## Deployment requirements

Image decoding requires **Linux >= 4.7**, `/bin/sh`, and permission to launch the
current Node executable. Before Node starts, the launcher applies:

- `RLIMIT_DATA`: 384 MiB, including anonymous mmap/ArrayBuffer allocations on
  these Linux kernels. This is a data-allocation limit, not a total RSS limit.
- CPU time: 8 seconds; core dumps disabled.
- V8 old-space: 128 MiB, JIT disabled. The heap limit alone is not a buffer limit.
- Parent wall-clock timeout: 10 seconds, followed by `SIGKILL`.
- One active image child per API process; concurrent requests receive a retry
  warning rather than creating unbounded children or a queue.
- 20 MiB input; 8 MiB encoded images, five images; bounded stdout.

The decoder does not inherit API credentials, `NODE_OPTIONS`, or custom loaders.
Input is streamed over stdin, never interpolated in shell source or stored in a
temporary file. Next's file tracing includes the CJS decoder, pixel helpers and
the installed `unpdf` distribution in server artifacts.

This is resource isolation, not a filesystem/network security sandbox. The
child still runs as the API's OS user. Limits are per child/API process, not a
container-wide budget. Text parsing remains in the API process with the existing
caller deadline; this change does not introduce hard isolation for text parsing.

PDF.js can allocate mask buffers or all images in a page before returning its
operator list. Per-image metadata and output-count limits are **not** a safety
boundary for that work. The OS-limited process contains these allocations and
can be killed without terminating the API. Decoder errors/resource exhaustion
discard its output and return an explicit incomplete-result warning. Large or
unusual PDFs may therefore require external OCR or page images.

On macOS/Windows, unsupported kernels, unavailable isolation or decoder startup
failure, **image fallback fails closed**. Text remains available and the result
is marked truncated. There is no production option to bypass isolation.

## Tests

Generated PDF fixtures exercise the decoder directly in offline tests, including
on macOS. They do not demonstrate OS memory isolation. Launcher tests verify
limits, credential isolation, failure handling, timeouts and concurrency.
Linux-only tests exercise actual subprocess limits; run them in the deployment
image before release. Do not replace this check with a worker-thread heap limit:
worker resource limits do not cover external ArrayBuffer memory.