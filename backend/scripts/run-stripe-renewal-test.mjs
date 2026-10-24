import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-stripe-renewals.ts'], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, LOG_LEVEL: 'error', QUEUE_PREFIX: `stripe-renewal-qa-${Date.now()}` },
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
