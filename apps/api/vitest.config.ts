import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { exclude: ['dist/**', 'node_modules/**'], execArgv: ['--disable-warning=ExperimentalWarning'] } });
