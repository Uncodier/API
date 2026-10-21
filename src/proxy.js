import requestMiddleware from './middleware/requestMiddleware';

// Next.js 16 Proxy uses Node.js; keep the request policy and lifecycle unchanged.
export default requestMiddleware;

export const config = {
  matcher: ['/api/:path*', '/record'],
};
