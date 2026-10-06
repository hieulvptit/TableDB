// Keep the standalone email-approval browser client in sync with shared transport.
const path = require('node:path');
const root = path.resolve(__dirname, '..');
require('node:module').createRequire(require.resolve('vite/package.json'))('esbuild').buildSync({ entryPoints: [path.join(root, 'packages/shared/src/secure-transport.ts')], bundle: true, format: 'esm', target: 'es2022', minify: true, outfile: path.join(root, 'services/api/internal/securetransport/browser-client.js') });
