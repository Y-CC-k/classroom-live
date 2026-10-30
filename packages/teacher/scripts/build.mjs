import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runApp } from '../../../scripts/electron-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

await runApp({
  root,
  dev: process.argv.includes('--dev'),
  watch: process.argv.includes('--watch'),
  run: process.argv.includes('--run'),
});
