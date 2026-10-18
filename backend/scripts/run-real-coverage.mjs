import { spawn } from 'node:child_process';
process.loadEnvFile('.env.presentation');
const child = spawn(
  process.execPath,
  ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--coverage', '--runInBand'],
  {
    stdio: 'inherit',
    env: { ...process.env, RUN_REAL_INTEGRATION: '1' },
  },
);
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
