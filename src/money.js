// Utilitaires de calcul monétaire. Montants en centimes, taux de TVA en points de base.

export function htFromTtc(ttc, vatRate) {
  return Math.round((ttc * 10000) / (10000 + vatRate));
}

// Répartit `amount` proportionnellement aux `weights` en garantissant que la somme
// des parts vaut exactement `amount` (méthode du plus grand reste).
export function allocate(amount, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const parts = raw.map((x) => Math.trunc(x));
  let rest = amount - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: Math.abs(x - Math.trunc(x)) }))
    .sort((a, b) => b.frac - a.frac);
  const step = Math.sign(rest);
  for (let k = 0; rest !== 0; k = (k + 1) % order.length) {
    parts[order[k].i] += step;
    rest -= step;
  }
  return parts;
}

export function formatEuros(cents) {
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}
