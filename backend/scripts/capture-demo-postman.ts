import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import { runInNewContext } from 'node:vm';
import { env } from '../src/config/env.js';

const collectionPath = '../postman/garments-demo.collection.json';
const reportPath = 'artifacts/garments-postman-capture-results.json';
const results: Array<{
  folder: string;
  request: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
}> = [];

async function main() {
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(env.SMTP_HOST),
    'Only local SMTP capture is allowed',
  );
  assert.equal(env.QUEUE_PREFIX, 'garments-presentation', 'Use the presentation queue namespace');
  const manifest = JSON.parse(await readFile('artifacts/garments-demo-manifest.json', 'utf8'));
  const collection = JSON.parse(await readFile(collectionPath, 'utf8'));
  const environment = JSON.parse(
    await readFile('../postman/garments-demo.environment.json', 'utf8'),
  );
  const variables = new Map<string, string>(
    environment.values.map((v: any) => [v.key, String(v.value)]),
  );
  assert.match(variables.get('ownerEmail') ?? '', /@garments\.example\.test$/);
  const base = new URL(variables.get('baseUrl')!);
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(base.hostname),
    'Only the local presentation API is allowed',
  );
  assert.equal(base.port, '4001');
  const date = new Date().toISOString();
  variables.set('from', new Date(Date.now() - 180 * 86400_000).toISOString());
  variables.set('to', new Date(Date.now() + 86400_000).toISOString());
  variables.set('future', new Date(Date.now() + 14 * 86400_000).toISOString());
  variables.set('runSuffix', randomUUID().slice(0, 8));
  const resolve = (value: string) =>
    value.replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
      assert.ok(variables.get(key), `Missing variable ${key}`);
      return variables.get(key)!;
    });
  const secretFields =
    /^(accessToken|refreshToken|token|responseToken|emailVerifyToken|emailVerifyTokenHash|passwordHash|resetToken|csrfToken)$/i;
  const sanitize = (value: any): any => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          secretFields.test(key) ? `{{${key}}}` : sanitize(item),
        ]),
      );
    if (typeof value === 'string') {
      return value
        .replace(/(?:sk_(?:test|live)_|whsec_|gsk_)[A-Za-z0-9_-]+/g, '[secret redacted]')
        .replace(/([?&]X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s]+/gi, '$1[redacted]')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '{{accessToken}}');
    }
    return value;
  };
  const addExample = (entry: any, request: any, response: Response, raw: string) => {
    const payload = raw ? JSON.parse(raw) : null;
    const headers = [...response.headers.entries()]
      .filter(
        ([key]) => !['set-cookie', 'content-length', 'authorization'].includes(key.toLowerCase()),
      )
      .map(([key, value]) => ({ key, value: sanitize(value) }));
    const originalRequest = structuredClone(request);
    originalRequest.header = (originalRequest.header ?? []).filter(
      (h: any) => !['authorization', 'cookie'].includes(h.key.toLowerCase()),
    );
    if (originalRequest.body?.raw)
      originalRequest.body.raw = JSON.stringify(
        sanitize(JSON.parse(originalRequest.body.raw)),
        null,
        2,
      );
    // Keep template URLs: supplier tokens and ephemeral request credentials stay out of exports.
    originalRequest.url = entry.request.url;
    entry.response = [
      {
        name: `${response.status} ${response.statusText || STATUS_CODES[response.status]} - real capture ${date.slice(0, 10)}`,
        originalRequest,
        status: response.statusText || STATUS_CODES[response.status],
        code: response.status,
        header: headers,
        body: raw ? JSON.stringify(sanitize(payload), null, 2) : '',
      },
    ];
    return payload;
  };
  const readMailToken = async (rfqNumber: string) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const files = await readdir('.demo-data/mail');
      for (const name of files.reverse()) {
        if (!name.endsWith('.eml')) continue;
        const file = `.demo-data/mail/${name}`;
        if ((await stat(file)).mtimeMs < Date.parse(date) - 5000) continue;
        const mail = (await readFile(file, 'utf8'))
          .replace(/=\r?\n/g, '')
          .replace(/=([A-Fa-f\d]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
        if (!mail.includes(rfqNumber) || !/To:[^\r\n]*sales0@garments\.example\.test/i.test(mail))
          continue;
        const token = mail.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1];
        if (token) return token;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('New RFQ invitation was not captured by local SMTP');
  };
  let identityVerified = false,
    rfqNumber = '';
  const execute = async (entry: any, folder: string) => {
    const template =
      typeof entry.request.url === 'string' ? entry.request.url : entry.request.url.raw;
    if (template.includes('/public/quotations/responses/'))
      variables.set('quoteToken', await readMailToken(rfqNumber));
    if (template.includes('/reports/artifacts/{{reportArtifactId}}/download')) {
      const response = await fetch(base.href + '/reports/artifacts', {
        headers: { Authorization: `Bearer ${variables.get('accessToken')}` },
      });
      const payload: any = await response.json();
      const artifact = payload.data?.find((row: any) => row.status === 'ready');
      assert.ok(artifact, 'A ready report PDF must exist for the download example');
      variables.set('reportArtifactId', artifact._id ?? artifact.id);
    }
    const request = structuredClone(entry.request);
    const url = resolve(template);
    const parsed = new URL(url);
    assert.equal(parsed.origin, base.origin, 'Requests must stay on the presentation API');
    const method = request.method;
    if (method !== 'GET' && !url.endsWith('/auth/login'))
      assert.ok(identityVerified, 'Verify demo tenant before mutations');
    const headers: Record<string, string> = Object.fromEntries(
      (request.header ?? [])
        .filter((h: any) => !h.disabled)
        .map((h: any) => [h.key, resolve(h.value)]),
    );
    if (variables.get('accessToken') && request.auth?.type !== 'noauth')
      headers.Authorization = `Bearer ${variables.get('accessToken')}`;
    if (method === 'POST') headers['Idempotency-Key'] = randomUUID();
    const body = request.body?.raw === undefined ? undefined : resolve(request.body.raw);
    const started = Date.now();
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    const durationMs = Date.now() - started;
    const payload = addExample(entry, request, response, raw);
    const route = parsed.pathname.replace('/api/v1', '');
    results.push({
      folder,
      request: entry.name,
      method,
      route: template.replace('{{baseUrl}}', ''),
      status: response.status,
      durationMs,
    });
    console.log(
      `${response.ok ? 'PASS' : 'FAIL'} ${response.status} ${method} ${route.replace(/\/responses\/[^/]+/, '/responses/[token]')}`,
    );
    assert.ok(response.ok, `${entry.name}: ${response.status} ${payload?.error?.code ?? ''}`);
    if (url.endsWith('/auth/login')) {
      assert.equal(payload.data.user.role, 'owner');
      assert.equal(payload.data.factory.id, manifest.tenantId);
      identityVerified = true;
    }
    if (method === 'POST' && route === '/quotations') rfqNumber = payload.data.number;
    const pm = {
      environment: {
        get: (key: string) => variables.get(key),
        set: (key: string, value: any) => variables.set(key, String(value)),
      },
      collectionVariables: {
        get: (key: string) => variables.get(key),
        set: (key: string, value: any) => variables.set(key, String(value)),
      },
      response: { code: response.status, json: () => payload },
      test: () => undefined,
    };
    for (const event of entry.event ?? [])
      if (event.listen === 'test')
        runInNewContext(event.script.exec.join('\n'), { pm }, { timeout: 1000 });
    // Persist progress so an external-provider interruption never loses earlier captures.
    await writeFile(collectionPath, JSON.stringify(collection, null, 2) + '\n');
  };
  for (const folder of collection.item)
    for (const entry of folder.item) await execute(entry, folder.name);
  assert.equal(results.length, 57, 'Every request in this garments workflow must be captured');
  const privateVariables = new Set(['accessToken', 'refreshToken', 'quoteToken', 'csrfToken']);
  collection.variable = [...variables].map(([key, value]) => ({
    key,
    value: privateVariables.has(key) ? '' : value,
    type: 'string',
  }));
  if (!collection.info.description.includes('SAVED-RESPONSES.bn.md')) {
    collection.info.description +=
      ' Saved Examples are real captured HTTP responses. Viewing needs only this collection import; credentials are redacted. See SAVED-RESPONSES.bn.md.';
  }
  await writeFile(collectionPath, JSON.stringify(collection, null, 2) + '\n');
  for (const variable of environment.values)
    if (!privateVariables.has(variable.key) && variables.has(variable.key))
      variable.value = variables.get(variable.key);
  if (!environment.values.some((v: any) => v.key === 'reportArtifactId'))
    environment.values.push({
      key: 'reportArtifactId',
      value: variables.get('reportArtifactId'),
      enabled: true,
    });
  await writeFile(
    '../postman/garments-demo.environment.json',
    JSON.stringify(environment, null, 2) + '\n',
  );
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        capturedAt: date,
        passed: true,
        requestCount: results.length,
        examples: results.length,
        tenantId: manifest.tenantId,
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Saved ${results.length}/${results.length} real response examples; runtime credentials excluded.`,
  );
}

void main().catch(async (error: unknown) => {
  await writeFile(
    reportPath,
    JSON.stringify(
      { passed: false, results, error: error instanceof Error ? error.message : 'Capture failed' },
      null,
      2,
    ) + '\n',
  );
  console.error(error instanceof Error ? error.message : 'Capture failed');
  process.exitCode = 1;
});
