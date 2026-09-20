import requestMiddleware from './src/middleware/requestMiddleware';

export default requestMiddleware;

export const config = {
  matcher: ['/api/:path*', '/record'],
};
