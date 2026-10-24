import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-subscriptions-stripe.ts'], {
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    LOG_LEVEL: 'error',
    QUEUE_PREFIX: `stripe-qa-${Date.now()}`,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2526',
    SMTP_USER: 'demo',
    SMTP_PASS: 'demo',
    SMTP_SECURE: 'false',
  },
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
