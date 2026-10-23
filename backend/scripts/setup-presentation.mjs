import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
const overrides = {
  PORT: '4001',
  LOG_LEVEL: 'warn',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '2525',
  SMTP_SECURE: 'false',
  SMTP_USER: 'demo',
  SMTP_PASS: 'demo',
  GROQ_MODEL: 'openai/gpt-oss-120b',
  GEMINI_MODEL: 'gemini-3.5-flash-lite',
  RATE_LIMIT_UNAUTH_PER_MIN: '1000',
  QUEUE_PREFIX: 'garments-presentation',
  DEMO_ALLOW_REMOTE: '1',
};
if (process.argv.includes('--local'))
  overrides.MONGO_URI = 'mongodb://127.0.0.1:27018/garments_demo?replicaSet=demo-rs';
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
try {
  const manifest = JSON.parse(await readFile('artifacts/garments-demo-manifest.json', 'utf8'));
  overrides.LOW_STOCK_MONITOR_TENANT_IDS = manifest.tenantId;
} catch {
  // A fresh setup has no presentation tenant until seeding finishes.
}
try {
  await access(chrome);
  overrides.CHROMIUM_EXECUTABLE_PATH = chrome;
} catch {}
let content = await readFile('.env', 'utf8');
for (const [key, value] of Object.entries(overrides)) {
  const pattern = new RegExp(`^${key}=.*$`, 'gm');
  content = pattern.test(content)
    ? content.replace(pattern, `${key}=${value}`)
    : `${content}\n${key}=${value}\n`;
}
await mkdir('artifacts', { recursive: true });
await writeFile('.env.presentation', content);
console.log(
  'Presentation config created from .env; source credentials preserved. SMTP captures locally; queues use an isolated prefix.',
);
