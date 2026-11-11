import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createSale, customerBalance, refundSale, verifyChain } from '../src/services/sales.js';
import { closeRegister, currentReport } from '../src/services/closures.js';
import { allocate, htFromTtc } from '../src/money.js';

function setup() {
  const db = openDatabase(':memory:');
  const cat = db.prepare("INSERT INTO categories (name) VALUES ('Boissons')").run().lastInsertRowid;
  const coffee = db
    .prepare("INSERT INTO products (name, category_id, price, vat_rate, stock) VALUES ('Café', ?, 150, 1000, 10)")
    .run(cat).lastInsertRowid;
  const book = db
    .prepare("INSERT INTO products (name, price, vat_rate) VALUES ('Livre', 2000, 550)")
    .run().lastInsertRowid;
  const pm = Object.fromEntries(db.prepare('SELECT code, id FROM payment_methods').all().map((r) => [r.code, r.id]));
  return { db, coffee: Number(coffee), book: Number(book), pm };
}

test('allocate répartit exactement le montant', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(allocate(7, [3, 5, 11]).reduce((a, b) => a + b), 7);
  assert.equal(htFromTtc(120, 2000), 100);
});

test('vente simple avec rendu monnaie et décrément du stock', () => {
  const { db, coffee, pm } = setup();
  const sale = createSale(db, {
    lines: [{ product_id: coffee, quantity: 2 }],
    payments: [{ payment_method_id: pm.CASH, amount: 500 }],
  });
  assert.equal(sale.number, 1);
  assert.equal(sale.total, 300);
  assert.equal(sale.change_given, 200);
  assert.equal(sale.total_ht, htFromTtc(300, 1000));
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(coffee).stock, 8);
});

test('refuse un paiement insuffisant ou un rendu sur carte', () => {
  const { db, book, pm } = setup();
  const lines = [{ product_id: book }];
  assert.throws(() => createSale(db, { lines, payments: [{ payment_method_id: pm.CARD, amount: 1000 }] }), /insuffisant/);
  assert.throws(() => createSale(db, { lines, payments: [{ payment_method_id: pm.CARD, amount: 3000 }] }), /Rendu/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
});

test('remise globale ventilée par taux de TVA et paiement mixte', () => {
  const { db, coffee, book, pm } = setup();
  const sale = createSale(db, {
    lines: [{ product_id: coffee, quantity: 2, discount: 50 }, { product_id: book }],
    discount: 250,
    payments: [
      { payment_method_id: pm.CARD, amount: 1000 },
      { payment_method_id: pm.CASH, amount: 2000 },
    ],
  });
  // 300 - 50 + 2000 = 2250, - 250 = 2000
  assert.equal(sale.total, 2000);
  assert.equal(sale.lines.reduce((s, l) => s + l.total, 0), 2000);
  assert.equal(sale.change_given, 1000);
});

test('article libre et avoir', () => {
  const { db, pm } = setup();
  const sale = createSale(db, {
    lines: [{ label: 'Divers', unit_price: 1234, vat_rate: 2000 }],
    payments: [{ payment_method_id: pm.CASH, amount: 1500 }],
  });
  const refund = refundSale(db, sale.id);
  assert.equal(refund.total, -1234);
  assert.equal(refund.refund_of, sale.id);
  assert.deepEqual(refund.payments.map((p) => p.amount), [-1234]);
  assert.throws(() => refundSale(db, sale.id), /déjà été annulé/);
});

test('la chaîne de hachage détecte une altération', () => {
  const { db, coffee, pm } = setup();
  for (let i = 0; i < 3; i++) {
    createSale(db, { lines: [{ product_id: coffee }], payments: [{ payment_method_id: pm.CARD, amount: 150 }] });
  }
  assert.deepEqual(verifyChain(db), { ok: true, count: 3 });
  db.prepare('UPDATE sales SET total = 1 WHERE number = 2').run();
  assert.equal(verifyChain(db).broken_at, 2);
});

test('clôture Z', () => {
  const { db, coffee, book, pm } = setup();
  createSale(db, { lines: [{ product_id: coffee }], payments: [{ payment_method_id: pm.CASH, amount: 200 }] });
  const s2 = createSale(db, { lines: [{ product_id: book }], payments: [{ payment_method_id: pm.CARD, amount: 2000 }] });
  refundSale(db, s2.id);

  const x = currentReport(db);
  assert.equal(x.total, 150);
  assert.equal(x.sales_count, 2);
  assert.equal(x.refunds_count, 1);
  assert.equal(x.cash_expected, 150);

  const z = closeRegister(db, { cash_counted: 140 });
  assert.equal(z.number, 1);
  assert.equal(z.report.cash_difference, -10);
  assert.equal(z.grand_total, 150);
  assert.equal(currentReport(db).total, 0);
  assert.throws(() => closeRegister(db), /Aucune vente/);
});

test('article offert à 100 % et coupons', () => {
  const { db, coffee, book, pm } = setup();
  db.prepare("INSERT INTO coupons (code, kind, value, max_uses) VALUES ('BIENVENUE', 'percent', 1000, 1)").run();
  const sale = createSale(db, {
    lines: [{ product_id: coffee, discount: 150 }, { product_id: book }],
    coupon_code: 'bienvenue',
    payments: [{ payment_method_id: pm.CARD, amount: 1800 }],
  });
  assert.equal(sale.lines[0].total, 0);
  assert.equal(sale.discount, 200);
  assert.equal(sale.total, 1800);
  assert.equal(sale.coupon_code, 'BIENVENUE');
  assert.throws(
    () => createSale(db, { lines: [{ product_id: book }], coupon_code: 'BIENVENUE', payments: [{ payment_method_id: pm.CARD, amount: 1800 }] }),
    /maximum/,
  );
  assert.throws(
    () => createSale(db, { lines: [{ product_id: book }], coupon_code: 'NOPE', payments: [{ payment_method_id: pm.CARD, amount: 2000 }] }),
    /inconnu/,
  );
});

test('compte client et remboursement par un autre moyen', () => {
  const { db, book, pm } = setup();
  const lines = [{ product_id: book }];
  assert.throws(() => createSale(db, { lines, payments: [{ payment_method_id: pm.ACCOUNT, amount: 2000 }] }), /client/);
  const cust = Number(db.prepare("INSERT INTO customers (last_name) VALUES ('Durand')").run().lastInsertRowid);
  createSale(db, { lines, customer_id: cust, payments: [{ payment_method_id: pm.ACCOUNT, amount: 2000 }] });
  assert.equal(customerBalance(db, cust), 2000);
  const s = createSale(db, { lines, payments: [{ payment_method_id: pm.CARD, amount: 2000 }] });
  const r = refundSale(db, s.id, { payment_method_id: pm.CHECK });
  assert.deepEqual(r.payments.map((p) => [p.code, p.amount]), [['CHECK', -2000]]);
});
