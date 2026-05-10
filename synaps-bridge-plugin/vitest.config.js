import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // ~/.local/bin/node is a shell wrapper that execs via ld-linux directly.
    // child_process.fork() re-execs process.execPath, which the dynamic linker
    // then tries to dlopen as a shared object → EPIPE / exit 127.
    // vmThreads uses worker_threads (in-process) and never re-forks, so it
    // works correctly in this environment.
    pool: 'vmThreads',
    include: ['bridge/**/*.test.js', 'bin/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['bridge/**/*.js'],
      exclude: ['bridge/**/*.test.js'],
      reporter: ['text', 'html'],
      // Per-file thresholds let individual modules set their own bar without
      // failing when sibling task files are stubs with 0% coverage.
      thresholds: {
        'bridge/core/synaps-rpc.js': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
      },
    },
  },
});
