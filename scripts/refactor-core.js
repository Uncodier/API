import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const baseDir = path.join(process.cwd(), 'src');

function findFiles(dir, ext, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      findFiles(filePath, ext, fileList);
    } else if (filePath.endsWith(ext)) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const allTsFiles = findFiles(baseDir, '.ts');
const routeFiles = allTsFiles.filter(f => f.endsWith('route.ts'));

console.log(`Found ${routeFiles.length} route.ts files.`);

let modifiedCount = 0;

for (const routePath of routeFiles) {
  let content = fs.readFileSync(routePath, 'utf8');
  
  // Find all exported functions that end with 'Core' or similar problematic exports
  // Specifically we look for: export async function \w+Core
  // or export function \w+Core
  // or export interface \w+Params
  
  const coreRegex = /export\s+(?:async\s+)?function\s+(\w+Core.*?)\s*\(/g;
  const matches = [...content.matchAll(coreRegex)];
  
  // Also check for comprehensiveEmailFilter which we saw in email/route.ts
  const emailFilterRegex = /export\s+(?:async\s+)?function\s+(comprehensiveEmailFilter)\s*\(/g;
  matches.push(...content.matchAll(emailFilterRegex));
  
  if (matches.length > 0) {
    console.log(`\nFixing ${routePath}`);
    const dir = path.dirname(routePath);
    const corePath = path.join(dir, 'core.ts');
    
    // We will just do a manual move for these files to avoid messy regex for now?
    // Actually, writing a precise AST parser is better, but maybe regex is enough if we just find the export keywords.
    // Wait, replacing `export async function fooCore` with `async function fooCore` is not enough, 
    // because it might be imported by other files.
  }
}
