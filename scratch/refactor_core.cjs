const fs = require('fs');
const path = require('path');

const coreServicesDir = path.join(__dirname, '../src/core/services');
const srcDir = path.join(__dirname, '../src');

const dirsToCreate = [
  'pipelines',
  'analytics',
  'auth',
  'ingestion',
  'retrieval'
];

for (const dir of dirsToCreate) {
  fs.mkdirSync(path.join(coreServicesDir, dir), { recursive: true });
}

const moveMap = [
  // Pipelines
  ['ingestion.service.ts', 'pipelines/ingestion.service.ts'],
  ['query.service.ts', 'pipelines/query.service.ts'],
  ['retrieval-pipeline.service.ts', 'pipelines/retrieval-pipeline.service.ts'],

  // Analytics
  ['auditor.service.ts', 'analytics/auditor.service.ts'],
  ['health.service.ts', 'analytics/health.service.ts'],

  // Auth
  ['auth.service.ts', 'auth/auth.service.ts'],
  ['chat-session.service.ts', 'auth/chat-session.service.ts'],

  // Ingestion
  ['document.service.ts', 'ingestion/document.service.ts'],
  ['file-ingestion.service.ts', 'ingestion/file-ingestion.service.ts'],
  ['site-crawler.service.ts', 'ingestion/site-crawler.service.ts'],
  ['url-loader.service.ts', 'ingestion/url-loader.service.ts'],
  ['chunker.service.ts', 'ingestion/chunker.service.ts'],
  ['chunker', 'ingestion/chunker'], // directory

  // Retrieval
  ['retriever.service.ts', 'retrieval/retriever.service.ts'],
];

for (const [fromStr, toStr] of moveMap) {
  const from = path.join(coreServicesDir, fromStr);
  const to = path.join(coreServicesDir, toStr);
  if (fs.existsSync(from)) {
    fs.renameSync(from, to);
  }
}

// Map of old target words to their new nested folder for regex replace
const pathMapping = {
  'ingestion.service': 'pipelines/ingestion.service',
  'query.service': 'pipelines/query.service',
  'retrieval-pipeline.service': 'pipelines/retrieval-pipeline.service',
  
  'auditor.service': 'analytics/auditor.service',
  'health.service': 'analytics/health.service',

  'auth.service': 'auth/auth.service',
  'chat-session.service': 'auth/chat-session.service',

  'document.service': 'ingestion/document.service',
  'file-ingestion.service': 'ingestion/file-ingestion.service',
  'site-crawler.service': 'ingestion/site-crawler.service',
  'url-loader.service': 'ingestion/url-loader.service',
  'chunker.service': 'ingestion/chunker.service',
  'chunker': 'ingestion/chunker', // e.g. import from '@/core/services/chunker/somefile' -> '@/core/services/ingestion/chunker/somefile'

  'retriever.service': 'retrieval/retriever.service',
};

// Regex Import Updates
const updateImportsInFile = (filePath) => {
  let content = fs.readFileSync(filePath, 'utf-8');
  let originalContent = content;

  // We loop over the mapped replacements
  for (const [oldTarget, newTarget] of Object.entries(pathMapping)) {
    // Escape string for regex if needed, though they don't have dangerous chars (except maybe dot)
    const oldRegex = new RegExp(`@/core/services/${oldTarget.replace(/\./g, '\\.')}\\b`, 'g');
    content = content.replace(oldRegex, `@/core/services/${newTarget}`);
  }

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`Updated imports in: ${filePath}`);
  }
};

const walkSync = (dir, callback) => {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walkSync(fullPath, callback);
    } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
      callback(fullPath);
    }
  }
};

walkSync(srcDir, updateImportsInFile);
console.log("Core services sub-domain restructuring complete!");
