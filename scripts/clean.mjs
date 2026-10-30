import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd());

const TARGETS = ['dist', 'build', 'node_modules'];

for (const dir of ['packages']) {
  for (const pkg of await readdir(path.join(root, dir))) {
    for (const target of TARGETS) {
      const full = path.join(root, dir, pkg, target);
      try {
        await rm(full, { recursive: true, force: true });
        console.log(`removed ${path.relative(root, full)}`);
      } catch {
        // 不存在就略過
      }
    }
  }
}

console.log('clean 完成');
