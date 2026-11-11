import { createHash } from 'node:crypto';
import { transaction, logAction } from '../db.js';
import { allocate, htFromTtc } from '../money.js';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const GENESIS_HASH = '0'.repeat(64);

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Empreinte d'un ticket, chaînée avec celle du ticket précédent :
// toute modification a posteriori d'un ticket casse la chaîne (cf. verifyChain).
function saleFingerprint(sale, lines, payments) {
  return JSON.stringify({
    number: sale.number,
    created_at: sale.created_at,
    total: sale.total,
    total_ht: sale.total_ht,
    discount: sale.discount,
    change_given: sale.change_given,
    refund_of: sale.refund_of ?? null,
    coupon_code: sale.coupon_code ?? null,
    lines: lines.map((l) => [l.label, l.quantity, l.unit_price, l.discount, l.vat_rate, l.total]),
    payments: payments.map((p) => [p.payment_method_id, p.amount]),
  });
}

function computeHash(prevHash, sale, lines, payments) {
  return sha256(prevHash + saleFingerprint(sale, lines, payments));
}

function isInt(n) {
  return Number.isInteger(n);
}

// Construit les lignes d'un ticket à partir de la saisie de la caisse.
function buildLines(db, input) {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ValidationError('Le ticket ne contient aucun article.');
  }
  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const lines = input.lines.map((raw) => {
    const quantity = raw.quantity ?? 1;
    if (!isInt(quantity) || quantity === 0) throw new ValidationError('Quantité invalide.');
    let product = null;
    if (raw.product_id != null) {
      product = getProduct.get(raw.product_id);
      if (!product) throw new ValidationError(`Article ${raw.product_id} introuvable.`);
    }
    const unitPrice = raw.unit_price ?? product?.price;
    const vatRate = raw.vat_rate ?? product?.vat_rate ?? 2000;
    const label = raw.label ?? product?.name;
    const discount = raw.discount ?? 0;
    if (!label) throw new ValidationError('Libellé manquant pour un article libre.');
    if (!isInt(unitPrice) || unitPrice < 0) throw new ValidationError('Prix invalide.');
    if (!isInt(discount) || discount < 0) throw new ValidationError('Remise invalide.');
    const gross = quantity * unitPrice;
    if (discount > Math.abs(gross)) throw new ValidationError('Remise supérieure au montant de la ligne.');
    return {
      product_id: product?.id ?? null,
      label,
      quantity,
      unit_price: unitPrice,
      discount,
      vat_rate: vatRate,
      gross: gross - Math.sign(gross) * discount,
    };
  });

  // Répartition de la remise globale au prorata des lignes (nécessaire pour la ventilation TVA).
  const manualDiscount = input.discount ?? 0;
  if (!isInt(manualDiscount) || manualDiscount < 0) throw new ValidationError('Remise globale invalide.');
  const grossTotal = lines.reduce((s, l) => s + l.gross, 0);
  const coupon = input.coupon_code ? resolveCoupon(db, input.coupon_code, grossTotal - manualDiscount) : null;
  const globalDiscount = manualDiscount + (coupon?.amount ?? 0);
  if (globalDiscount > Math.abs(grossTotal)) throw new ValidationError('Remise supérieure au total.');
  const shares = allocate(globalDiscount, lines.map((l) => Math.abs(l.gross)));
  for (const [i, line] of lines.entries()) {
    line.total = line.gross - Math.sign(line.gross) * shares[i];
    line.total_ht = htFromTtc(line.total, line.vat_rate);
    delete line.gross;
  }
  return { lines, discount: globalDiscount, couponCode: coupon?.code ?? null };
}

// Vérifie un coupon et calcule la remise TTC qu'il accorde sur `base` (total après remises).
export function resolveCoupon(db, code, base) {
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(String(code).trim());
  if (!coupon) throw new ValidationError('Coupon inconnu ou désactivé.');
  const today = new Date().toISOString().slice(0, 10);
  if (coupon.expires_at && coupon.expires_at < today) throw new ValidationError('Coupon expiré.');
  if (coupon.max_uses != null) {
    const used = db
      .prepare('SELECT COUNT(*) AS n FROM sales WHERE coupon_code = ? COLLATE NOCASE AND refund_of IS NULL')
      .get(coupon.code).n;
    if (used >= coupon.max_uses) throw new ValidationError('Coupon déjà utilisé le nombre maximum de fois.');
  }
  if (base < coupon.min_total) throw new ValidationError('Montant minimum du coupon non atteint.');
  const amount = coupon.kind === 'percent' ? Math.round((base * coupon.value) / 10000) : coupon.value;
  return {
    code: coupon.code, label: coupon.label, kind: coupon.kind, value: coupon.value,
    amount: Math.max(0, Math.min(amount, base)),
  };
}

