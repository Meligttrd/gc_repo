// Remplit la base avec un jeu de données de démonstration (uniquement si elle est vide).
import { openDatabase } from '../src/db.js';

const db = openDatabase();
if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) {
  console.log('La base contient déjà des articles : rien à faire.');
  process.exit(0);
}

const categories = [
  ['Boissons chaudes', '#b45309'],
  ['Boissons fraîches', '#0284c7'],
  ['Viennoiseries', '#ca8a04'],
  ['Épicerie', '#16a34a'],
];
const products = {
  'Boissons chaudes': [['Café', 150, 1000], ['Café crème', 250, 1000], ['Thé', 250, 1000], ['Chocolat chaud', 300, 1000]],
  'Boissons fraîches': [['Eau minérale 50 cl', 150, 550], ['Jus d\'orange', 300, 550], ['Soda 33 cl', 250, 550]],
  Viennoiseries: [['Croissant', 120, 550], ['Pain au chocolat', 140, 550], ['Chausson aux pommes', 180, 550]],
  'Épicerie': [['Miel 250 g', 890, 550], ['Confiture maison', 650, 550], ['Sac cabas', 200, 2000]],
};

const insCat = db.prepare('INSERT INTO categories (name, color, position) VALUES (?, ?, ?)');
const insProd = db.prepare('INSERT INTO products (name, category_id, price, vat_rate, position) VALUES (?, ?, ?, ?, ?)');
categories.forEach(([name, color], i) => {
  const catId = insCat.run(name, color, i).lastInsertRowid;
  products[name].forEach(([pname, price, vat], j) => insProd.run(pname, catId, price, vat, j));
});

db.prepare("INSERT INTO sellers (name, pin) VALUES ('Gérant', '1234'), ('Vendeur', NULL)").run();
db.prepare("INSERT INTO customers (first_name, last_name, email, phone) VALUES ('Marie', 'Dupont', 'marie@example.com', '0600000000')").run();
db.prepare("INSERT INTO coupons (code, label, kind, value) VALUES ('BIENVENUE10', 'Bienvenue -10 %', 'percent', 1000)").run();

console.log('Données de démonstration créées (vendeur « Gérant », PIN 1234).');
