import ts from 'typescript';

export const HARNESS_TRACKING_SCRIPT_URL =
  'https://files.uncodie.com/tracking.min.js';

export const HARNESS_TRACKING_ATTRIBUTE =
  'data-uncodie-harness="tracking"';

export const HARNESS_TRACKING_BACKUP_PATH =
  '/tmp/makinari-tracking-layout-backup.json';

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildHarnessTrackingScriptTag(siteId: string): string {
  return `<script src="${HARNESS_TRACKING_SCRIPT_URL}" data-site-id="${escapeAttribute(siteId)}" ${HARNESS_TRACKING_ATTRIBUTE}></script>`;
}

export function buildLegacyTrackingScriptTag(siteId: string): string {
  return `<script src="${HARNESS_TRACKING_SCRIPT_URL}" data-site-id="${escapeAttribute(siteId)}"></script>`;
}

export type TrackingScriptTransform = {
  changed: boolean;
  source: string;
  reason: 'inserted' | 'upgraded' | 'repaired' | 'already_marked' | 'unowned_existing';
};

export type HarnessTrackingBackup = {
  path: string;
  originalSource: string;
  transformedSource: string;
  reason: TrackingScriptTransform['reason'];
  siteId: string;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findBodyClosingTag(source: string): {
  start: number;
  indent: string;
} {
  const sourceFile = ts.createSourceFile(
    'layout.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const diagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics?: ts.Diagnostic[];
  }).parseDiagnostics || [];
  if (diagnostics.length) {
    throw new Error(
      `Root layout does not parse before tracking injection: ${ts.flattenDiagnosticMessageText(
        diagnostics[0].messageText,
        ' ',
      )}`,
    );
  }

  let closingStart: number | undefined;
  const visit = (node: ts.Node): void => {
    if (
      closingStart === undefined &&
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(sourceFile) === 'body'
    ) {
      closingStart = node.closingElement.getStart(sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (closingStart === undefined) {
    throw new Error('Root layout has no JSX <body> element');
  }

  const lineStart = source.lastIndexOf('\n', closingStart - 1) + 1;
  const linePrefix = source.slice(lineStart, closingStart);
  return {
    start: closingStart,
    indent: linePrefix.match(/^[ \t]*/)?.[0] || '',
  };
}

function findHarnessTrackingScript(source: string): {
  scriptStart: number;
  scriptEnd: number;
  owned: boolean;
  ownershipStart?: number;
  ownershipEnd?: number;
} | null {
  const sourceFile = ts.createSourceFile(
    'layout.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let match: ReturnType<typeof findHarnessTrackingScript> = null;
  const visit = (node: ts.Node): void => {
    if (match) return;
    const openingElement = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (!openingElement) {
      if (!match) ts.forEachChild(node, visit);
      return;
    }
    if (openingElement.tagName.getText(sourceFile) !== 'script') {
      ts.forEachChild(node, visit);
      return;
    }
    const attributes = openingElement.attributes.properties.filter(
      ts.isJsxAttribute,
    );
    const sourceAttribute = attributes.find(
      (attribute) => attribute.name.getText(sourceFile) === 'src',
    );
    const ownershipAttribute = attributes.find(
      (attribute) =>
        attribute.name.getText(sourceFile) === 'data-uncodie-harness',
    );
    if (
      !sourceAttribute ||
      !sourceAttribute.initializer ||
      !ts.isStringLiteral(sourceAttribute.initializer) ||
      sourceAttribute.initializer.text !== HARNESS_TRACKING_SCRIPT_URL
    ) {
      ts.forEachChild(node, visit);
      return;
    }
    const owned = Boolean(
      ownershipAttribute?.initializer &&
      ts.isStringLiteral(ownershipAttribute.initializer) &&
      ownershipAttribute.initializer.text === 'tracking',
    );
    match = {
      scriptStart: node.getStart(sourceFile),
      scriptEnd: node.getEnd(),
      owned,
      ownershipStart: owned
        ? ownershipAttribute!.getStart(sourceFile)
        : undefined,
      ownershipEnd: owned ? ownershipAttribute!.getEnd() : undefined,
    };
  };
  visit(sourceFile);
  return match;
}

export function transformHarnessTrackingScript(
  source: string,
  siteId: string,
): TrackingScriptTransform {
  const markedTag = buildHarnessTrackingScriptTag(siteId);
  if (source.includes(markedTag)) {
    return { changed: false, source, reason: 'already_marked' };
  }

  const legacyTag = buildLegacyTrackingScriptTag(siteId);
  if (source.includes(legacyTag)) {
    return {
      changed: true,
      source: source.replace(legacyTag, markedTag),
      reason: 'upgraded',
    };
  }

  const malformedHarnessTag = new RegExp(
    `<script\\s+src=${escapeRegex(HARNESS_TRACKING_SCRIPT_URL)}\\s+` +
      `data-site-id=${escapeRegex(siteId)}` +
      `(?:\\s+data-uncodie-harness=tracking)?\\s*><\\/script>`,
  );
  if (malformedHarnessTag.test(source)) {
    return {
      changed: true,
      source: source.replace(malformedHarnessTag, markedTag),
      reason: 'repaired',
    };
  }

  const existingScript = findHarnessTrackingScript(source);
  if (existingScript) {
    return {
      changed: false,
      source,
      reason: existingScript.owned ? 'already_marked' : 'unowned_existing',
    };
  }

  const closingBody = findBodyClosingTag(source);
  const insertion = `  ${markedTag}\n${closingBody.indent}`;
  return {
    changed: true,
    source:
      source.slice(0, closingBody.start) +
      insertion +
      source.slice(closingBody.start),
    reason: 'inserted',
  };
}

export function rollbackHarnessTrackingScript(
  currentSource: string,
  backup: HarnessTrackingBackup,
): string | null {
  if (
    currentSource === backup.transformedSource &&
    backup.reason !== 'repaired'
  ) {
    return backup.originalSource;
  }

  const markedTag = buildHarnessTrackingScriptTag(backup.siteId);
  if (currentSource.includes(markedTag) && backup.reason === 'upgraded') {
    return currentSource.replace(
      markedTag,
      buildLegacyTrackingScriptTag(backup.siteId),
    );
  }
  if (
    currentSource.includes(markedTag) &&
    (backup.reason === 'inserted' || backup.reason === 'repaired')
  ) {
    return currentSource.replace(markedTag, '');
  }

  const ownedScript = findHarnessTrackingScript(currentSource);
  if (!ownedScript?.owned) return null;
  if (
    backup.reason === 'upgraded' &&
    ownedScript.ownershipStart !== undefined &&
    ownedScript.ownershipEnd !== undefined
  ) {
    let removeStart = ownedScript.ownershipStart;
    while (
      removeStart > ownedScript.scriptStart &&
      /[ \t]/.test(currentSource[removeStart - 1])
    ) {
      removeStart -= 1;
    }
    return (
      currentSource.slice(0, removeStart) +
      currentSource.slice(ownedScript.ownershipEnd)
    );
  }
  if (backup.reason === 'inserted' || backup.reason === 'repaired') {
    return (
      currentSource.slice(0, ownedScript.scriptStart) +
      currentSource.slice(ownedScript.scriptEnd)
    );
  }
  return null;
}
