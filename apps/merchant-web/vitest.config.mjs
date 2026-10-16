import { defineConfig } from 'vitest/config';

// Next keeps JSX for its own compiler. Vitest transforms TSX for server-rendered page tests.
export default defineConfig({ oxc: { jsx: { runtime: 'automatic' } } });
