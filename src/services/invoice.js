import { formatEuros } from '../money.js';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (bp) => `${(bp / 100).toLocaleString('fr-FR')} %`;

// Génère une facture HTML autonome à partir d'un ticket.
export function renderInvoice(sale, shop) {
  const date = new Date(sale.created_at);
  const vat = new Map();
  for (const l of sale.lines) {
    const v = vat.get(l.vat_rate) ?? { ht: 0, ttc: 0 };
    v.ht += l.total_ht;
    v.ttc += l.total;
    vat.set(l.vat_rate, v);
  }
  const title = sale.refund_of ? 'Facture d\'avoir' : 'Facture';

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title} ${sale.number}</title>
<style>
  body { font-family: system-ui, sans-serif; color: #111; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
  header { display: flex; justify-content: space-between; gap: 2rem; }
  h1 { margin: 0 0 .5rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
  th, td { padding: .4rem; border-bottom: 1px solid #ddd; text-align: left; }
  .num { text-align: right; }
  .totals { margin-left: auto; width: 320px; }
  footer { margin-top: 2rem; font-size: .8rem; color: #555; }
  @media print { .noprint { display: none; } body { margin: 0; } }
</style></head><body>
<p class="noprint"><button onclick="print()">Imprimer / Enregistrer en PDF</button></p>
<header>
  <div>
    <strong>${esc(shop.shop_name)}</strong><br>
    ${esc(shop.shop_address).replace(/\n/g, '<br>')}<br>
    ${shop.shop_phone ? `Tél. ${esc(shop.shop_phone)}<br>` : ''}
    ${shop.shop_email ? `${esc(shop.shop_email)}<br>` : ''}
    ${shop.shop_website ? `${esc(shop.shop_website)}<br>` : ''}
    ${shop.shop_siret ? `SIRET ${esc(shop.shop_siret)}<br>` : ''}
    ${shop.shop_vat_number ? `TVA intracom. ${esc(shop.shop_vat_number)}` : ''}
  </div>
  <div>
    <h1>${title}</h1>
    N° F-${String(sale.number).padStart(6, '0')}<br>
    Date : ${date.toLocaleDateString('fr-FR')}<br>
    Ticket n° ${sale.number}
    ${sale.customer_name ? `<p><strong>Client :</strong><br>${esc(sale.customer_name)}<br>${esc(sale.customer_address).replace(/\n/g, '<br>')}</p>` : ''}
  </div>
</header>
<table>
  <thead><tr><th>Désignation</th><th class="num">Qté</th><th class="num">PU TTC</th><th class="num">Remise</th><th class="num">TVA</th><th class="num">Total HT</th><th class="num">Total TTC</th></tr></thead>
  <tbody>
  ${sale.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="num">${l.quantity}</td><td class="num">${formatEuros(l.unit_price)}</td>
    <td class="num">${l.discount ? formatEuros(l.discount) : ''}</td><td class="num">${pct(l.vat_rate)}</td>
    <td class="num">${formatEuros(l.total_ht)}</td><td class="num">${formatEuros(l.total)}</td></tr>`).join('')}
  </tbody>
</table>
<table class="totals">
  ${[...vat].map(([rate, v]) => `<tr><td>TVA ${pct(rate)} sur ${formatEuros(v.ht)}</td><td class="num">${formatEuros(v.ttc - v.ht)}</td></tr>`).join('')}
  ${sale.discount ? `<tr><td>Dont remise globale${sale.coupon_code ? ` (${esc(sale.coupon_code)})` : ''}</td><td class="num">${formatEuros(sale.discount)}</td></tr>` : ''}
  <tr><td>Total HT</td><td class="num">${formatEuros(sale.total_ht)}</td></tr>
  <tr><td><strong>Total TTC</strong></td><td class="num"><strong>${formatEuros(sale.total)}</strong></td></tr>
  ${sale.payments.map((p) => `<tr><td>Réglé par ${esc(p.name)}</td><td class="num">${formatEuros(p.amount)}</td></tr>`).join('')}
</table>
<footer>${esc(shop.ticket_footer)}</footer>
</body></html>`;
}
