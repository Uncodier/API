import ts from 'typescript';

export type FormAuditIssue = {
  reason: string;
  confidence: 'high' | 'medium';
};

function attrName(attr: ts.JsxAttributeLike): string {
  return ts.isJsxAttribute(attr) ? attr.name.getText().toLowerCase() : '';
}

function findAttr(
  node: ts.JsxOpeningLikeElement,
  name: string,
): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (attr): attr is ts.JsxAttribute =>
      ts.isJsxAttribute(attr) && attrName(attr) === name,
  );
}

function hasUsableAction(attr?: ts.JsxAttribute): boolean {
  if (!attr?.initializer) return false;
  if (ts.isStringLiteral(attr.initializer)) {
    return attr.initializer.text.trim() !== '' && attr.initializer.text !== '#';
  }
  if (!ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) {
    return false;
  }
  return !/^(?:undefined|null|false)$/.test(
    attr.initializer.expression.getText().trim(),
  );
}

type HandlerEffect =
  'missing' | 'no_effect' | 'prevent_default_only' | 'meaningful';

function functionEffect(
  expression: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): HandlerEffect {
  if (!expression.body) return 'no_effect';
  let sawPreventDefault = false;
  let sawMeaningfulEffect = false;
  const visit = (node: ts.Node) => {
    if (node !== expression && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      if (/(?:^|\.)preventDefault$/.test(callee)) {
        sawPreventDefault = true;
      } else if (!/(?:^|\.)(?:stopPropagation|log|warn|error)$/.test(callee)) {
        sawMeaningfulEffect = true;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      sawMeaningfulEffect = true;
    }
    if (
      (ts.isPrefixUnaryExpression(node) ||
        ts.isPostfixUnaryExpression(node)) &&
      (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      )
    ) {
      sawMeaningfulEffect = true;
    }
    node.forEachChild(visit);
  };
  expression.body.forEachChild(visit);
  if (ts.isCallExpression(expression.body)) visit(expression.body);
  if (sawMeaningfulEffect) return 'meaningful';
  return sawPreventDefault ? 'prevent_default_only' : 'no_effect';
}

function resolveHandlerEffect(
  name: string,
  source: ts.SourceFile,
): HandlerEffect | null {
  let effect: HandlerEffect | null = null;
  const visit = (node: ts.Node) => {
    if (effect) return;
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name
    ) {
      effect = functionEffect(node);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      if (
        ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer)
      ) {
        effect = functionEffect(node.initializer);
        return;
      }
      if (
        ts.isCallExpression(node.initializer) &&
        /^(?:useCallback|useMemo)$/.test(
          node.initializer.expression.getText(),
        )
      ) {
        const callback = node.initializer.arguments[0];
        if (
          callback &&
          (
            ts.isArrowFunction(callback) ||
            ts.isFunctionExpression(callback)
          )
        ) {
          effect = functionEffect(callback);
          return;
        }
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return effect;
}

function submitHandlerEffect(
  attr: ts.JsxAttribute | undefined,
  source?: ts.SourceFile,
): HandlerEffect {
  if (
    !attr?.initializer ||
    !ts.isJsxExpression(attr.initializer) ||
    !attr.initializer.expression
  ) {
    return hasUsableAction(attr) ? 'meaningful' : 'missing';
  }
  const expression = attr.initializer.expression;
  if (ts.isIdentifier(expression) && source) {
    return resolveHandlerEffect(expression.text, source) ?? 'meaningful';
  }
  if (
    !ts.isArrowFunction(expression) &&
    !ts.isFunctionExpression(expression)
  ) {
    return 'meaningful';
  }
  return functionEffect(expression);
}

function countUnnamedNativeControls(form: ts.JsxElement): number {
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText().toLowerCase();
      const isControl = tag === 'input' || tag === 'select' || tag === 'textarea';
      const hasSpread = node.attributes.properties.some(ts.isJsxSpreadAttribute);
      if (isControl && !hasSpread && !findAttr(node, 'name')) count++;
    }
    node.forEachChild(visit);
  };
  form.children.forEach(visit);
  return count;
}

function hasSubmitControl(form: ts.JsxElement): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText().toLowerCase();
      const type = findAttr(node, 'type');
      const literalType = type?.initializer && ts.isStringLiteral(type.initializer)
        ? type.initializer.text.toLowerCase()
        : undefined;
      if (
        (tag === 'button' && literalType !== 'button' && literalType !== 'reset') ||
        (tag === 'input' && literalType === 'submit')
      ) {
        found = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  form.children.forEach(visit);
  return found;
}

export function auditFormElement(
  opening: ts.JsxOpeningLikeElement,
  source?: ts.SourceFile,
): FormAuditIssue[] {
  if (opening.tagName.getText().toLowerCase() !== 'form') return [];
  const action = findAttr(opening, 'action');
  const onSubmit = findAttr(opening, 'onsubmit');
  const usableAction = hasUsableAction(action);
  const handlerEffect = submitHandlerEffect(onSubmit, source);
  const issues: FormAuditIssue[] = [];

  if (handlerEffect === 'prevent_default_only') {
    issues.push({
      reason:
        'Form submit handler only prevents the default submission and performs no transaction',
      confidence: 'high',
    });
  } else if (handlerEffect === 'no_effect') {
    issues.push({
      reason: 'Form submit handler performs no observable action',
      confidence: 'high',
    });
  } else if (
    !usableAction &&
    handlerEffect === 'missing' &&
    ts.isJsxElement(opening.parent) &&
    hasSubmitControl(opening.parent)
  ) {
    issues.push({
      reason:
        'Form has no action or submit handler and cannot complete a transaction',
      confidence: 'high',
    });
  }

  if (
    usableAction &&
    !onSubmit &&
    ts.isJsxElement(opening.parent)
  ) {
    const unnamed = countUnnamedNativeControls(opening.parent);
    if (unnamed > 0) {
      issues.push({
        reason:
          `Form action omits name attributes on ${unnamed} native control(s)`,
        confidence: 'medium',
      });
    }
  }
  return issues;
}
