import express from 'express';
import { fileURLToPath } from 'node:url';
import { crudRouter } from './routes/crud.js';
import { getSettings, logAction } from './db.js';
import {
  createSale, customerBalance, getSale, listSales, refundSale, resolveCoupon, verifyChain, ValidationError,
} from './services/sales.js';
import { renderInvoice } from './services/invoice.js';
import { closeRegister, currentReport, getClosure, listClosures } from './services/closures.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const api = express.Router();

  // --- Référentiels ---------------------------------------------------------
  api.use('/categories', crudRouter(db, {
    table: 'categories',
    fields: ['name', 'color', 'position', 'active'],
    required: ['name'],
    orderBy: 'position, name',
    softDelete: true,
  }));
  api.use('/products', crudRouter(db, {
    table: 'products',
    fields: ['name', 'category_id', 'price', 'vat_rate', 'barcode', 'stock', 'color', 'position', 'active'],
    required: ['name', 'price'],
    orderBy: 'position, name',
    softDelete: true,
  }));
  api.use('/customers', crudRouter(db, {
    table: 'customers',
    fields: ['first_name', 'last_name', 'email', 'phone', 'address', 'notes'],
    required: ['last_name'],
    orderBy: 'last_name, first_name',
  }));
  api.use('/sellers', crudRouter(db, {
    table: 'sellers',
    fields: ['name', 'pin', 'active'],
    required: ['name'],
    orderBy: 'name',
    softDelete: true,
  }));
  api.use('/payment-methods', crudRouter(db, {
    table: 'payment_methods',
    fields: ['name', 'code', 'gives_change', 'is_account', 'position', 'active'],
    required: ['name', 'code'],
    orderBy: 'position',
    softDelete: true,
  }));
  api.use('/coupons', crudRouter(db, {
    table: 'coupons',
    fields: ['code', 'label', 'kind', 'value', 'min_total', 'max_uses', 'expires_at', 'active'],
    required: ['code', 'kind', 'value'],
    orderBy: 'code',
    softDelete: true,
  }));
  // Prévisualise la remise d'un coupon pour un sous-total donné (en centimes).
  api.get('/coupons/check/:code', (req, res) => {
    res.json(resolveCoupon(db, req.params.code, Number(req.query.total) || 0));
  });

  // Compte client : solde et règlement.
  api.get('/customers/:id/account', (req, res) => {
    res.json({
      balance: customerBalance(db, Number(req.params.id)),
      sales: listSales(db, { customer_id: Number(req.params.id), limit: 50 }),
    });
  });
  // Un règlement de compte est un ticket à 0 € : +X sur le mode choisi, -X sur le compte.
  api.post('/customers/:id/settle', (req, res) => {
    const customerId = Number(req.params.id);
    const amount = req.body.amount;
    if (!Number.isInteger(amount) || amount <= 0) throw new ValidationError('Montant invalide.');
    const account = db.prepare('SELECT id FROM payment_methods WHERE is_account = 1 AND active = 1').get();
    if (!account) throw new ValidationError('Aucun mode de paiement « compte client » actif.');
    const sale = createSale(db, {
      customer_id: customerId,
      seller_id: req.body.seller_id,
      lines: [{ label: 'Règlement compte client', unit_price: 0, vat_rate: 0 }],
      payments: [
        { payment_method_id: req.body.payment_method_id, amount },
        { payment_method_id: account.id, amount: -amount },
      ],
      note: 'Règlement de compte client',
    });
    res.status(201).json(sale);
  });

  api.get('/vat-rates', (req, res) => {
    res.json(db.prepare('SELECT * FROM vat_rates ORDER BY rate DESC').all());
  });

  // --- Paramètres -----------------------------------------------------------
  api.get('/settings', (req, res) => res.json(getSettings(db)));
  api.put('/settings', (req, res) => {
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [k, v] of Object.entries(req.body)) upsert.run(k, String(v ?? ''));
    res.json(getSettings(db));
  });

  // --- Vendeurs : identification par code PIN ------------------------------
  api.post('/login', (req, res) => {
    const seller = db
      .prepare('SELECT id, name FROM sellers WHERE active = 1 AND (pin = ? OR (pin IS NULL AND id = ?))')
      .get(String(req.body.pin ?? ''), req.body.seller_id ?? -1);
    if (!seller) return res.status(401).json({ error: 'Code vendeur incorrect' });
    logAction(db, 'login', null, seller.id);
    res.json(seller);
  });

  // --- Ventes ---------------------------------------------------------------
  api.get('/sales', (req, res) => res.json(listSales(db, req.query)));
  api.get('/sales/verify', (req, res) => res.json(verifyChain(db)));
  api.get('/sales/:id', (req, res) => {
    const sale = getSale(db, Number(req.params.id));
    if (!sale) return res.status(404).json({ error: 'Ticket introuvable' });
    res.json(sale);
  });
  // Facture HTML imprimable (enregistrable en PDF depuis le navigateur).
  api.get('/sales/:id/invoice', (req, res) => {
    const sale = getSale(db, Number(req.params.id));
    if (!sale) return res.status(404).json({ error: 'Ticket introuvable' });
    res.type('html').send(renderInvoice(sale, getSettings(db)));
  });
  api.post('/sales', (req, res) => res.status(201).json(createSale(db, req.body)));
  api.post('/sales/:id/refund', (req, res) => {
    res.status(201).json(refundSale(db, Number(req.params.id), req.body));
  });

  // --- Clôtures (X / Z) -----------------------------------------------------
  api.get('/report/current', (req, res) => res.json(currentReport(db)));
  api.get('/closures', (req, res) => res.json(listClosures(db)));
  api.get('/closures/:id', (req, res) => {
    const closure = getClosure(db, Number(req.params.id));
    if (!closure) return res.status(404).json({ error: 'Clôture introuvable' });
    res.json(closure);
  });
  api.post('/closures', (req, res) => res.status(201).json(closeRegister(db, req.body)));

  // --- Statistiques ---------------------------------------------------------
  api.get('/stats/daily', (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 366);
    res.json(
      db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day, COUNT(*) FILTER (WHERE refund_of IS NULL) AS count,
                  SUM(total) AS total
           FROM sales WHERE created_at >= date('now', ?) GROUP BY day ORDER BY day`,
        )
        .all(`-${days} days`),
    );
  });
  api.get('/stats/top-products', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT l.label, SUM(l.quantity) AS quantity, SUM(l.total) AS total
           FROM sale_lines l JOIN sales s ON s.id = l.sale_id
           WHERE s.created_at >= date('now', ?)
           GROUP BY l.label ORDER BY total DESC LIMIT 20`,
        )
        .all(`-${Math.min(Number(req.query.days) || 30, 366)} days`),
    );
  });

  app.use('/api', api);
  app.use(express.static(PUBLIC_DIR));

  // Gestion d'erreurs centralisée (Express 4 : les exceptions synchrones arrivent ici).
  app.use((err, req, res, _next) => {
    const status = err.status || (err.code === 'ERR_SQLITE_ERROR' && /constraint/i.test(err.message) ? 409 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Erreur serveur' });
  });

  return app;
}
