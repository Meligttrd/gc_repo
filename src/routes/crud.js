import { Router } from 'express';
import { ValidationError } from '../services/sales.js';

// Routeur CRUD générique pour les tables de référentiel (articles, catégories, clients...).
// `fields` liste les colonnes modifiables ; `required` celles obligatoires à la création.
export function crudRouter(db, { table, fields, required = [], orderBy = 'id', softDelete = false }) {
  const router = Router();

  const pick = (body) => {
    const out = {};
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
    return out;
  };

  router.get('/', (req, res) => {
    const where = softDelete && req.query.all !== '1' ? 'WHERE active = 1' : '';
    res.json(db.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${orderBy}`).all());
  });

  router.get('/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Introuvable' });
    res.json(row);
  });

  router.post('/', (req, res) => {
    const data = pick(req.body);
    for (const f of required) {
      if (data[f] === undefined || data[f] === '') throw new ValidationError(`Champ obligatoire : ${f}`);
    }
    const cols = Object.keys(data);
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...Object.values(data));
    res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(lastInsertRowid));
  });

  router.put('/:id', (req, res) => {
    const data = pick(req.body);
    const cols = Object.keys(data);
    if (cols.length) {
      db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
        ...Object.values(data),
        req.params.id,
      );
    }
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Introuvable' });
    res.json(row);
  });

  router.delete('/:id', (req, res) => {
    // Les éléments référencés par des tickets ne sont jamais supprimés physiquement.
    if (softDelete) db.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(req.params.id);
    else db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.status(204).end();
  });

  return router;
}
