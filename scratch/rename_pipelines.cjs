const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src');
const pipesDir = path.join(srcDir, 'core/services/pipelines');

const refactors = [
  { old: 'ingestion.service', new: 'ingestion.pipeline' },
  { old: 'query.service', new: 'query.pipeline' },
  { old: 'retrieval-pipeline.service', new: 'retrieval.pipeline' }
];

// 1. Rename files
for (const {old, new: newName} of refactors) {
  const oldPath = path.join(pipesDir, `${old}.ts`);
  const newPath = path.join(pipesDir, `${newName}.ts`);
  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
  }
}

// 2. Regex Import Updates across whole codebase
const updateImportsInFile = (filePath) => {
  let content = fs.readFileSync(filePath, 'utf-8');
  let originalContent = content;

  for (const {old, new: newName} of refactors) {
    // E.g. replace @/core/services/pipelines/query.service -> @/core/services/pipelines/query.pipeline
    const oldRegex = new RegExp(`@/core/services/pipelines/${old.replace(/\./g, '\\.')}\\b`, 'g');
    content = content.replace(oldRegex, `@/core/services/pipelines/${newName}`);
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
console.log("Pipeline suffixes perfectly applied!");
