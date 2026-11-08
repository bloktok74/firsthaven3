import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { allowsAnamTestReports, isAnamDemo } from '../shared/anam-demo.ts';

const root = new URL('../', import.meta.url);
const file = path => new URL(path, root);
const enabled = isAnamDemo(process.env);
await mkdir(file('dist'), { recursive: true });
await cp(file('logo.png'), file('dist/logo.png'));
let html = await readFile(file('index.html'), 'utf8');
if (enabled) {
  await cp(file('public'), file('dist'), { recursive: true });
  await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: ['src/assistant/index.ts'],
    outdir: 'dist/assistant',
    entryNames: 'assistant',
    chunkNames: 'chunk-[hash]',
    bundle: true, format: 'esm', splitting: true, minify: true, target: 'es2022',
    define: {
      __ANAM_PREVIEW__: 'true',
      __ANAM_PUBLIC_TEST__: 'false',
      __ANAM_TEST_REPORTS__: JSON.stringify(allowsAnamTestReports(process.env)),
    },
  });
  html = html.replace('</head>', '  <link rel="stylesheet" href="/assistant.css">\n  <script type="module" src="/assistant/assistant.js"></script>\n</head>');
}
await writeFile(file('dist/index.html'), html);
