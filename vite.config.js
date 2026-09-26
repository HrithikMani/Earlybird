import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: path.join(root, 'dist'), emptyOutDir: true },
});
