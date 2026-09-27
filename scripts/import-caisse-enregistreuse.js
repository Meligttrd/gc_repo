// Import des données de référence depuis caisse.enregistreuse.fr : catégories (rayons),
// articles, clients, vendeurs.
//
// Deux sources possibles :
//   1. L'API de caisse.enregistreuse.fr (CE_SHOP_ID + CE_API_KEY dans .env)
//        npm run import:ce
//   2. Des exports JSON ou CSV déposés dans data/import/ (categories.*, products.*,
//      customers.*, sellers.*), par exemple exportés depuis l'interface de gestion
//        npm run import:ce -- --dir data/import
//
// L'import est idempotent : chaque enregistrement garde son identifiant d'origine
// (colonne external_id) et est mis à jour s'il existe déjà.
// ⚠ Les noms des services de l'API et des champs sont à vérifier sur la documentation
// de votre compte (menu Paramètres > API). Ils se règlent dans ENDPOINTS et FIELDS ci-dessous.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, transaction } from '../src/db.js';

const ENDPOINTS = {
  categories: '/workers/getDepartments.php',
  products: '/workers/getPlus.php',
  customers: '/workers/getClients.php',
  sellers: '/workers/getSellers.php',
};

// Pour chaque champ local, liste des noms possibles côté source (le premier trouvé est utilisé).
const FIELDS = {
  id: ['id', 'ID', 'idplu', 'iddepartment', 'idclient', 'idseller', 'code'],
  name: ['name', 'nom', 'designation', 'libelle', 'title', 'label'],
  category: ['department', 'departement', 'iddepartment', 'rayon', 'category', 'categorie', 'idcategory'],
  price: ['price', 'prix', 'prixttc', 'price_ttc', 'pu', 'tarif'],
  vat: ['vat', 'tva', 'taux_tva', 'vatrate', 'tax'],
  barcode: ['barcode', 'codebarre', 'code_barre', 'ean', 'gencod'],
  stock: ['stock', 'quantite_stock', 'qty'],
  color: ['color', 'couleur'],
  first_name: ['firstname', 'first_name', 'prenom'],
  last_name: ['lastname', 'last_name', 'nom', 'name'],
  email: ['email', 'mail', 'courriel'],
  phone: ['phone', 'telephone', 'tel', 'mobile'],
  address: ['address', 'adresse'],
  pin: ['pin', 'code', 'password'],
};

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const importDir = dirIndex >= 0 ? args[dirIndex + 1] : null;
const dryRun = args.includes('--dry-run');

function pick(row, key) {
  for (const k of FIELDS[key]) {
    const v = row[k] ?? row[k.toUpperCase()];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// "12,50" / "12.5" / 12.5 -> 1250
function toCents(v) {
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(/\s|€/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

// "20" / "20,0" / 0.2 / "5.5" -> points de base (2000, 550)
function toVatBp(v) {
  if (v === undefined) return 2000;
  let n = Number(String(v).replace('%', '').replace(',', '.'));
  if (!Number.isFinite(n)) return 2000;
  if (n > 0 && n < 1) n *= 100;
  return Math.round(n * 100);
}

// Parseur CSV minimal (séparateur ; ou , auto-détecté, guillemets gérés).
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((x) => x.trim() !== ''));
  const keys = header.map((h) => h.trim().replace(/^﻿/, '').toLowerCase());
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]?.trim()])));
}

function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['data', 'result', 'results', 'items', 'list']) if (Array.isArray(data[key])) return data[key];
    return Object.values(data).filter((v) => v && typeof v === 'object');
  }
  return [];
}

