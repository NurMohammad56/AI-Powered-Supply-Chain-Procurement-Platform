import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  let previous: any;
  try {
    previous = JSON.parse(await readFile('../postman/garments-demo.collection.json', 'utf8'));
  } catch {
    // A fresh checkout can generate a collection before capturing any examples.
  }
  const m = JSON.parse(await readFile('artifacts/garments-demo-manifest.json', 'utf8'));
  const values: Record<string, string> = {
    baseUrl: m.baseUrl,
    frontendUrl: 'http://localhost:3000',
    accessToken: '',
    tenantId: m.tenantId,
    ownerEmail: m.users.owner,
    password: m.password,
    warehouseId: m.warehouses[0].id,
    secondWarehouseId: m.warehouses[1].id,
    categoryId: m.categories[0].id,
    itemId: m.items[0].id,
    secondItemId: m.items[1].id,
    supplierId: m.suppliers[0].id,
    secondSupplierId: m.suppliers[1].id,
    quotationId: m.quotations[0].id,
    forecastId: m.forecasts.find((f: any) => !f.provenance?.fallback)?.id ?? '',
    poId: m.purchaseOrders.find((p: any) => p.state === 'draft')?.id ?? '',
    poLineId: '',
    quoteToken: '',
    csrfToken: '',
    from: new Date(Date.now() - 180 * 86400000).toISOString(),
    to: new Date(Date.now() + 86400000).toISOString(),
    future: new Date(Date.now() + 14 * 86400000).toISOString(),
    runSuffix: Date.now().toString(36),
    reportArtifactId:
      previous?.variable?.find((v: any) => v.key === 'reportArtifactId')?.value ?? '',
  };
  const environment = {
    id: 'garments-presentation',
    name: 'Bangladesh Garments - Presentation',
    _postman_variable_scope: 'environment',
    values: Object.entries(values).map(([key, value]) => ({
      key,
      value,
      enabled: true,
      type: ['password', 'accessToken', 'quoteToken'].includes(key) ? 'secret' : 'default',
    })),
  };
  const request = (
    name: string,
    method: string,
    url: string,
    body?: any,
    save?: string,
    expected = [200, 201, 202, 204],
  ) => ({
    name,
    request: {
      method,
      header: body === undefined ? [] : [{ key: 'Content-Type', value: 'application/json' }],
      url: '{{baseUrl}}' + url,
      ...(body === undefined ? {} : { body: { mode: 'raw', raw: JSON.stringify(body, null, 2) } }),
    },
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            `pm.test('Expected HTTP status', () => pm.expect(${JSON.stringify(expected)}).to.include(pm.response.code));`,
            ...(save
              ? [
                  `if (pm.response.code < 300) { const d=pm.response.json().data; const setVar=(k,v)=>{pm.collectionVariables.set(k,v);try{pm.environment.set(k,v);}catch{}}; ${save.replaceAll('pm.environment.set', 'setVar')} }`,
                ]
              : []),
          ],
        },
      },
    ],
  });
  const login = request(
    'Login as demo owner',
    'POST',
    '/auth/login',
    { email: '{{ownerEmail}}', password: '{{password}}' },
    "pm.environment.set('accessToken',d.accessToken); pm.environment.set('userId',d.user.id);",
    [200],
  );
  (login.request as any).auth = { type: 'noauth' };
  const presentation = [
    ['/auth/me', 'Owner profile'],
    ['/auth/users', 'All demo roles'],
    ['/inventory/warehouses', 'Gazipur, Savar, Chattogram stores'],
    ['/inventory/categories', 'Garments categories'],
    ['/inventory/items?limit=100', 'Garments catalogue'],
    ['/inventory/low-stock', 'Low-stock warnings'],
    ['/inventory/items/{{itemId}}/balances', 'Item stock across stores'],
    ['/inventory/items/{{itemId}}/history?limit=100', 'Actual movement ledger'],
    ['/suppliers?limit=100', 'Bangladesh demo suppliers'],
    ['/suppliers/{{supplierId}}/performance', 'Supplier performance'],
    ['/suppliers/compare?ids={{supplierId}},{{secondSupplierId}}', 'Supplier comparison'],
    ['/quotations', 'RFQ history'],
    ['/quotations/{{quotationId}}', 'RFQ with submitted offers'],
    ['/purchase-orders?limit=100', 'All PO states'],
    ['/ai/forecasts?limit=100', 'Saved live AI forecasts'],
    ['/ai/forecasts/{{forecastId}}', 'Forecast detail'],
    ['/ai/forecasts/{{forecastId}}/evaluation', 'Forecast evaluation'],
    ['/ai/forecasts/{{forecastId}}/visualization', 'Forecast chart data'],
    ['/ai/insights', 'Persisted AI comparisons and briefs'],
    ['/ai/usage', 'AI quota and usage'],
    ['/reports/inventory-turnover?from={{from}}&to={{to}}', 'Inventory turnover'],
    ['/reports/spend-by-supplier?from={{from}}&to={{to}}', 'Supplier spend'],
    ['/reports/supplier-cost-comparison?from={{from}}&to={{to}}', 'Cost comparison'],
    ['/reports/dead-stock?from={{from}}&to={{to}}', 'Dead stock'],
    ['/reports/abc-analysis?from={{from}}&to={{to}}', 'ABC classification'],
    ['/reports/eoq?itemId={{itemId}}&orderingCost=1500&holdingCostRate=0.2', 'EOQ recommendation'],
    ['/reports/cash-flow-projection', 'Cash flow'],
    ['/reports/budget', 'Procurement budget'],
    ['/reports/artifacts', 'Generated report PDFs'],
    ['/notifications', 'Notification feed'],
    ['/notifications/unread-count', 'Unread count'],
    ['/billing/plans', 'Plans'],
    ['/billing/subscription', 'Presentation subscription (Enterprise demo)'],
    ['/billing/invoices', 'Synthetic invoice examples'],
  ].map(([url, name]) => request(name!, 'GET', url!));
  const poBody = {
    supplierId: '{{supplierId}}',
    warehouseId: '{{warehouseId}}',
    currency: 'BDT',
    paymentTermsDays: 30,
    expectedDeliveryAt: '{{future}}',
    lines: [{ itemId: '{{itemId}}', quantityOrdered: 100, unitPrice: 480 }],
    taxRate: 0,
  };
  const receive = (quantity: number) => ({
    warehouseId: '{{warehouseId}}',
    lines: [
      {
        poLineId: '{{poLineId}}',
        itemId: '{{itemId}}',
        quantity,
        unitCost: 480,
        qualityNotes: 'Presentation synthetic fabric inspection passed',
      },
    ],
  });
  const workflow = [
    request(
      'Create draft PO (100 kg cotton)',
      'POST',
      '/purchase-orders',
      poBody,
      "pm.environment.set('poId',d.id); pm.environment.set('poLineId',d.lines[0].id);",
    ),
    request('Submit for approval', 'POST', '/purchase-orders/{{poId}}/submit', {}),
    request('Approve as owner', 'POST', '/purchase-orders/{{poId}}/approve', {}),
    request('Send PDF to supplier (local SMTP capture)', 'POST', '/purchase-orders/{{poId}}/send', {
      sentTo: 'sales0@garments.example.test',
    }),
    request('Receive first 40 kg', 'POST', '/purchase-orders/{{poId}}/receipts', receive(40)),
    request('Receive remaining 60 kg', 'POST', '/purchase-orders/{{poId}}/receipts', receive(60)),
    request('List GRNs', 'GET', '/purchase-orders/{{poId}}/receipts'),
    request('Close fulfilled PO', 'POST', '/purchase-orders/{{poId}}/close', {}),
    request('Get PDF signed download URL', 'GET', '/purchase-orders/{{poId}}/pdf'),
    request('Verify resulting stock', 'GET', '/inventory/items/{{itemId}}/balances'),
  ];
  const rfq = [
    request(
      'Create RFQ and send invitation',
      'POST',
      '/quotations',
      {
        validUntil: '{{future}}',
        lines: [{ itemId: '{{itemId}}', quantity: 1000, targetUnitPrice: 480 }],
        invitedSuppliers: [
          { supplierId: '{{supplierId}}', contactEmail: 'sales0@garments.example.test' },
          { supplierId: '{{secondSupplierId}}', contactEmail: 'sales1@garments.example.test' },
        ],
      },
      "pm.environment.set('quotationId',d.id);",
    ),
    request(
      'Submit offer - set quoteToken from captured email first',
      'POST',
      '/public/quotations/responses/{{quoteToken}}',
      {
        lines: [
          {
            itemId: '{{itemId}}',
            unitPrice: 450,
            currency: 'BDT',
            moq: 100,
            leadTimeDays: 7,
            validityDays: 14,
          },
        ],
      },
    ),
    request(
      'Compare offers with live AI and persist response',
      'GET',
      '/quotations/{{quotationId}}/compare?includeAi=true',
    ),
    request(
      'Accept supplier and create draft PO',
      'POST',
      '/quotations/{{quotationId}}/accept',
      { supplierId: '{{supplierId}}', warehouseId: '{{warehouseId}}' },
      "if(d.purchaseOrder){pm.environment.set('poId',d.purchaseOrder.id);pm.environment.set('poLineId',d.purchaseOrder.lines[0].id);}",
    ),
  ];
  const ai = [
    request(
      'Generate live forecast or use valid cached result',
      'POST',
      '/ai/forecasts',
      { itemId: '{{itemId}}', horizonDays: 30 },
      "pm.environment.set('forecastId',d.id);",
    ),
    request('Generate batch for two items', 'POST', '/ai/forecasts/batch', {
      itemIds: ['{{itemId}}', '{{secondItemId}}'],
    }),
    request('Apply reviewed forecast override', 'POST', '/ai/forecasts/{{forecastId}}/override', {
      quantity: 2500,
      justification: 'Presentation: confirmed production plan of 2500 kg',
    }),
    request('Create PO from forecast', 'POST', '/purchase-orders/from-forecast', {
      itemId: '{{itemId}}',
      warehouseId: '{{warehouseId}}',
      expectedDeliveryAt: '{{future}}',
    }),
  ];
  const reports = [
    request('Set procurement budget', 'POST', '/reports/budget', {
      monthlyLimit: 5000000,
      currency: 'BDT',
      warningThresholdPct: 80,
    }),
    request(
      'Queue weekly AI report + PDF',
      'POST',
      '/reports/weekly-digest',
      { from: '{{from}}', to: '{{to}}' },
      undefined,
      [202],
    ),
    request('Poll report artifacts until ready', 'GET', '/reports/artifacts'),
    request(
      'Get report signed URL - set reportArtifactId',
      'GET',
      '/reports/artifacts/{{reportArtifactId}}/download',
    ),
  ];
  const collection = {
    info: {
      _postman_id: '6d121a49-5cb3-4a2b-a930-a4388fd1bdfa',
      name: 'Bangladesh Garments - Verified Presentation Workflow',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description:
        'Run Login, then folder 02 for a read-only presentation. Folder 03 is a complete new PO workflow. Run remaining folders manually as documented in MANUAL-TEST-WORKFLOW.bn.md. Data and pricing are synthetic; AI output is generated by real providers.',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
    variable: Object.entries(values).map(([key, value]) => ({ key, value, type: 'string' })),
    event: [
      {
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: [
            "if(pm.request.method==='POST') pm.request.headers.upsert({key:'Idempotency-Key',value:pm.variables.replaceIn('{{$guid}}')});",
          ],
        },
      },
    ],
    item: [
      { name: '01 - Login', item: [login] },
      { name: '02 - Presentation - saved data', item: presentation },
      { name: '03 - Complete new PO workflow', item: workflow },
      { name: '04 - New RFQ workflow - manual email token', item: rfq },
      { name: '05 - Live AI workflow', item: ai },
      { name: '06 - AI report and budget workflow', item: reports },
    ],
  };
  // Saved real responses are part of the exported collection and survive regeneration.
  const saved = new Map<string, any[]>();
  const identity = (entry: any) =>
    `${entry.name}|${entry.request.method}|${typeof entry.request.url === 'string' ? entry.request.url : entry.request.url.raw}`;
  const remember = (items: any[]) => {
    for (const entry of items) {
      if (entry.item) remember(entry.item);
      else if (entry.response?.length) {
        // Desktop's collection-create API rejects optional runtime response metadata
        // accepted by the public v2.1 schema. Export only the saved example fields.
        saved.set(
          identity(entry),
          entry.response.map((response: any) => ({
            name: response.name,
            originalRequest: response.originalRequest,
            status: response.status,
            code: response.code,
            header: response.header,
            body: response.body,
          })),
        );
      }
    }
  };
  remember(previous?.item ?? []);
  const restore = (items: any[]) => {
    for (const entry of items) {
      if (entry.item) restore(entry.item);
      else if (saved.has(identity(entry))) entry.response = saved.get(identity(entry));
    }
  };
  restore(collection.item);
  if (saved.size)
    collection.info.description +=
      ' Saved Examples contain real captured API responses (credentials redacted); viewing them needs no running API. See SAVED-RESPONSES.bn.md.';
  await writeFile(
    '../postman/garments-demo.environment.json',
    JSON.stringify(environment, null, 2),
  );
  await writeFile('../postman/garments-demo.collection.json', JSON.stringify(collection, null, 2));
  const legacy = JSON.parse(await readFile('../postman/api.collection.json', 'utf8'));
  const repair = (items: any[]) => {
    for (const entry of items) {
      if (entry.item) {
        repair(entry.item);
        continue;
      }
      const r = entry.request;
      if (!r) continue;
      if (entry.name === 'Register Factory + Owner') {
        r.body.raw = JSON.stringify(
          {
            factory: {
              name: 'Bangladesh Apparel Test',
              businessType: 'rmg',
              country: 'BD',
              timeZone: 'Asia/Dhaka',
            },
            owner: {
              fullName: 'Demo Owner',
              email: 'owner@acme.test',
              password: 'StrongPass!2026',
            },
          },
          null,
          2,
        );
        entry.event = [];
      }
      if (['Refresh Token', 'Logout'].includes(entry.name)) r.body.raw = '{}';
      if (entry.name.includes('Get Quotation (saves'))
        entry.name = 'Get Quotation (tokens are delivered by invitation email)';
      if (entry.name.startsWith('Create Checkout Session'))
        entry.name = 'Create Checkout Session (Stripe subscription)';
      if (r.body?.mode === 'raw' && r.body.raw.startsWith('{')) {
        try {
          const b = JSON.parse(r.body.raw);
          if (b.validUntil) b.validUntil = '{{future}}';
          if (b.expectedDeliveryAt) b.expectedDeliveryAt = '{{future}}';
          if (b.taxId) delete b.taxId;
          if (b.toWarehouseId) b.toWarehouseId = '{{secondWarehouseId}}';
          r.body.raw = JSON.stringify(b, null, 2);
        } catch {}
      }
      let url = typeof r.url === 'string' ? r.url : r.url?.raw;
      if (url) {
        url = url
          .replace('/../webhooks/', '/webhooks/')
          .replace(/from=\d{4}-[^&]+/, 'from={{from}}')
          .replace(/to=\d{4}-[^&]+/, 'to={{to}}');
        r.url = url;
      }
    }
  };
  repair(legacy.item);
  const dateScript =
    "for(const [key,days] of [['future',14],['from',-180],['to',1]]) { if(!pm.environment.get(key)) pm.environment.set(key,new Date(Date.now()+days*86400000).toISOString()); }";
  if (!legacy.event[0].script.exec.includes(dateScript))
    legacy.event[0].script.exec.push(dateScript);
  await writeFile('../postman/api.collection.json', JSON.stringify(legacy, null, 2));
  const mounts: Record<string, string> = {
    authPublicRouter: '/auth',
    authPrivateRouter: '/auth',
    inventoryRouter: '/inventory',
    supplierRouter: '/suppliers',
    quotationRouter: '/quotations',
    publicQuotationRouter: '/public/quotations',
    poRouter: '/purchase-orders',
    aiRouter: '/ai',
    rptRouter: '/reports',
    notificationRouter: '/notifications',
    billingRouter: '/billing',
    webhookRouter: '/webhooks',
    uploadRouter: '/uploads',
  };
  const rows: string[] = [];
  for (const mod of await readdir('src/modules'))
    for (const file of await readdir(path.join('src/modules', mod))) {
      if (!file.endsWith('.routes.ts')) continue;
      const source = await readFile(path.join('src/modules', mod, file), 'utf8');
      for (const match of source.matchAll(
        /(\w+Router)\.(get|post|patch|put|delete)\(\s*['"]([^'"]+)['"]/g,
      )) {
        rows.push(
          `| ${match[2]!.toUpperCase()} | /api/v1${mounts[match[1]!] ?? ''}${match[3] === '/' ? '' : match[3]} | ${mod} |`,
        );
      }
    }
  await writeFile(
    '../postman/API-ENDPOINT-CATALOG.md',
    `# Backend API endpoint catalogue\n\nGenerated from current route source. Public endpoints: auth registration/login/recovery/verification/invite acceptance, GET /billing/plans, token-gated quotation responses, signed Stripe webhooks. Other routes require Bearer auth, current account/subscription access and role permissions. See [Stripe API changes and manual workflow](SUBSCRIPTION-STRIPE-API-CHANGES.bn.md).\n\n| Method | Endpoint | Module |\n|---|---|---|\n${rows.join('\n')}\n\nHealth: GET /healthz and GET /readyz. Socket.IO: /realtime (WebSocket).\n`,
  );
  console.log('Presentation environment, collection and full endpoint catalogue generated.');
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
