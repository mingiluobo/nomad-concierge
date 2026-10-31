import { spawn } from 'node:child_process';
import console from 'node:console';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import process from 'node:process';

const require = createRequire(import.meta.url);
const watcher = spawn(process.execPath, [
  require.resolve('tsx/cli'), 'watch',
  '--disable-warning=ExperimentalWarning', '--env-file-if-exists=.env', 'src/server.ts',
], {
  stdio: 'inherit',
  // The watcher relays signals to the API; keep terminal signals from also hitting it directly.
  detached: process.platform !== 'win32',
});
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  watcher.kill(signal);
}
function cleanup() {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
watcher.on('error', (error) => {
  console.error('Development watcher failed to start', error);
  cleanup();
  process.exitCode = 1;
});
watcher.on('exit', (code, signal) => {
  cleanup();
  process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
});
