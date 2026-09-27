import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Tous les montants sont stockés en centimes (entiers) pour éviter les erreurs d'arrondi.
// Les taux de TVA sont stockés en points de base (2000 = 20,00 %).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vat_rates (
  id    INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  rate  INTEGER NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#4f46e5',
  position    INTEGER NOT NULL DEFAULT 0,
  external_id TEXT UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  price       INTEGER NOT NULL,           -- prix TTC en centimes
  vat_rate    INTEGER NOT NULL DEFAULT 2000,
  barcode     TEXT,
  stock       INTEGER,                    -- NULL = stock non suivi
  color       TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  external_id TEXT UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);

CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY,
  first_name  TEXT,
  last_name   TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  address     TEXT,
  notes       TEXT,
  external_id TEXT UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sellers (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  pin    TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  code          TEXT NOT NULL UNIQUE,
  gives_change  INTEGER NOT NULL DEFAULT 0, -- 1 = rendu monnaie possible (espèces)
  is_account    INTEGER NOT NULL DEFAULT 0, -- 1 = paiement sur compte client (client obligatoire)
  position      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);

-- Ticket de vente. Les tickets validés ne sont jamais modifiés ni supprimés :
-- une annulation crée un ticket d'avoir (montants négatifs) qui référence l'original.
CREATE TABLE IF NOT EXISTS sales (
  id            INTEGER PRIMARY KEY,
  number        INTEGER NOT NULL UNIQUE,  -- numéro de ticket séquentiel
  created_at    TEXT NOT NULL,
  seller_id     INTEGER REFERENCES sellers(id),
  customer_id   INTEGER REFERENCES customers(id),
  total         INTEGER NOT NULL,         -- TTC
  total_ht      INTEGER NOT NULL,
  discount      INTEGER NOT NULL DEFAULT 0, -- remise globale TTC déjà déduite du total
  change_given  INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  coupon_code   TEXT,
  refund_of     INTEGER REFERENCES sales(id),
  closure_id    INTEGER REFERENCES closures(id),
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_lines (
  id          INTEGER PRIMARY KEY,
  sale_id     INTEGER NOT NULL REFERENCES sales(id),
  product_id  INTEGER REFERENCES products(id),
  label       TEXT NOT NULL,
  quantity    INTEGER NOT NULL,
  unit_price  INTEGER NOT NULL,           -- TTC unitaire
  discount    INTEGER NOT NULL DEFAULT 0, -- remise TTC sur la ligne
  vat_rate    INTEGER NOT NULL,
  total       INTEGER NOT NULL,           -- TTC après remises (ligne + part de remise globale)
  total_ht    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_payments (
  id                INTEGER PRIMARY KEY,
  sale_id           INTEGER NOT NULL REFERENCES sales(id),
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
  amount            INTEGER NOT NULL
);

-- Coupons de réduction saisis en caisse
CREATE TABLE IF NOT EXISTS coupons (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label       TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('percent', 'amount')),
  value       INTEGER NOT NULL,          -- points de base (percent) ou centimes (amount)
  min_total   INTEGER NOT NULL DEFAULT 0,
  max_uses    INTEGER,                   -- NULL = illimité
  expires_at  TEXT,                      -- date AAAA-MM-JJ incluse
  active      INTEGER NOT NULL DEFAULT 1
);

-- Clôture de caisse (ticket Z)
CREATE TABLE IF NOT EXISTS closures (
  id            INTEGER PRIMARY KEY,
  number        INTEGER NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  first_sale    INTEGER,
  last_sale     INTEGER,
  sales_count   INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  total_ht      INTEGER NOT NULL,
  cash_counted  INTEGER,
  report        TEXT NOT NULL,           -- JSON détaillé (TVA, paiements, vendeurs)
  grand_total   INTEGER NOT NULL,        -- cumul perpétuel depuis la mise en service
  hash          TEXT NOT NULL
);

-- Journal des événements (connexion, annulation, ouverture tiroir, etc.)
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seller_id  INTEGER,
  action     TEXT NOT NULL,
  details    TEXT
);
`;

const DEFAULTS = {
  settings: {
    shop_name: 'Ma boutique',
    shop_address: '',
    shop_siret: '',
    shop_vat_number: '',
    shop_phone: '',
    shop_email: '',
    shop_website: '',
    ticket_header: '',
    ticket_footer: 'Merci de votre visite !',
    currency: 'EUR',
  },
  vatRates: [
    ['Taux normal 20 %', 2000],
    ['Taux intermédiaire 10 %', 1000],
    ['Taux réduit 5,5 %', 550],
    ['Taux particulier 2,1 %', 210],
    ['Exonéré 0 %', 0],
  ],
  // [nom, code, rendu monnaie, compte client]
  paymentMethods: [
    ['Espèces', 'CASH', 1, 0],
    ['Carte Bleue', 'CARD', 0, 0],
    ['Chèque', 'CHECK', 0, 0],
    ['Virement', 'TRANSFER', 0, 0],
    ['Compte client', 'ACCOUNT', 0, 1],
  ],
};

export function openDatabase(path = process.env.DB_PATH || 'data/caisse.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  applyDefaults(db);
  return db;
}

function applyDefaults(db) {
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULTS.settings)) insertSetting.run(key, value);

  if (db.prepare('SELECT COUNT(*) AS n FROM vat_rates').get().n === 0) {
    const ins = db.prepare('INSERT INTO vat_rates (label, rate) VALUES (?, ?)');
    for (const [label, rate] of DEFAULTS.vatRates) ins.run(label, rate);
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM payment_methods').get().n === 0) {
    const ins = db.prepare(
      'INSERT INTO payment_methods (name, code, gives_change, is_account, position) VALUES (?, ?, ?, ?, ?)',
    );
    DEFAULTS.paymentMethods.forEach(([name, code, change, account], i) => ins.run(name, code, change, account, i));
  }
}

// Exécute fn dans une transaction SQLite (node:sqlite n'a pas de helper natif).
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function logAction(db, action, details = null, sellerId = null) {
  db.prepare('INSERT INTO audit_log (action, details, seller_id) VALUES (?, ?, ?)').run(
    action,
    details == null ? null : JSON.stringify(details),
    sellerId,
  );
}
