import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from '../package.json';
import { external } from './config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pkgPath = path.join(__dirname, '../package.json');

// 修改 bin 字段
pkg.bin.sobird = 'dist/cli.js';

// @ts-expect-error: 正常
const dependencies = Object.fromEntries(external.map(dep => [dep, pkg.dependencies[dep]]));
// @ts-expect-error: 正常
pkg.dependencies = dependencies;
// @ts-expect-error: 正常
pkg.devDependencies = {};

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
