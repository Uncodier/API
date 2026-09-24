import { describe, expect, it } from '@jest/globals';
import { auditInternalLinks } from '../step-interaction-links';

describe('auditInternalLinks', () => {
  it('records positive header and footer link evidence', () => {
    const result = auditInternalLinks({
      file: 'src/app/layout.tsx',
      content: `
        export default function Layout({ children }) {
          return <>
            <header><nav><Link href="/">Home</Link><Link href="/services">Services</Link></nav></header>
            {children}
            <footer><Link href="/contact">Contact</Link></footer>
          </>;
        }
      `,
      routePatterns: [/^\/$/, /^\/services$/, /^\/contact$/],
      publicFiles: new Set(),
    });

    expect(result.links).toEqual([
      expect.objectContaining({
        target: '/',
        region: 'header',
        route_exists: true,
        content_excerpt: 'Home',
      }),
      expect.objectContaining({
        target: '/services',
        region: 'header',
        route_exists: true,
      }),
      expect.objectContaining({
        target: '/contact',
        region: 'footer',
        route_exists: true,
      }),
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it('records missing and dynamically unresolved internal links', () => {
    const result = auditInternalLinks({
      file: 'src/app/layout.tsx',
      content: `
        export const Layout = ({ target }) => (
          <header>
            <Link href="/missing">Missing</Link>
            <Link href={target}>Dynamic</Link>
          </header>
        );
      `,
      routePatterns: [/^\/$/],
      publicFiles: new Set(),
    });

    expect(result.links).toEqual([
      expect.objectContaining({
        target: '/missing',
        route_exists: false,
      }),
    ]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ region: 'header' }),
    ]);
  });

  it('records static targets used by mapped navigation', () => {
    const result = auditInternalLinks({
      file: 'src/components/Nav.tsx',
      content: `
        const links = [{ href: '/services' }, { href: '/contact' }];
        export const Nav = () => <nav>{links.map((item) => <Link href={item.href} />)}</nav>;
      `,
      routePatterns: [/^\/services$/, /^\/contact$/],
      publicFiles: new Set(),
    });

    expect(result.links).toEqual([
      expect.objectContaining({
        target: '/services',
        source_binding: 'src/components/Nav.tsx#links:href',
      }),
      expect.objectContaining({
        target: '/contact',
        source_binding: 'src/components/Nav.tsx#links:href',
      }),
    ]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        region: 'navigation',
        source_binding: 'src/components/Nav.tsx#links:href',
      }),
    ]);
  });

  it('qualifies mapped hrefs with their imported configuration source', () => {
    const result = auditInternalLinks({
      file: 'src/components/Nav.tsx',
      content:
        'export const Nav = () => <nav>{links.map((item) => <Link href={item.href} />)}</nav>;',
      routePatterns: [/^\/services$/],
      publicFiles: new Set(),
      importBindings: {
        links: 'src/config/navigation.ts#navigation',
      },
    });

    expect(result.unresolved).toEqual([
      expect.objectContaining({
        source_binding: 'src/config/navigation.ts#navigation:href',
      }),
    ]);
  });
});
