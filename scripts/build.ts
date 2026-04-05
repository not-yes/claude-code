import { rm } from 'node:fs/promises';

import {
  banner, define, external, features,
} from './config';

const outdir = 'dist';

const isDevelopment = process.env.NODE_ENV === 'development';

// Clean output directory
await rm(outdir, { recursive: true, force: true });

// Bundle
const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir,
  target: 'node',
  format: 'esm',
  minify: !isDevelopment,
  // compile: true,
  define: define(),
  features,
  banner,
  external,
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// eslint-disable-next-line no-console
console.info('Build success!', result.outputs);
