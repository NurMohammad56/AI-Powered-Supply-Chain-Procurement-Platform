import { spawn } from 'node:child_process';

if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
  throw new Error('Local webhook forwarding requires a configured Stripe test key');
}
const target = `http://localhost:${process.env.PORT || 4001}/api/v1/webhooks/stripe`;
const child = spawn('stripe', ['listen', '--skip-update', '--forward-to', target], {
  env: { ...process.env, STRIPE_API_KEY: process.env.STRIPE_SECRET_KEY },
  windowsHide: true,
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (data) => {
    // The signing secret is already configured in the ignored local environment.
    process.stdout.write(data.toString().replace(/whsec_[A-Za-z0-9]+/g, '[signing secret hidden]'));
  });
}
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code || 0;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