function checkPayments(db, payments, total, customerId) {
  if (!Array.isArray(payments) || payments.length === 0) {
    throw new ValidationError('Aucun règlement saisi.');
  }
  const getMethod = db.prepare('SELECT * FROM payment_methods WHERE id = ?');
  let paid = 0;
  let changeable = 0;
  for (const p of payments) {
    const method = getMethod.get(p.payment_method_id);
    if (!method) throw new ValidationError('Mode de paiement inconnu.');
    if (method.is_account && !customerId) {
      throw new ValidationError('Sélectionnez un client pour un paiement sur compte.');
    }
    if (!isInt(p.amount)) throw new ValidationError('Montant de paiement invalide.');
    paid += p.amount;
    if (method.gives_change) changeable += p.amount;
  }
  const change = paid - total;
  if (total >= 0) {
    if (change < 0) throw new ValidationError('Le montant réglé est insuffisant.');
    if (change > changeable) {
      throw new ValidationError('Rendu monnaie impossible avec ce mode de paiement.');
    }
  } else if (change !== 0) {
    throw new ValidationError('Le remboursement doit correspondre exactement au montant du ticket.');
  }
  return change;
}

function insertSale(db, { lines, payments, discount, change, sellerId, customerId, note, refundOf, couponCode }) {
  const total = lines.reduce((s, l) => s + l.total, 0);
  const totalHt = lines.reduce((s, l) => s + l.total_ht, 0);
  const last = db.prepare('SELECT number, hash FROM sales ORDER BY number DESC LIMIT 1').get();
  const sale = {
    number: (last?.number ?? 0) + 1,
    created_at: new Date().toISOString(),
    seller_id: sellerId ?? null,
    customer_id: customerId ?? null,
    total,
    total_ht: totalHt,
    discount,
    change_given: change,
    note: note ?? null,
    refund_of: refundOf ?? null,
    coupon_code: couponCode ?? null,
    prev_hash: last?.hash ?? GENESIS_HASH,
  };
  sale.hash = computeHash(sale.prev_hash, sale, lines, payments);

  const { lastInsertRowid: saleId } = db
    .prepare(
      `INSERT INTO sales (number, created_at, seller_id, customer_id, total, total_ht, discount,
         change_given, note, refund_of, coupon_code, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sale.number, sale.created_at, sale.seller_id, sale.customer_id, sale.total, sale.total_ht,
      sale.discount, sale.change_given, sale.note, sale.refund_of, sale.coupon_code, sale.prev_hash, sale.hash,
    );

  const insLine = db.prepare(
    `INSERT INTO sale_lines (sale_id, product_id, label, quantity, unit_price, discount, vat_rate, total, total_ht)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL');
  for (const l of lines) {
    insLine.run(saleId, l.product_id, l.label, l.quantity, l.unit_price, l.discount, l.vat_rate, l.total, l.total_ht);
    if (l.product_id) decStock.run(l.quantity, l.product_id);
  }
  const insPay = db.prepare('INSERT INTO sale_payments (sale_id, payment_method_id, amount) VALUES (?, ?, ?)');
  for (const p of payments) insPay.run(saleId, p.payment_method_id, p.amount);

  return getSale(db, Number(saleId));
}

export function createSale(db, input) {
  return transaction(db, () => {
    const { lines, discount, couponCode } = buildLines(db, input);
    const total = lines.reduce((s, l) => s + l.total, 0);
    const change = checkPayments(db, input.payments, total, input.customer_id);
    const sale = insertSale(db, {
      lines,
      payments: input.payments,
      discount,
      change,
      sellerId: input.seller_id,
      customerId: input.customer_id,
      note: input.note,
      couponCode,
    });
    return sale;
  });
}

// Annulation d'un ticket : crée un avoir (ticket négatif) sans toucher à l'original.
export function refundSale(db, saleId, { payment_method_id, seller_id, note } = {}) {
  return transaction(db, () => {
    const original = getSale(db, saleId);
    if (!original) throw new ValidationError('Ticket introuvable.');
    if (original.refund_of) throw new ValidationError('Impossible d\'annuler un avoir.');
    const already = db.prepare('SELECT id FROM sales WHERE refund_of = ?').get(saleId);
    if (already) throw new ValidationError('Ce ticket a déjà été annulé.');

    const lines = original.lines.map((l) => ({
      product_id: l.product_id,
      label: l.label,
      quantity: -l.quantity,
      unit_price: l.unit_price,
      discount: l.discount,
      vat_rate: l.vat_rate,
      total: -l.total,
      total_ht: -l.total_ht,
    }));
    const total = -original.total;
    const payments = payment_method_id
      ? [{ payment_method_id, amount: total }]
      : refundPayments(original);
    checkPayments(db, payments, total, original.customer_id);
    const sale = insertSale(db, {
      lines,
      payments,
      discount: original.discount,
      change: 0,
      sellerId: seller_id,
      customerId: original.customer_id,
      note: note ?? `Annulation du ticket n°${original.number}`,
      refundOf: original.id,
      couponCode: original.coupon_code,
    });
    logAction(db, 'sale.refund', { sale: original.number, refund: sale.number }, seller_id);
    return sale;
  });
}

// Rembourse avec les mêmes modes de paiement que la vente, rendu monnaie déduit des espèces.
function refundPayments(original) {
  let change = original.change_given;
  return original.payments.map((p) => {
    let amount = p.amount;
    if (p.gives_change && change > 0) {
      const used = Math.min(change, amount);
      amount -= used;
      change -= used;
    }
    return { payment_method_id: p.payment_method_id, amount: -amount };
  }).filter((p) => p.amount !== 0);
}

export function getSale(db, id) {
  const sale = db
    .prepare(
      `SELECT s.*, se.name AS seller_name,
              TRIM(COALESCE(c.first_name, '') || ' ' || c.last_name) AS customer_name,
              c.email AS customer_email, c.address AS customer_address
       FROM sales s
       LEFT JOIN sellers se ON se.id = s.seller_id
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.id = ?`,
    )
    .get(id);
  if (!sale) return null;
  sale.lines = db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY id').all(id);
  sale.payments = db
    .prepare(
      `SELECT sp.payment_method_id, sp.amount, pm.name, pm.code, pm.gives_change, pm.is_account
       FROM sale_payments sp JOIN payment_methods pm ON pm.id = sp.payment_method_id
       WHERE sp.sale_id = ? ORDER BY sp.id`,
    )
    .all(id);
  sale.refunded_by = db.prepare('SELECT id, number FROM sales WHERE refund_of = ?').get(id) ?? null;
  return sale;
}

export function listSales(db, { from, to, limit = 100, offset = 0, customer_id } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('s.created_at >= ?'); params.push(from); }
  if (to) { where.push('s.created_at < ?'); params.push(to); }
  if (customer_id) { where.push('s.customer_id = ?'); params.push(customer_id); }
  const sql = `SELECT s.id, s.number, s.created_at, s.total, s.refund_of, s.closure_id,
                      se.name AS seller_name,
                      TRIM(COALESCE(c.first_name, '') || ' ' || c.last_name) AS customer_name
               FROM sales s
               LEFT JOIN sellers se ON se.id = s.seller_id
               LEFT JOIN customers c ON c.id = s.customer_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY s.number DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, Number(limit), Number(offset));
}

// Vérifie l'intégrité de la chaîne des tickets. Renvoie le premier ticket altéré le cas échéant.
export function verifyChain(db) {
  let prev = GENESIS_HASH;
  const ids = db.prepare('SELECT id FROM sales ORDER BY number').all();
  for (const { id } of ids) {
    const sale = getSale(db, id);
    const expected = computeHash(prev, sale, sale.lines, sale.payments);
    if (sale.prev_hash !== prev || sale.hash !== expected) {
      return { ok: false, count: ids.length, broken_at: sale.number };
    }
    prev = sale.hash;
  }
  return { ok: true, count: ids.length };
}

// Solde du compte client : somme des achats payés « sur compte » (positif = le client doit).
export function customerBalance(db, customerId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(sp.amount), 0) AS balance
       FROM sale_payments sp
       JOIN payment_methods pm ON pm.id = sp.payment_method_id AND pm.is_account = 1
       JOIN sales s ON s.id = sp.sale_id
       WHERE s.customer_id = ?`,
    )
    .get(customerId).balance;
}
