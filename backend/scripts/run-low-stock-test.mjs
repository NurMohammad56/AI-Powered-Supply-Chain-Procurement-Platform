import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-low-stock.ts'], {
  stdio: 'inherit',
  env: { ...process.env, QUEUE_PREFIX: `low-stock-qa-${Date.now()}` },
  windowsHide: true,
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
