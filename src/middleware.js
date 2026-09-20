import requestMiddleware from './middleware/requestMiddleware';

export default requestMiddleware;

export const config = {
  matcher: ['/api/:path*', '/record'],
};
