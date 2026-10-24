import { defineConfig } from 'vitest/config';

// Next preserves JSX for its compiler; component tests still need TSX transformed.
export default defineConfig({ oxc: { jsx: { runtime: 'automatic' } } });
