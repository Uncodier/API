import ts from 'typescript';
import { routeFromAppFile } from './step-app-route';
import type {
  AuditedInternalLink,
  UnresolvedInternalLink,
} from './step-interaction-links';
import type { AddedLines } from './step-interaction-diff';
export { routeFromAppFile } from './step-app-route';
export {
  parseAddedLines,
  parseChangedTargets,
} from './step-interaction-diff';
export type InteractionFindingKind = 'broken_link' | 'inert_control';
export type InteractionConfidence = 'high' | 'medium';
export type InteractionDisposition = 'repair' | 'create_backlog' | 'deferred' | 'warning';
export interface InteractionFinding {
  fingerprint: string;
  kind: InteractionFindingKind;
  file: string;
  line: number;
  element: string;
  label?: string;
  target?: string;
  reason: string;
  confidence: InteractionConfidence;
  introduced_by_step: boolean;
  disposition: InteractionDisposition;
  backlog_item_id?: string;
}

export interface InteractionSignal {
  ok: boolean;
  evaluable?: boolean;
  audited_files?: string[];
  links?: AuditedInternalLink[];
  unresolved_links?: UnresolvedInternalLink[];
  findings: InteractionFinding[];
  blocking_count: number;
  deferred_count: number;
  warning_count: number;
  remediation_required?: boolean;
  remediation_item_ids?: string[];
  active_item_suspended?: boolean;
  summary: string;
}

const PUBLIC_ASSET_RE = /\.[a-z0-9]{2,8}$/i;
const ACTION_ATTRS = new Set([
  'onclick',
  'onsubmit',
  'onchange',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onpointerdown',
  'onmousedown',
  'formaction',
  'href',
  'popovertarget',
]);

function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function attrName(attr: ts.JsxAttributeLike): string {
  return ts.isJsxAttribute(attr) ? attr.name.getText().toLowerCase() : '';
}

function findAttr(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (attr): attr is ts.JsxAttribute => ts.isJsxAttribute(attr) && attrName(attr) === name,
  );
}

function literalAttr(attr?: ts.JsxAttribute): string | null {
  if (!attr?.initializer) return attr ? '' : null;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (!ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) return null;
  const expr = attr.initializer.expression;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return null;
}

function hasMeaningfulAction(node: ts.JsxOpeningLikeElement): boolean {
  for (const attr of node.attributes.properties) {
    const name = attrName(attr);
    if (!ACTION_ATTRS.has(name)) continue;
    if (!ts.isJsxAttribute(attr) || name !== 'onclick') return true;
    const text = attr.initializer?.getText() || '';
    if (/^\{\s*(?:undefined|null|false)\s*\}$/.test(text)) continue;
    if (!/=>\s*\{\s*\}/.test(text) && !/=>\s*(?:console\.\w+|event\.preventDefault)\s*\(/.test(text)) {
      return true;
    }
  }
  return false;
}

function hasActionAncestor(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      const opening = current.openingElement;
      const href = literalAttr(findAttr(opening, 'href'));
      const tag = opening.tagName.getText().toLowerCase();
      if (
        /(?:trigger|close|toggle|menuitem)$/i.test(tag) ||
        (hasMeaningfulAction(opening) && href !== '#' && href !== '')
      ) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isInsideForm(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) &&
      current.getFirstToken()?.getText().toLowerCase() === '<'
    ) {
      const opening = ts.isJsxElement(current) ? current.openingElement : current;
      if (opening.tagName.getText().toLowerCase() === 'form') return true;
    }
    current = current.parent;
  }
  return false;
}

function hasActionDescendant(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
      if (hasMeaningfulAction(child)) {
        found = true;
        return;
      }
    }
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return found;
}

function cleanInternalTarget(raw: string): string | null {
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  const clean = value.split('#')[0].split('?')[0] || '/';
  return clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
}

export function routePattern(route: string): RegExp {
  if (route === '/') return /^\/?$/;
  const body = route
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return '(?:/.*)?';
      if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return '/.+';
      if (/^\[[^\]]+\]$/.test(segment)) return '/[^/]+';
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  return new RegExp(`^${body}/?$`);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function compactLabel(node: ts.Node, source: ts.SourceFile): string | undefined {
  const text = node
    .getText(source)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 100) : undefined;
}

function classTokens(node: ts.JsxOpeningLikeElement): string[] {
  return (literalAttr(findAttr(node, 'classname')) || '').split(/\s+/).filter(Boolean);
}

