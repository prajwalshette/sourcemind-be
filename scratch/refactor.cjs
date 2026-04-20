const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src');

// 1. Create Directories
const dirsToCreate = [
  'api/routes',
  'api/controllers',
  'api/middlewares',
  'api/validators',
  'ai/providers',
  'ai/agents',
  'ai/chains',
  'core/services',
  'core/types',
  'core/exceptions',
  'infrastructure/database',
  'infrastructure/vectordb',
  'infrastructure/queue',
];

for (const dir of dirsToCreate) {
  fs.mkdirSync(path.join(srcDir, dir), { recursive: true });
}

// 2. File Moves
const moveMap = [
  // API
  ['routes', 'api/routes'],
  ['controllers', 'api/controllers'],
  ['middlewares', 'api/middlewares'],
  ['schemas', 'api/validators'],
  ['dtos', 'api/validators'], // Moving dtos directly into validators per diagram

  // Interfaces -> Types
  ['interfaces', 'core/types'],
  
  // Exceptions
  ['exceptions', 'core/exceptions'],

  // Infrastructure Services
  ['jobs/ingestion.queue.ts', 'infrastructure/queue/ingestion.queue.ts'],
  ['utils/prisma.ts', 'infrastructure/database/prisma.client.ts'],
  ['utils/redis.ts', 'infrastructure/database/redis.client.ts'],
  ['services/qdrant.service.ts', 'infrastructure/vectordb/qdrant.client.ts'],

  // AI Providers & Chains
  ['services/embedder.service.ts', 'ai/providers/embedder.service.ts'],
  ['services/generator.service.ts', 'ai/providers/generator.service.ts'],
  ['services/intelligence.service.ts', 'ai/agents/intelligence.service.ts'],
  ['services/query-decomposer.service.ts', 'ai/chains/query-decomposer.service.ts'],
  ['services/query-expansion.service.ts', 'ai/chains/query-expansion.service.ts'],
  ['services/sparse-encoder.ts', 'ai/chains/sparse-encoder.ts'],

  // Tracing
  ['tracing/langsmith.ts', 'config/tracing.ts'],
];

for (const [fromStr, toStr] of moveMap) {
  const from = path.join(srcDir, fromStr);
  const to = path.join(srcDir, toStr);
  
  if (fs.existsSync(from)) {
    // If it's a directory like 'routes', we move its contents
    if (fs.statSync(from).isDirectory()) {
      const files = fs.readdirSync(from);
      for (const file of files) {
        fs.renameSync(path.join(from, file), path.join(to, file));
      }
      // Try string safe removal if empty
      try { fs.rmdirSync(from); } catch(e){}
    } else {
      fs.renameSync(from, to);
    }
  } else {
      console.log(`Warning: ${fromStr} not found!`);
  }
}

// Move leftover services into core/services
const remainingServicesDir = path.join(srcDir, 'services');
if (fs.existsSync(remainingServicesDir)) {
  const traverseAndMove = (currentDir, targetDir) => {
    if (!fs.existsSync(currentDir)) return;
    const files = fs.readdirSync(currentDir);
    for (const file of files) {
      const fullPath = path.join(currentDir, file);
      const targetPath = path.join(targetDir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        traverseAndMove(fullPath, targetPath);
        try { fs.rmdirSync(fullPath); } catch(e){}
      } else {
        fs.renameSync(fullPath, targetPath);
      }
    }
  };
  traverseAndMove(remainingServicesDir, path.join(srcDir, 'core/services'));
  try { fs.rmdirSync(remainingServicesDir); } catch(e){}
}

// Let's remove old dirs if they are empty
['jobs', 'tracing'].forEach(dir => {
    try { fs.rmdirSync(path.join(srcDir, dir)); } catch(e){}
})

// 3. Regex Import Updates
const updateImportsInFile = (filePath) => {
  let content = fs.readFileSync(filePath, 'utf-8');
  let originalContent = content;

  // Replace base aliases
  content = content.replace(/@controllers\//g, '@/api/controllers/');
  content = content.replace(/@routes\//g, '@/api/routes/');
  content = content.replace(/@middlewares\//g, '@/api/middlewares/');
  content = content.replace(/@schemas\//g, '@/api/validators/');
  content = content.replace(/@dtos\//g, '@/api/validators/');
  content = content.replace(/@interfaces\//g, '@/core/types/');
  content = content.replace(/@exceptions\//g, '@/core/exceptions/');
  content = content.replace(/@jobs\/ingestion\.queue/g, '@/infrastructure/queue/ingestion.queue');

  // Handle Utils
  content = content.replace(/@utils\/prisma/g, '@/infrastructure/database/prisma.client');
  content = content.replace(/@utils\/redis/g, '@/infrastructure/database/redis.client');

  // Handle Tracing
  content = content.replace(/tracing\/langsmith/g, 'config/tracing');

  // Specific AI Services mapping
  content = content.replace(/@services\/(embedder|generator)\.service/g, '@/ai/providers/$1.service');
  content = content.replace(/@services\/intelligence\.service/g, '@/ai/agents/intelligence.service');
  content = content.replace(/@services\/(query-decomposer|query-expansion)\.service/g, '@/ai/chains/$1.service');
  content = content.replace(/@services\/sparse-encoder/g, '@/ai/chains/sparse-encoder');

  // Infrastructure Service mapping
  content = content.replace(/@services\/qdrant\.service/g, '@/infrastructure/vectordb/qdrant.client');

  // Everything else in @services goes to core/services
  content = content.replace(/@services\//g, '@/core/services/');

  // Relative path fix (since some files might use relative imports)
  // E.g., import ... from "../utils/logger"
  // Since we use aliases primarily, checking if we need to fix relative paths too
  // Most files in this project use aliases based on tsconfig.json.
  // One manual replace for langsmith in server
  content = content.replace(/['"]\.\/tracing\/langsmith['"]/g, '"./config/tracing"');

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`Updated imports in: ${filePath}`);
  }
};

const walkSync = (dir, callback) => {
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
console.log("Restructuring complete!");
