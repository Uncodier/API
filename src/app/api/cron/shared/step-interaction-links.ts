import ts from 'typescript';

export type InteractionLinkRegion =
  | 'header'
  | 'footer'
  | 'navigation'
  | 'other';

export interface AuditedInternalLink {
  file: string;
  line: number;
  element: string;
  target: string;
  region: InteractionLinkRegion;
  route_exists: boolean;
  source_binding?: string;
}

export interface UnresolvedInternalLink {
  file: string;
  line: number;
  element: string;
  region: InteractionLinkRegion;
  source_binding?: string;
}

function attributeName(attribute: ts.JsxAttributeLike): string {
  return ts.isJsxAttribute(attribute)
    ? attribute.name.getText().toLowerCase()
    : '';
}

function findAttribute(
  node: ts.JsxOpeningLikeElement,
  name: string,
): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) && attributeName(attribute) === name,
  );
}

function literalAttribute(attribute?: ts.JsxAttribute): string | null {
  if (!attribute?.initializer) return attribute ? '' : null;
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text;
  }
  if (
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression
  ) {
    return null;
  }
  const expression = attribute.initializer.expression;
  return ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : null;
}

function normalizeInternalTarget(raw: string): string | null {
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  const target = value.split('#')[0].split('?')[0] || '/';
  return target.length > 1 ? target.replace(/\/+$/, '') : target;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function linkRegion(node: ts.Node): InteractionLinkRegion {
  let current: ts.Node | undefined = node;
  let insideNavigation = false;
  while (current) {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      const opening = ts.isJsxElement(current)
        ? current.openingElement
        : current;
      const tag = opening.tagName.getText().toLowerCase();
      if (tag === 'footer') return 'footer';
      if (tag === 'header') return 'header';
      if (tag === 'nav') insideNavigation = true;
    }
    current = current.parent;
  }
  return insideNavigation ? 'navigation' : 'other';
}

function enclosingVariableBinding(
  node: ts.Node,
  property: string,
  file: string,
): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name)
    ) {
      return `${file}#${current.name.text}:${property}`;
    }
    current = current.parent;
  }
  return undefined;
}

function mappedHrefBinding(
  attribute: ts.JsxAttribute,
  file: string,
  importBindings: Record<string, string>,
): string | undefined {
  const initializer = attribute.initializer;
  if (
    !initializer ||
    !ts.isJsxExpression(initializer) ||
    !initializer.expression ||
    !ts.isPropertyAccessExpression(initializer.expression)
  ) {
    return undefined;
  }
  const itemName = initializer.expression.expression.getText();
  const property = initializer.expression.name.text;
  let current: ts.Node | undefined = attribute.parent;
  while (current) {
    if (
      ts.isArrowFunction(current) &&
      current.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === itemName,
      )
    ) {
      const call = current.parent;
      if (
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'map'
      ) {
        const collection = call.expression.expression.getText();
        const qualifiedCollection =
          importBindings[collection] || `${file}#${collection}`;
        return `${qualifiedCollection}:${property}`;
      }
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

export function auditInternalLinks(params: {
  file: string;
  content: string;
  routePatterns: RegExp[];
  publicFiles: Set<string>;
  importBindings?: Record<string, string>;
}): {
  links: AuditedInternalLink[];
  unresolved: UnresolvedInternalLink[];
} {
  const source = ts.createSourceFile(
    params.file,
    params.content,
    ts.ScriptTarget.Latest,
    true,
    params.file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const links: AuditedInternalLink[] = [];
  const unresolved: UnresolvedInternalLink[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replace(/['"]/g, '').toLowerCase();
      if (
        (name === 'href' || name === 'to') &&
        (
          ts.isStringLiteral(node.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(node.initializer)
        )
      ) {
        const target = normalizeInternalTarget(node.initializer.text);
        if (target) {
          links.push({
            file: params.file,
            line: lineOf(source, node),
            element: `${name} configuration`,
            target,
            region: 'other',
            route_exists:
              params.publicFiles.has(target) ||
              params.routePatterns.some((pattern) => pattern.test(target)),
            source_binding: enclosingVariableBinding(
              node,
              name,
              params.file,
            ),
          });
        }
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const hrefAttribute = findAttribute(node, 'href');
      if (hrefAttribute) {
        const element = node.tagName.getText(source);
        const region = linkRegion(node);
        const href = literalAttribute(hrefAttribute);
        if (href === null) {
          unresolved.push({
            file: params.file,
            line: lineOf(source, node),
            element,
            region,
            source_binding: mappedHrefBinding(
              hrefAttribute,
              params.file,
              params.importBindings || {},
            ),
          });
        } else {
          const target = normalizeInternalTarget(href);
          if (target) {
            links.push({
              file: params.file,
              line: lineOf(source, node),
              element,
              target,
              region,
              route_exists:
                params.publicFiles.has(target) ||
                params.routePatterns.some((pattern) => pattern.test(target)),
            });
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);

  return { links, unresolved };
}
