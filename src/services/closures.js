import { transaction, logAction } from '../db.js';
import { sha256, ValidationError } from './sales.js';

// Calcule le rapport de caisse (ticket X) sur les ventes non encore clôturées.
export function currentReport(db) {
  const sales = db.prepare('SELECT * FROM sales WHERE closure_id IS NULL ORDER BY number').all();
  return buildReport(db, sales);
}

function buildReport(db, sales) {
  const ids = sales.map((s) => s.id);
  const report = {
    sales_count: sales.filter((s) => !s.refund_of).length,
    refunds_count: sales.filter((s) => s.refund_of).length,
    first_sale: sales[0]?.number ?? null,
    last_sale: sales.at(-1)?.number ?? null,
    period_start: sales[0]?.created_at ?? null,
    period_end: sales.at(-1)?.created_at ?? null,
    total: sales.reduce((s, x) => s + x.total, 0),
    total_ht: sales.reduce((s, x) => s + x.total_ht, 0),
    refunds_total: sales.filter((s) => s.refund_of).reduce((s, x) => s + x.total, 0),
    discounts_total: 0,
    change_given: sales.reduce((s, x) => s + x.change_given, 0),
    by_vat: [],
    by_payment: [],
    by_seller: [],
    by_category: [],
    cash_expected: 0,
  };
  if (ids.length === 0) return report;

  const inList = `(${ids.map(() => '?').join(',')})`;
  // Remises accordées (lignes + remise globale), déduction faite des avoirs.
  const lineDiscounts = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN s.refund_of IS NULL THEN l.discount ELSE -l.discount END), 0) AS d
       FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE l.sale_id IN ${inList}`,
    )
    .get(...ids).d;
  report.discounts_total = lineDiscounts + sales.reduce((s, x) => s + (x.refund_of ? -x.discount : x.discount), 0);

  report.by_vat = db
    .prepare(
      `SELECT vat_rate, SUM(total) AS ttc, SUM(total_ht) AS ht, SUM(total) - SUM(total_ht) AS vat
       FROM sale_lines WHERE sale_id IN ${inList} GROUP BY vat_rate ORDER BY vat_rate DESC`,
    )
    .all(...ids);

  report.by_payment = db
    .prepare(
      `SELECT pm.id, pm.name, pm.code, pm.gives_change, SUM(sp.amount) AS amount, COUNT(*) AS count
       FROM sale_payments sp JOIN payment_methods pm ON pm.id = sp.payment_method_id
       WHERE sp.sale_id IN ${inList} GROUP BY pm.id ORDER BY pm.position`,
    )
    .all(...ids);

  report.by_seller = db
    .prepare(
      `SELECT s.seller_id, COALESCE(se.name, 'Sans vendeur') AS name, COUNT(*) AS count, SUM(s.total) AS total
       FROM sales s LEFT JOIN sellers se ON se.id = s.seller_id
       WHERE s.id IN ${inList} GROUP BY s.seller_id ORDER BY total DESC`,
    )
    .all(...ids);

  report.by_category = db
    .prepare(
      `SELECT COALESCE(c.name, 'Sans catégorie') AS name, SUM(l.quantity) AS quantity, SUM(l.total) AS total
       FROM sale_lines l LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE l.sale_id IN ${inList} GROUP BY c.id ORDER BY total DESC`,
    )
    .all(...ids);

  const cashIn = report.by_payment.filter((p) => p.gives_change).reduce((s, p) => s + p.amount, 0);
  report.cash_expected = cashIn - report.change_given;
  return report;
}

// Clôture (ticket Z) : fige toutes les ventes non clôturées. Irréversible.
export function closeRegister(db, { cash_counted = null, seller_id = null } = {}) {
  return transaction(db, () => {
    const sales = db.prepare('SELECT * FROM sales WHERE closure_id IS NULL ORDER BY number').all();
    if (sales.length === 0) throw new ValidationError('Aucune vente à clôturer.');
    if (cash_counted != null && !Number.isInteger(cash_counted)) {
      throw new ValidationError('Montant du fond de caisse invalide.');
    }
    const report = buildReport(db, sales);
    if (cash_counted != null) report.cash_difference = cash_counted - report.cash_expected;

    const prev = db.prepare('SELECT number, grand_total, hash FROM closures ORDER BY number DESC LIMIT 1').get();
    const closure = {
      number: (prev?.number ?? 0) + 1,
      created_at: new Date().toISOString(),
      first_sale: report.first_sale,
      last_sale: report.last_sale,
      sales_count: report.sales_count,
      total: report.total,
      total_ht: report.total_ht,
      cash_counted,
      report: JSON.stringify(report),
      grand_total: (prev?.grand_total ?? 0) + report.total,
    };
    closure.hash = sha256((prev?.hash ?? '') + JSON.stringify(closure));

    const { lastInsertRowid: id } = db
      .prepare(
        `INSERT INTO closures (number, created_at, first_sale, last_sale, sales_count, total, total_ht,
           cash_counted, report, grand_total, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        closure.number, closure.created_at, closure.first_sale, closure.last_sale, closure.sales_count,
        closure.total, closure.total_ht, closure.cash_counted, closure.report, closure.grand_total, closure.hash,
      );
    db.prepare('UPDATE sales SET closure_id = ? WHERE closure_id IS NULL').run(id);
    logAction(db, 'closure', { number: closure.number, total: closure.total }, seller_id);
    return getClosure(db, Number(id));
  });
}

export function getClosure(db, id) {
  const row = db.prepare('SELECT * FROM closures WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, report: JSON.parse(row.report) };
}

export function listClosures(db) {
  return db
    .prepare('SELECT id, number, created_at, sales_count, total, total_ht, grand_total FROM closures ORDER BY number DESC')
    .all();
}