async function fetchFromApi(kind) {
  const base = process.env.CE_BASE_URL || 'https://caisse.enregistreuse.fr';
  const url = new URL(ENDPOINTS[kind], base);
  url.searchParams.set('idboutique', process.env.CE_SHOP_ID);
  url.searchParams.set('key', process.env.CE_API_KEY);
  url.searchParams.set('format', 'json');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${kind} : HTTP ${res.status} sur ${url.pathname}`);
  return normalizeList(await res.json());
}

function readFromDir(kind) {
  for (const ext of ['json', 'csv']) {
    const file = join(importDir, `${kind}.${ext}`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    return ext === 'json' ? normalizeList(JSON.parse(text)) : parseCsv(text);
  }
  return null;
}

async function load(kind) {
  if (importDir) return readFromDir(kind);
  try {
    return await fetchFromApi(kind);
  } catch (err) {
    console.warn(`  ⚠ ${err.message}`);
    return null;
  }
}

function upsert(db, table, externalId, data) {
  const existing = externalId != null
    ? db.prepare(`SELECT id FROM ${table} WHERE external_id = ?`).get(String(externalId))
    : null;
  const cols = Object.keys(data).filter((k) => data[k] !== undefined);
  if (existing) {
    db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => data[c]), existing.id);
    return { id: existing.id, created: false };
  }
  const allCols = externalId != null ? [...cols, 'external_id'] : cols;
  const values = cols.map((c) => data[c]);
  if (externalId != null) values.push(String(externalId));
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO ${table} (${allCols.join(',')}) VALUES (${allCols.map(() => '?').join(',')})`)
    .run(...values);
  return { id: Number(lastInsertRowid), created: true };
}

async function main() {
  if (!importDir && (!process.env.CE_SHOP_ID || !process.env.CE_API_KEY)) {
    console.error('Renseignez CE_SHOP_ID et CE_API_KEY dans .env, ou utilisez --dir <dossier> avec des exports.');
    process.exit(1);
  }
  const db = openDatabase();
  const sources = {};
  for (const kind of Object.keys(ENDPOINTS)) {
    console.log(`Lecture : ${kind}…`);
    sources[kind] = await load(kind);
    console.log(`  ${sources[kind] ? sources[kind].length : 0} enregistrement(s)`);
  }
  if (dryRun) {
    for (const [kind, rows] of Object.entries(sources)) {
      if (rows?.length) console.log(`\nExemple ${kind} :`, rows[0]);
    }
    return;
  }

  const stats = {};
  const count = (kind, r) => {
    stats[kind] ??= { créés: 0, 'mis à jour': 0 };
    stats[kind][r.created ? 'créés' : 'mis à jour']++;
  };

  transaction(db, () => {
    const catByExternal = new Map();
    for (const row of sources.categories ?? []) {
      const name = pick(row, 'name');
      if (!name) continue;
      const ext = pick(row, 'id') ?? name;
      const r = upsert(db, 'categories', ext, { name, color: pick(row, 'color') });
      catByExternal.set(String(ext), r.id);
      catByExternal.set(String(name).toLowerCase(), r.id);
      count('categories', r);
    }
    for (const row of sources.products ?? []) {
      const name = pick(row, 'name');
      const price = toCents(pick(row, 'price'));
      if (!name || price === undefined) continue;
      const cat = pick(row, 'category');
      const stock = pick(row, 'stock');
      const r = upsert(db, 'products', pick(row, 'id') ?? name, {
        name,
        price,
        vat_rate: toVatBp(pick(row, 'vat')),
        category_id: cat != null ? catByExternal.get(String(cat)) ?? catByExternal.get(String(cat).toLowerCase()) ?? null : null,
        barcode: pick(row, 'barcode'),
        stock: stock !== undefined && Number.isFinite(Number(stock)) ? Math.trunc(Number(stock)) : undefined,
        color: pick(row, 'color'),
      });
      count('products', r);
    }
    for (const row of sources.customers ?? []) {
      const lastName = pick(row, 'last_name');
      if (!lastName) continue;
      const r = upsert(db, 'customers', pick(row, 'id'), {
        last_name: lastName,
        first_name: pick(row, 'first_name'),
        email: pick(row, 'email'),
        phone: pick(row, 'phone'),
        address: pick(row, 'address'),
      });
      count('customers', r);
    }
    for (const row of sources.sellers ?? []) {
      const name = pick(row, 'name');
      if (!name) continue;
      const existing = db.prepare('SELECT id FROM sellers WHERE name = ?').get(name);
      if (!existing) db.prepare('INSERT INTO sellers (name) VALUES (?)').run(name);
      count('sellers', { created: !existing });
    }
  });

  console.log('\nImport terminé :');
  console.table(stats);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