function isReusableInteractionClass(token: string): boolean {
  if (token.length < 3 || token.includes(':') || token.includes('[')) return false;
  return !/^(?:flex|grid|block|inline|relative|absolute|fixed|sticky|hidden|w-|h-|min-|max-|p[trblxy]?-|m[trblxy]?-|text-|bg-|border|rounded|shadow|gap-|space-|items-|justify-|self-|font-|leading-|tracking-|transition|duration|opacity|overflow|z-)/.test(
    token,
  );
}

export function collectActionClassNames(file: string, content: string): Set<string> {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const classes = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source).toLowerCase();
      const type = literalAttr(findAttr(node, 'type'))?.toLowerCase();
      const href = literalAttr(findAttr(node, 'href'));
      const placeholderHref = href === '' || href === '#' || /^javascript:/i.test(href || '');
      const submits = type === 'submit' || (tag === 'button' && isInsideForm(node) && type !== 'button');
      if ((hasMeaningfulAction(node) && !placeholderHref) || submits) {
        for (const token of classTokens(node)) {
          if (isReusableInteractionClass(token)) classes.add(token);
        }
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return classes;
}

function wasIntroduced(file: string, node: ts.Node, source: ts.SourceFile, addedLines: AddedLines): boolean {
  const lines = addedLines.get(file);
  if (lines === '*') return true;
  if (!lines) return false;
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  for (let line = start; line <= end; line++) {
    if (lines.has(line)) return true;
  }
  return false;
}

function makeFinding(input: Omit<InteractionFinding, 'fingerprint'>): InteractionFinding {
  const identity = input.target
    ? `${input.kind}:${input.target}`
    : `${input.kind}:${input.file}:${input.element}:${input.label || ''}`;
  return {
    ...input,
    fingerprint: hash(identity),
  };
}

