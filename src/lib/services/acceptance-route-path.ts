export interface AcceptanceRoutePathAnalysis {
  valid: boolean;
  normalized?: string;
  executable: boolean;
  reason?: string;
}

const FORBIDDEN_ROUTE_CHARACTERS = /[\u0000-\u001f\u007f\s<>"'`\\]/;
const COLON_PARAMETER = /^:[A-Za-z_][A-Za-z0-9_]*$/;
const NEXT_PARAMETER =
  /^(?:\[[A-Za-z_][A-Za-z0-9_]*\]|\[\.\.\.[A-Za-z_][A-Za-z0-9_]*\]|\[\[\.\.\.[A-Za-z_][A-Za-z0-9_]*\]\])$/;

/**
 * Validates an application route independently from how it was discovered.
 * Template routes are valid contracts, but are not executable until a caller
 * supplies concrete parameter values.
 */
export function analyzeAcceptanceRoutePath(
  value: unknown,
): AcceptanceRoutePathAnalysis {
  if (typeof value !== 'string') {
    return {
      valid: false,
      executable: false,
      reason: 'Route must be a string.',
    };
  }

  const route = value.trim();
  if (!route.startsWith('/') || route.startsWith('//')) {
    return {
      valid: false,
      executable: false,
      reason: 'Route must start with one slash.',
    };
  }
  if (route.includes('#')) {
    return {
      valid: false,
      executable: false,
      reason: 'Route fragments are not server probe targets.',
    };
  }
  if (FORBIDDEN_ROUTE_CHARACTERS.test(route)) {
    return {
      valid: false,
      executable: false,
      reason: 'Route contains whitespace, markup, quotes, or a backslash.',
    };
  }

  const queryIndex = route.indexOf('?');
  const pathname = queryIndex >= 0 ? route.slice(0, queryIndex) : route;
  const query = queryIndex >= 0 ? route.slice(queryIndex) : '';
  if (pathname.length > 1 && pathname.includes('//')) {
    return {
      valid: false,
      executable: false,
      reason: 'Route contains an empty path segment.',
    };
  }

  let decodedPathname: string;
  try {
    // decodeURI validates escapes without decoding reserved path separators.
    decodedPathname = decodeURI(pathname);
  } catch {
    return {
      valid: false,
      executable: false,
      reason: 'Route contains malformed percent encoding.',
    };
  }

  const decodedSegments = decodedPathname.split('/').slice(1);
  if (decodedSegments.some((segment) => segment === '.' || segment === '..')) {
    return {
      valid: false,
      executable: false,
      reason: 'Route cannot contain current or parent path segments.',
    };
  }

  const segments = pathname.split('/').slice(1).filter(Boolean);
  let template = false;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const hasTemplateSyntax =
      segment.startsWith(':') ||
      segment.includes('[') ||
      segment.includes(']');
    if (!hasTemplateSyntax) continue;
    if (!COLON_PARAMETER.test(segment) && !NEXT_PARAMETER.test(segment)) {
      return {
        valid: false,
        executable: false,
        reason: `Route contains malformed parameter segment "${segment}".`,
      };
    }
    if (
      segment.includes('...') &&
      index !== segments.length - 1
    ) {
      return {
        valid: false,
        executable: false,
        reason: 'Catch-all route parameters must be the final segment.',
      };
    }
    template = true;
  }

  try {
    // Validate escapes in the complete route, including its query string.
    decodeURI(route);
  } catch {
    return {
      valid: false,
      executable: false,
      reason: 'Route contains malformed percent encoding.',
    };
  }

  const normalizedPath =
    pathname.length > 1 ? pathname.replace(/\/+$/, '') : '/';
  return {
    valid: true,
    normalized: `${normalizedPath}${query}`,
    executable: !template,
    ...(template
      ? { reason: 'Route contains unresolved path parameters.' }
      : {}),
  };
}

export function analyzeProbeRoutePath(
  value: unknown,
  kind?: 'page' | 'api',
): AcceptanceRoutePathAnalysis {
  const route = analyzeAcceptanceRoutePath(value);
  if (!route.valid || !route.normalized) return route;
  const pathname = route.normalized.split('?')[0];
  if (
    pathname.startsWith('/src/') ||
    pathname.startsWith('/public/') ||
    /\.[a-z0-9]{2,8}$/i.test(pathname)
  ) {
    return {
      valid: false,
      executable: false,
      reason: 'Source and asset file paths are not application routes.',
    };
  }
  if (kind === 'api' && !pathname.startsWith('/api/')) {
    return {
      valid: false,
      executable: false,
      reason: 'API probe targets must start with /api/.',
    };
  }
  if (kind === 'page' && pathname.startsWith('/api/')) {
    return {
      valid: false,
      executable: false,
      reason: 'Page probe targets cannot use the /api/ namespace.',
    };
  }
  return route;
}

export function routeTemplateMatches(
  templateValue: string,
  concreteValue: string,
): boolean {
  const template = analyzeAcceptanceRoutePath(templateValue);
  const concrete = analyzeAcceptanceRoutePath(concreteValue);
  if (!template.valid || !concrete.valid) return false;

  const templatePath = template.normalized!.split('?')[0];
  const concretePath = concrete.normalized!.split('?')[0];
  const templateParts = templatePath.split('/').slice(1);
  const concreteParts = concretePath.split('/').slice(1);
  let concreteIndex = 0;
  for (const part of templateParts) {
    if (/^\[\[\.\.\.[A-Za-z_][A-Za-z0-9_]*\]\]$/.test(part)) {
      return true;
    }
    if (/^\[\.\.\.[A-Za-z_][A-Za-z0-9_]*\]$/.test(part)) {
      return concreteIndex < concreteParts.length;
    }
    if (
      concreteIndex >= concreteParts.length ||
      (
        part !== concreteParts[concreteIndex] &&
        !COLON_PARAMETER.test(part) &&
        !NEXT_PARAMETER.test(part)
      )
    ) {
      return false;
    }
    concreteIndex++;
  }
  return concreteIndex === concreteParts.length;
}
