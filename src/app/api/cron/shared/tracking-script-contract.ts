import ts from 'typescript';

export const HARNESS_TRACKING_SCRIPT_URL =
  'https://backend.makinari.com/tracking.min.js';

export const LEGACY_TRACKING_SCRIPT_URL =
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
  return `<script src="${LEGACY_TRACKING_SCRIPT_URL}" data-site-id="${escapeAttribute(siteId)}"></script>`;
}

export type TrackingScriptTransform = {
  changed: boolean;
  source: string;
  reason: 'inserted' | 'upgraded' | 'repaired' | 'already_marked';
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
  sourceUrl: string;
  sourceStart: number;
  sourceEnd: number;
  ownershipInsert: number;
  ownershipStart?: number;
  ownershipEnd?: number;
  siteId?: string;
  siteIdStart?: number;
  siteIdEnd?: number;
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
    const siteIdAttribute = attributes.find(
      (attribute) => attribute.name.getText(sourceFile) === 'data-site-id',
    );
    if (
      !sourceAttribute ||
      !sourceAttribute.initializer ||
      !ts.isStringLiteral(sourceAttribute.initializer) ||
      ![
        HARNESS_TRACKING_SCRIPT_URL,
        LEGACY_TRACKING_SCRIPT_URL,
      ].includes(sourceAttribute.initializer.text)
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
      sourceUrl: sourceAttribute.initializer.text,
      sourceStart: sourceAttribute.initializer.getStart(sourceFile),
      sourceEnd: sourceAttribute.initializer.getEnd(),
      ownershipInsert:
        openingElement.getEnd() -
        (ts.isJsxSelfClosingElement(openingElement) ? 2 : 1),
      ownershipStart: ownershipAttribute
        ? ownershipAttribute!.getStart(sourceFile)
        : undefined,
      ownershipEnd: ownershipAttribute
        ? ownershipAttribute!.getEnd()
        : undefined,
      siteId:
        siteIdAttribute?.initializer &&
        ts.isStringLiteral(siteIdAttribute.initializer)
          ? siteIdAttribute.initializer.text
          : undefined,
      siteIdStart: siteIdAttribute
        ? siteIdAttribute.getStart(sourceFile)
        : undefined,
      siteIdEnd: siteIdAttribute
        ? siteIdAttribute.getEnd()
        : undefined,
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
    `<script\\s+src=(?:${[
      HARNESS_TRACKING_SCRIPT_URL,
      LEGACY_TRACKING_SCRIPT_URL,
    ].map(escapeRegex).join('|')})\\s+` +
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
    const ownershipAttribute = 'data-uncodie-harness="tracking"';
    const siteIdAttribute = `data-site-id="${escapeAttribute(siteId)}"`;
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const insertions: string[] = [];
    if (existingScript.sourceUrl !== HARNESS_TRACKING_SCRIPT_URL) {
      edits.push({
        start: existingScript.sourceStart,
        end: existingScript.sourceEnd,
        text: JSON.stringify(HARNESS_TRACKING_SCRIPT_URL),
      });
    }
    if (!existingScript.owned) {
      if (
        existingScript.ownershipStart !== undefined &&
        existingScript.ownershipEnd !== undefined
      ) {
        edits.push({
          start: existingScript.ownershipStart,
          end: existingScript.ownershipEnd,
          text: ownershipAttribute,
        });
      } else {
        insertions.push(ownershipAttribute);
      }
    }
    if (existingScript.siteId !== siteId) {
      if (
        existingScript.siteIdStart !== undefined &&
        existingScript.siteIdEnd !== undefined
      ) {
        edits.push({
          start: existingScript.siteIdStart,
          end: existingScript.siteIdEnd,
          text: siteIdAttribute,
        });
      } else {
        insertions.push(siteIdAttribute);
      }
    }
    if (insertions.length) {
      edits.push({
        start: existingScript.ownershipInsert,
        end: existingScript.ownershipInsert,
        text: ` ${insertions.join(' ')}`,
      });
    }
    if (edits.length) {
      return {
        changed: true,
        source: applySourceEdits(source, edits),
        reason: 'upgraded',
      };
    }
    return {
      changed: false,
      source,
      reason: 'already_marked',
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

function applySourceEdits(
  source: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  return edits
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce(
      (current, edit) =>
        current.slice(0, edit.start) + edit.text + current.slice(edit.end),
      source,
    );
}

function restoreOriginalTrackingScript(
  currentSource: string,
  originalSource: string,
): string | null {
  const currentScript = findHarnessTrackingScript(currentSource);
  const originalScript = findHarnessTrackingScript(originalSource);
  if (!currentScript || !originalScript) return null;
  return (
    currentSource.slice(0, currentScript.scriptStart) +
    originalSource.slice(originalScript.scriptStart, originalScript.scriptEnd) +
    currentSource.slice(currentScript.scriptEnd)
  );
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
  if (backup.reason === 'upgraded') {
    const restored = restoreOriginalTrackingScript(
      currentSource,
      backup.originalSource,
    );
    if (restored !== null) return restored;
  }
  if (
    currentSource.includes(markedTag) &&
    (backup.reason === 'inserted' || backup.reason === 'repaired')
  ) {
    return currentSource.replace(markedTag, '');
  }

  const ownedScript = findHarnessTrackingScript(currentSource);
  if (!ownedScript?.owned) return null;
  if (backup.reason === 'inserted' || backup.reason === 'repaired') {
    return (
      currentSource.slice(0, ownedScript.scriptStart) +
      currentSource.slice(ownedScript.scriptEnd)
    );
  }
  return null;
}