export function auditInteractionSource(params: {
  file: string;
  content: string;
  routePatterns: RegExp[];
  publicFiles: Set<string>;
  addedLines: AddedLines;
  changedTargets?: Set<string>;
  interactiveClassNames?: Set<string>;
}): InteractionFinding[] {
  const source = ts.createSourceFile(
    params.file,
    params.content,
    ts.ScriptTarget.Latest,
    true,
    params.file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: InteractionFinding[] = [];

  const addBrokenLink = (
    node: ts.Node,
    element: string,
    rawTarget: string,
    confidence: InteractionConfidence = 'high',
  ) => {
    const target = cleanInternalTarget(rawTarget);
    if (!target) return;
    const exists =
      params.publicFiles.has(target) || params.routePatterns.some((pattern) => pattern.test(target));
    if (exists) return;
    const line = lineOf(source, node);
    const missingPage = !PUBLIC_ASSET_RE.test(target);
    findings.push(makeFinding({
      kind: 'broken_link',
      file: params.file,
      line,
      element,
      label: compactLabel(node.parent, source),
      target,
      reason: missingPage
        ? `No Next.js page matches ${target}`
        : `No public asset matches ${target}`,
      confidence,
      introduced_by_step:
        wasIntroduced(params.file, node, source, params.addedLines) ||
        !!params.changedTargets?.has(target),
      disposition: missingPage ? 'create_backlog' : 'repair',
    }));
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression.getText(source);
      const navigationReceiver =
        /(?:^|\.)(?:router|navigation|nav)$/.test(receiver) ||
        receiver === 'window.location' ||
        receiver === 'location';
      if (navigationReceiver && (method === 'push' || method === 'replace')) {
        const first = node.arguments[0];
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          addBrokenLink(node, `${node.expression.expression.getText(source)}.${method}`, first.text);
        }
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replace(/['"]/g, '').toLowerCase();
      const value = node.initializer;
      if (
        (name === 'href' || name === 'to') &&
        (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
      ) {
        addBrokenLink(node, `${name} configuration`, value.text, 'medium');
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      const lowerTag = tag.toLowerCase();
      const href = literalAttr(findAttr(node, 'href'));
      if (href !== null && href !== '') addBrokenLink(node, tag, href);

      const className = literalAttr(findAttr(node, 'classname')) || '';
      const role = literalAttr(findAttr(node, 'role'))?.toLowerCase();
      const type = literalAttr(findAttr(node, 'type'))?.toLowerCase();
      const disabled = !!findAttr(node, 'disabled');
      const hasSpreadAttributes = node.attributes.properties.some(ts.isJsxSpreadAttribute);
      const inputButton =
        lowerTag === 'input' && (type === 'button' || type === 'submit' || type === 'reset');
      const semanticButton = lowerTag === 'button' || inputButton;
      const linkElement = lowerTag === 'a' || lowerTag === 'link' || lowerTag.endsWith('.link');
      const placeholderHref = href === '' || href === '#' || /^javascript:/i.test(href || '');
      const anchorWithoutHref = lowerTag === 'a' && !findAttr(node, 'href');
      const tokens = classTokens(node);
      const learnedInteractionClass = tokens.some((token) =>
        params.interactiveClassNames?.has(token),
      );
      const semanticInteractionClass = tokens.some((token) =>
        /(?:^|[-_])(?:btn|button|cta|link|action|trigger|control|clickable)(?:$|[-_])/i.test(token),
      );
      const looksInteractive =
        semanticButton ||
        anchorWithoutHref ||
        (linkElement && placeholderHref) ||
        role === 'button' ||
        learnedInteractionClass ||
        semanticInteractionClass ||
        /(?:^|\s)(?:btn(?:-\S+)?|cursor-pointer)(?:\s|$)/.test(className);
      const submit =
        type === 'submit' ||
        type === 'reset' ||
        (semanticButton && isInsideForm(node) && type !== 'button');
      const composedAction = !!findAttr(node, 'aschild') && hasActionDescendant(node.parent);

      if (
        looksInteractive &&
        !disabled &&
        !submit &&
        !composedAction &&
        !hasActionAncestor(node) &&
        (placeholderHref || !hasMeaningfulAction(node))
      ) {
        const line = lineOf(source, node);
        const definitelyInteractive =
          semanticButton ||
          anchorWithoutHref ||
          placeholderHref ||
          role === 'button' ||
          semanticInteractionClass;
        const confidence: InteractionConfidence =
          definitelyInteractive && !hasSpreadAttributes ? 'high' : 'medium';
        findings.push(makeFinding({
          kind: 'inert_control',
          file: params.file,
          line,
          element: tag,
          label: compactLabel(node.parent, source),
          reason: placeholderHref
            ? 'Link uses an empty or placeholder destination'
            : anchorWithoutHref
            ? 'Anchor looks interactive but has no href'
            : 'Control looks interactive but has no action, link, or form submission',
          confidence,
          introduced_by_step: wasIntroduced(
            params.file,
            node,
            source,
            params.addedLines,
          ),
          disposition: confidence === 'high' ? 'repair' : 'warning',
        }));
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return findings;
}

export function summarizeInteractionFindings(findings: InteractionFinding[]): InteractionSignal {
  const blocking = findings.filter(
    (finding) =>
      finding.introduced_by_step &&
      finding.confidence === 'high' &&
      finding.disposition !== 'deferred',
  );
  const deferred = findings.filter((finding) => finding.disposition === 'deferred');
  const warnings = findings.filter((finding) => !blocking.includes(finding) && !deferred.includes(finding));
  const remediationItemIds = Array.from(new Set(
    deferred
      .map((finding) => finding.backlog_item_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  ));
  return {
    ok: blocking.length === 0 && deferred.length === 0,
    findings,
    blocking_count: blocking.length,
    deferred_count: deferred.length,
    warning_count: warnings.length,
    remediation_required: deferred.length > 0,
    remediation_item_ids: remediationItemIds,
    summary: `${blocking.length} blocking, ${deferred.length} scheduled remediation, ${warnings.length} warning interaction finding(s)`,
  };
}

export function formatInteractionFailure(signal: InteractionSignal): string {
  const lines = signal.findings
    .filter(
      (finding) =>
        finding.disposition === 'deferred' ||
        finding.introduced_by_step,
    )
    .slice(0, 20)
    .map((finding) => {
      const target = finding.target ? ` target=${finding.target}` : '';
      const backlog = finding.backlog_item_id
        ? ` remediation=${finding.backlog_item_id}`
        : '';
      return `- ${finding.file}:${finding.line} [${finding.kind}/${finding.confidence}] ${finding.reason}${target}${backlog}`;
    });
  if (signal.remediation_required) {
    const handoff = signal.active_item_suspended
      ? 'The active item is suspended until the remediation backlog item passes its own gates.'
      : 'Remediation backlog work was scheduled, while the active item remains responsible for its other blocking findings.';
    return [
      `Interaction remediation scheduled: ${signal.summary}.`,
      ...lines,
      handoff,
    ].join('\n');
  }
  return [
    `Interaction audit failed: ${signal.summary}.`,
    ...lines,
    'Repair these local defects in this cycle. Implement a missing route only when the active item contract requires it; otherwise remove the invalid navigation.',
    'Out-of-contract missing routes are handled as deduplicated backlog work and must not expand this item.',
  ].join('\n');
}
