import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

let server;
let base;

before(async () => {
  server = createApp(openDatabase(':memory:')).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test('parcours complet via l\'API', async () => {
  const cat = await call('POST', '/categories', { name: 'Épicerie' });
  assert.equal(cat.status, 201);
  const prod = await call('POST', '/products', { name: 'Miel', price: 890, vat_rate: 550, category_id: cat.body.id });
  assert.equal(prod.status, 201);

  const pms = (await call('GET', '/payment-methods')).body;
  const card = pms.find((p) => p.code === 'CARD');

  const bad = await call('POST', '/sales', { lines: [], payments: [] });
  assert.equal(bad.status, 400);

  const sale = await call('POST', '/sales', {
    lines: [{ product_id: prod.body.id, quantity: 3 }],
    payments: [{ payment_method_id: card.id, amount: 2670 }],
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.body.total, 2670);

  assert.equal((await call('GET', '/sales')).body.length, 1);
  assert.equal((await call('GET', '/sales/verify')).body.ok, true);

  const inv = await fetch(`${base}/sales/${sale.body.id}/invoice`);
  assert.match(await inv.text(), /Facture/);

  const cust = await call('POST', '/customers', { last_name: 'Martin' });
  const account = pms.find((p) => p.code === 'ACCOUNT');
  const cash = pms.find((p) => p.code === 'CASH');
  await call('POST', '/sales', {
    customer_id: cust.body.id,
    lines: [{ product_id: prod.body.id }],
    payments: [{ payment_method_id: account.id, amount: 890 }],
  });
  assert.equal((await call('GET', `/customers/${cust.body.id}/account`)).body.balance, 890);
  const settle = await call('POST', `/customers/${cust.body.id}/settle`, { payment_method_id: cash.id, amount: 890 });
  assert.equal(settle.status, 201);
  assert.equal((await call('GET', `/customers/${cust.body.id}/account`)).body.balance, 0);

  const z = await call('POST', '/closures', {});
  assert.equal(z.status, 201);
  assert.equal(z.body.total, 2670 + 890);

  await call('DELETE', `/products/${prod.body.id}`);
  assert.equal((await call('GET', '/products')).body.length, 0);
  assert.equal((await call('GET', '/products?all=1')).body.length, 1);
});
