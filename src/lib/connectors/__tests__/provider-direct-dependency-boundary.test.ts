import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const base=path.resolve('src/lib/connectors');
function connectorImports(file:string) {
  const src=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  const found=new Set<string>();
  const add=(specifier:string)=>{
    const dep=specifier.startsWith('.')?path.resolve(path.dirname(file),specifier)+'.ts':
      specifier.startsWith('@/lib/connectors/')?path.join(base,specifier.slice('@/lib/connectors/'.length))+'.ts':null;
    if(dep?.startsWith(base+path.sep)&&existsSync(dep)) found.add(dep);
  };
  const walk=(n:ts.Node)=>{
    if(ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text);
    if(ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text);
    if(ts.isCallExpression(n) && n.expression.kind===ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) add(n.arguments[0].text);
    ts.forEachChild(n,walk);
  };
  walk(src);return found;
}

it('does not pull legacy reviewed slugs, reporting, per-tool profiles or public-channel policy into the direct host',()=>{
  const visited=new Set<string>();
  function visit(file:string) {if(!visited.has(file)){visited.add(file);for(const dep of connectorImports(file))visit(dep);}}
  for(const entry of ['tool-resolver','host-context','skill-discovery']) visit(path.join(base,entry+'.ts'));
  const modules=[...visited].map(file=>path.basename(file,'.ts'));
  expect(modules).toEqual(expect.arrayContaining(['provider-direct-runtime','provider-direct-policy','provider-direct-transport','provider-direct-receipt']));
  expect(modules.filter(name=>/^(?:runtime$|reviewed-|supabase-(?:report|select|analytics)|catalog-read-|support-runtime|private-report-choice$|action-policy$)/.test(name))).toEqual([]);
});