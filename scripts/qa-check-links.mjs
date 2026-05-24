#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const SRC_APP_DIR = path.join(process.cwd(), 'src/app');
const PUBLIC_DIR = path.join(process.cwd(), 'public');

// Recursively get all files
function getAllFiles(dirPath, arrayOfFiles) {
  const files = fs.readdirSync(dirPath);

  arrayOfFiles = arrayOfFiles || [];

  files.forEach(function (file) {
    if (fs.statSync(dirPath + '/' + file).isDirectory()) {
      arrayOfFiles = getAllFiles(dirPath + '/' + file, arrayOfFiles);
    } else {
      arrayOfFiles.push(path.join(dirPath, file));
    }
  });

  return arrayOfFiles;
}

function getAppRoutes() {
  if (!fs.existsSync(SRC_APP_DIR)) return [];

  const files = getAllFiles(SRC_APP_DIR);
  const routeFiles = files.filter(f => f.endsWith('page.tsx') || f.endsWith('page.jsx') || f.endsWith('route.ts') || f.endsWith('route.js'));

  const routes = routeFiles.map(f => {
    // Remove the base path
    let route = f.replace(SRC_APP_DIR, '');
    // Remove /page.tsx, /route.ts etc
    route = route.replace(/\/(page|route)\.(tsx|jsx|ts|js)$/, '');
    if (route === '') route = '/';

    // Remove route groups like /(auth)
    route = route.split('/').filter(segment => !segment.startsWith('(') || !segment.endsWith(')')).join('/');
    if (route === '') route = '/';
    if (!route.startsWith('/')) route = '/' + route;

    // Convert Next.js dynamic routes [id] to regex
    // e.g. /users/[id] -> ^/users/[^/]+$
    // e.g. /docs/[...slug] -> ^/docs/.*$
    let regexStr = route.replace(/\[\.\.\.[^\]]+\]/g, '.*');
    regexStr = regexStr.replace(/\[[^\]]+\]/g, '[^/]+');
    
    return {
      original: route,
      regex: new RegExp(`^${regexStr}$`)
    };
  });

  return routes;
}

function getPublicFiles() {
  if (!fs.existsSync(PUBLIC_DIR)) return [];
  const files = getAllFiles(PUBLIC_DIR);
  return files.map(f => f.replace(PUBLIC_DIR, ''));
}

function extractLinksFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const links = [];
  
  // Find href="..." or href={'...'} or href={`...`}
  // Basic regex for hardcoded paths starting with /
  const regex = /href=['"](\/[^'"]*)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push({ path: match[1], file: filePath, line: content.substring(0, match.index).split('\n').length });
  }

  // Handle template literals if they start with / and don't have variables in the first part
  const tlRegex = /href=\{`(\/[^$`]*)`\}/g;
  while ((match = tlRegex.exec(content)) !== null) {
    links.push({ path: match[1], file: filePath, line: content.substring(0, match.index).split('\n').length });
  }

  return links;
}

function checkLinks() {
  console.log('🔍 Starting static link audit...');
  
  const routes = getAppRoutes();
  const publicFiles = getPublicFiles();
  
  console.log(`Found ${routes.length} app routes and ${publicFiles.length} public files.`);

  // Find all components and pages to scan
  let filesToScan = [];
  if (fs.existsSync(SRC_APP_DIR)) {
    filesToScan = filesToScan.concat(getAllFiles(SRC_APP_DIR).filter(f => f.endsWith('.tsx') || f.endsWith('.jsx')));
  }
  
  const SRC_COMPONENTS_DIR = path.join(process.cwd(), 'src/components');
  if (fs.existsSync(SRC_COMPONENTS_DIR)) {
    filesToScan = filesToScan.concat(getAllFiles(SRC_COMPONENTS_DIR).filter(f => f.endsWith('.tsx') || f.endsWith('.jsx')));
  }

  let brokenLinks = [];
  let checkedCount = 0;

  filesToScan.forEach(file => {
    const links = extractLinksFromFile(file);
    links.forEach(link => {
      // Ignore external links (though our regex only captures / prefixed)
      if (link.path.startsWith('//')) return;
      
      // Strip hash and query params for matching
      let cleanPath = link.path.split('?')[0].split('#')[0];
      if (!cleanPath) cleanPath = '/';

      checkedCount++;
      
      // Check if it matches an app route
      const matchesRoute = routes.some(r => r.regex.test(cleanPath));
      // Check if it matches a public file
      const matchesPublic = publicFiles.includes(cleanPath);

      if (!matchesRoute && !matchesPublic) {
        brokenLinks.push(link);
      }
    });
  });

  if (brokenLinks.length > 0) {
    console.error(`\n❌ Found ${brokenLinks.length} broken links (checked ${checkedCount} total):`);
    brokenLinks.forEach(bl => {
      const relativeFile = bl.file.replace(process.cwd() + '/', '');
      console.error(`  - ${bl.path} (in ${relativeFile}:${bl.line})`);
    });
    console.error('\nPlease fix these links or ensure the route exists.');
    process.exit(1);
  } else {
    console.log(`\n✅ Checked ${checkedCount} links statically. No broken links found!`);
    process.exit(0);
  }
}

checkLinks();
