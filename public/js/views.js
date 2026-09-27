import {
  api, eur, pct, esc, $, $$, toast, modal, confirmBox, formBox, parseEuros, centsToInput, fmtDate,
  printTicket, emailInvoice, invoiceUrl,
} from './util.js';
import { state, loadReferentials } from './state.js';
import { showReceipt } from './pos.js';

// ============================================================================
// Tickets : historique, réimpression, facture, remboursement
// ============================================================================
export async function renderTickets(root) {
  root.innerHTML = `<div class="page"><h2>Tickets</h2>
    <div class="card row">
      <label>Du <input type="date" id="t-from"></label>
      <label>Au <input type="date" id="t-to"></label>
      <button id="t-go" class="primary">Filtrer</button>
    </div>
    <div class="card"><table><thead><tr><th>N°</th><th>Date</th><th>Vendeur</th><th>Client</th><th class="num">Total</th><th></th></tr></thead>
    <tbody id="t-body"></tbody></table></div></div>`;
  const load = async () => {
    const q = new URLSearchParams();
    if ($('#t-from').value) q.set('from', $('#t-from').value);
    if ($('#t-to').value) q.set('to', nextDay($('#t-to').value));
    q.set('limit', '300');
    const sales = await api(`/sales?${q}`);
    $('#t-body').innerHTML = sales.map((s) => `<tr class="clickable ${s.refund_of ? 'refund' : ''}" data-id="${s.id}">
      <td>${s.number}</td><td>${fmtDate(s.created_at)}</td><td>${esc(s.seller_name ?? '')}</td>
      <td>${esc(s.customer_name ?? '')}</td><td class="num">${eur(s.total)}</td>
      <td>${s.refund_of ? '<span class="tag red">Avoir</span>' : ''} ${s.closure_id ? '<span class="tag">Clôturé</span>' : ''}</td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">Aucun ticket</td></tr>';
    $$('#t-body tr[data-id]').forEach((tr) => { tr.onclick = () => ticketDetail(Number(tr.dataset.id), load); });
  };
  $('#t-go').onclick = load;
  await load();
}

const nextDay = (d) => new Date(new Date(d).getTime() + 86400000).toISOString().slice(0, 10);

async function ticketDetail(id, reload) {
  const sale = await api(`/sales/${id}`);
  await modal((el, close) => {
    el.innerHTML = `<h3>${sale.refund_of ? 'Avoir' : 'Ticket'} n° ${sale.number}</h3>
      <p class="muted">${fmtDate(sale.created_at)}${sale.seller_name ? ` · ${esc(sale.seller_name)}` : ''}</p>
      <table>${sale.lines.map((l) => `<tr><td>${l.quantity} × ${esc(l.label)}${l.discount ? ` <span class="tag">-${eur(l.discount)}</span>` : ''}</td>
        <td class="num">${eur(l.total)}</td></tr>`).join('')}
        <tr><td><strong>Total</strong></td><td class="num"><strong>${eur(sale.total)}</strong></td></tr>
        ${sale.payments.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${eur(p.amount)}</td></tr>`).join('')}
      </table>
      ${sale.note ? `<p>📝 ${esc(sale.note)}</p>` : ''}
      ${sale.refunded_by ? `<p class="tag red">Annulé par l'avoir n° ${sale.refunded_by.number}</p>` : ''}
      <div class="row">
        <button type="button" data-print>🖨 Réimprimer</button>
        <button type="button" data-invoice>Facture</button>
        <button type="button" data-email>✉ Email</button>
        ${!sale.refund_of && !sale.refunded_by ? '<button type="button" class="danger" data-refund>Rembourser</button>' : ''}
      </div>
      <div class="modal-actions"><button value="">Fermer</button></div>`;
    $('[data-print]', el).onclick = () => printTicket(sale, state.settings);
    $('[data-invoice]', el).onclick = () => window.open(invoiceUrl(sale), '_blank');
    $('[data-email]', el).onclick = () => emailInvoice(sale, state.settings);
    const refundBtn = $('[data-refund]', el);
    if (refundBtn) refundBtn.onclick = () => close('refund');
  }).then(async (action) => {
    if (action !== 'refund') return;
    const res = await formBox(`Rembourser le ticket n° ${sale.number} (${eur(sale.total)})`, [
      { name: 'method', label: 'Mode de remboursement', type: 'select', value: '',
        options: [{ value: '', label: 'Mêmes modes que la vente' },
          ...state.paymentMethods.filter((m) => !m.is_account || sale.customer_id).map((m) => ({ value: m.id, label: m.name }))] },
      { name: 'note', label: 'Motif', value: '' },
    ], 'Rembourser');
    if (!res) return;
    try {
      const refund = await api(`/sales/${sale.id}/refund`, {
        method: 'POST',
        body: { payment_method_id: res.method ? Number(res.method) : undefined, seller_id: state.seller?.id, note: res.note || undefined },
      });
      await reload();
      await showReceipt(refund);
    } catch (err) { toast(err.message, true); }
  });
}

// ============================================================================
// Clôture : rapport X (en cours) et Z (clôture définitive)
// ============================================================================
export async function renderClosure(root) {
  const [report, closures] = await Promise.all([api('/report/current'), api('/closures')]);
  root.innerHTML = `<div class="page"><h2>Clôture de caisse</h2>
    <div class="card"><div class="row"><h3 style="margin:0">Rapport X – ventes non clôturées</h3><span class="spacer"></span>
      <button id="z-print">🖨 Imprimer X</button><button id="z-close" class="primary" ${report.sales_count + report.refunds_count ? '' : 'disabled'}>Faire la clôture Z</button></div>
      ${reportHtml(report)}</div>
    <div class="card"><h3>Historique des clôtures Z</h3><table>
      <thead><tr><th>Z n°</th><th>Date</th><th class="num">Ventes</th><th class="num">Total TTC</th><th class="num">Cumul perpétuel</th></tr></thead>
      <tbody>${closures.map((c) => `<tr class="clickable" data-id="${c.id}"><td>${c.number}</td><td>${fmtDate(c.created_at)}</td>
        <td class="num">${c.sales_count}</td><td class="num">${eur(c.total)}</td><td class="num">${eur(c.grand_total)}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">Aucune clôture</td></tr>'}</tbody></table></div></div>`;

  $('#z-print').onclick = () => printReport('Rapport X', report);
  $('#z-close').onclick = async () => {
    const res = await formBox('Clôture Z', [
      { name: 'cash', label: `Espèces comptées dans le tiroir (attendu : ${eur(report.cash_expected)}) – facultatif`, inputmode: 'decimal' },
    ], 'Clôturer');
    if (!res) return;
    if (!(await confirmBox('La clôture Z est définitive. Continuer ?', 'Clôturer', true))) return;
    try {
      const z = await api('/closures', {
        method: 'POST',
        body: { cash_counted: res.cash ? parseEuros(res.cash) : null, seller_id: state.seller?.id },
      });
      printReport(`Clôture Z n° ${z.number}`, z.report, z);
      renderClosure(root);
    } catch (err) { toast(err.message, true); }
  };
  $$('tr[data-id]', root).forEach((tr) => {
    tr.onclick = async () => {
      const z = await api(`/closures/${tr.dataset.id}`);
      await modal((el) => {
        el.innerHTML = `<h3>Clôture Z n° ${z.number}</h3><p class="muted">${fmtDate(z.created_at)}</p>${reportHtml(z.report)}
          <div class="modal-actions"><button type="button" data-print>🖨 Imprimer</button><button value="">Fermer</button></div>`;
        $('[data-print]', el).onclick = () => printReport(`Clôture Z n° ${z.number}`, z.report, z);
      });
    };
  });
}

function reportHtml(r) {
  const rows = (items, cols) => items.map((i) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.f(i)}</td>`).join('')}</tr>`).join('');
  return `<div class="grid-2">
    <table>
      <tr><td>Période</td><td class="num">${r.period_start ? `${fmtDate(r.period_start)} → ${fmtDate(r.period_end)}` : '—'}</td></tr>
      <tr><td>Tickets</td><td class="num">${r.first_sale ?? '—'} à ${r.last_sale ?? '—'}</td></tr>
      <tr><td>Ventes / avoirs</td><td class="num">${r.sales_count} / ${r.refunds_count}</td></tr>
      <tr><td>Remises accordées</td><td class="num">${eur(r.discounts_total)}</td></tr>
      <tr><td>Remboursements</td><td class="num">${eur(r.refunds_total)}</td></tr>
      <tr><td>Total HT</td><td class="num">${eur(r.total_ht)}</td></tr>
      <tr><td><strong>Total TTC</strong></td><td class="num"><strong>${eur(r.total)}</strong></td></tr>
      <tr><td>Espèces attendues</td><td class="num">${eur(r.cash_expected)}</td></tr>
      ${r.cash_difference != null ? `<tr><td>Écart de caisse</td><td class="num">${eur(r.cash_difference)}</td></tr>` : ''}
    </table>
    <div>
      <table><thead><tr><th>TVA</th><th class="num">HT</th><th class="num">TVA</th><th class="num">TTC</th></tr></thead>
        ${rows(r.by_vat, [{ f: (v) => pct(v.vat_rate) }, { num: 1, f: (v) => eur(v.ht) }, { num: 1, f: (v) => eur(v.vat) }, { num: 1, f: (v) => eur(v.ttc) }])}</table>
      <table><thead><tr><th>Paiement</th><th class="num">Nb</th><th class="num">Montant</th></tr></thead>
        ${rows(r.by_payment, [{ f: (p) => esc(p.name) }, { num: 1, f: (p) => p.count }, { num: 1, f: (p) => eur(p.amount) }])}</table>
      <table><thead><tr><th>Vendeur</th><th class="num">Nb</th><th class="num">Total</th></tr></thead>
        ${rows(r.by_seller, [{ f: (s) => esc(s.name) }, { num: 1, f: (s) => s.count }, { num: 1, f: (s) => eur(s.total) }])}</table>
      <table><thead><tr><th>Catégorie</th><th class="num">Qté</th><th class="num">Total</th></tr></thead>
        ${rows(r.by_category, [{ f: (c) => esc(c.name) }, { num: 1, f: (c) => c.quantity }, { num: 1, f: (c) => eur(c.total) }])}</table>
    </div></div>`;
}

function printReport(title, r, z = null) {
  const s = state.settings;
  const line = (a, b) => `<div class="line"><span>${a}</span><span>${b}</span></div>`;
  $('#print-area').innerHTML = `<div class="ticket"><div class="center"><strong>${esc(s.shop_name)}</strong><br>${esc(title)}<br>
    ${fmtDate(z?.created_at ?? new Date().toISOString())}</div><hr>
    ${line('Tickets', `${r.first_sale ?? '-'} à ${r.last_sale ?? '-'}`)}
    ${line('Ventes', r.sales_count)}${line('Avoirs', `${r.refunds_count} (${eur(r.refunds_total)})`)}
    ${line('Remises', eur(r.discounts_total))}<hr>
    ${r.by_vat.map((v) => line(`TVA ${pct(v.vat_rate)} HT ${eur(v.ht)}`, eur(v.vat))).join('')}
    ${line('Total HT', eur(r.total_ht))}${line('<strong>TOTAL TTC</strong>', `<strong>${eur(r.total)}</strong>`)}<hr>
    ${r.by_payment.map((p) => line(esc(p.name), eur(p.amount))).join('')}
    ${line('Espèces attendues', eur(r.cash_expected))}
    ${r.cash_difference != null ? line('Écart', eur(r.cash_difference)) : ''}
    ${z ? `<hr>${line('Cumul perpétuel', eur(z.grand_total))}<div class="center" style="font-size:9px">Empreinte ${z.hash.slice(0, 16)}</div>` : ''}
  </div>`;
  window.print();
}

// ============================================================================
// Outil générique de liste + formulaire pour les référentiels
// ============================================================================
async function crudSection(container, { title, endpoint, columns, fields, toBody, onRow }) {
  const items = await api(endpoint);
  container.innerHTML = `<div class="card"><div class="row"><h3 style="margin:0">${esc(title)}</h3><span class="spacer"></span>
    <button class="primary" data-add>+ Ajouter</button></div>
    <table><thead><tr>${columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${items.map((it) => `<tr class="clickable" data-id="${it.id}">${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${c.f(it)}</td>`).join('')}
      <td class="right"><button class="ghost" data-del="${it.id}">🗑</button></td></tr>`).join('')
      || `<tr><td colspan="${columns.length + 1}" class="muted">Aucun élément</td></tr>`}</tbody></table></div>`;

  const reload = () => crudSection(container, { title, endpoint, columns, fields, toBody, onRow });
  const edit = async (item) => {
    const res = await formBox(item ? `Modifier – ${title}` : `Ajouter – ${title}`, fields(item ?? {}));
    if (!res) return;
    try {
      await api(item ? `${endpoint}/${item.id}` : endpoint, { method: item ? 'PUT' : 'POST', body: toBody(res) });
      await loadReferentials();
      toast('Enregistré');
      reload();
    } catch (err) { toast(err.message, true); }
  };
  $('[data-add]', container).onclick = () => edit(null);
  $$('tr[data-id]', container).forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest('[data-del]')) return;
      const item = items.find((i) => i.id === Number(tr.dataset.id));
      return onRow ? onRow(item, () => edit(item), reload) : edit(item);
    };
  });
  $$('[data-del]', container).forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmBox('Supprimer cet élément ?', 'Supprimer', true))) return;
      await api(`${endpoint}/${b.dataset.del}`, { method: 'DELETE' });
      await loadReferentials();
      reload();
    };
  });
}

const nullIfEmpty = (v) => (v === '' || v == null ? null : v);
const vatOptions = () => state.vatRates.map((v) => ({ value: v.rate, label: v.label }));

// ============================================================================
// Articles, catégories, coupons
// ============================================================================
export async function renderArticles(root) {
  root.innerHTML = '<div class="page"><h2>Articles</h2><div id="a-products"></div><div id="a-cats"></div><div id="a-coupons"></div></div>';
  const catName = (id) => state.categories.find((c) => c.id === id)?.name ?? '';

  await crudSection($('#a-products'), {
    title: 'Articles',
    endpoint: '/products',
    columns: [
      { label: 'Nom', f: (p) => esc(p.name) },
      { label: 'Catégorie', f: (p) => esc(catName(p.category_id)) },
      { label: 'Prix TTC', num: 1, f: (p) => eur(p.price) },
      { label: 'TVA', num: 1, f: (p) => pct(p.vat_rate) },
      { label: 'Stock', num: 1, f: (p) => p.stock ?? '—' },
      { label: 'Code-barres', f: (p) => esc(p.barcode ?? '') },
    ],
    fields: (p) => [
      { name: 'name', label: 'Nom', value: p.name, required: true },
      { name: 'category_id', label: 'Catégorie', type: 'select', value: p.category_id ?? '',
        options: [{ value: '', label: '— Aucune —' }, ...state.categories.map((c) => ({ value: c.id, label: c.name }))] },
      { name: 'price', label: 'Prix TTC (€)', inputmode: 'decimal', value: p.price != null ? centsToInput(p.price) : '', required: true },
      { name: 'vat_rate', label: 'TVA', type: 'select', value: p.vat_rate ?? 2000, options: vatOptions() },
      { name: 'stock', label: 'Stock (vide = non suivi)', type: 'number', value: p.stock ?? '' },
      { name: 'barcode', label: 'Code-barres', value: p.barcode ?? '' },
      { name: 'color', label: 'Couleur du bouton', type: 'color', value: p.color ?? '#4f46e5' },
      { name: 'position', label: 'Ordre d\'affichage', type: 'number', value: p.position ?? 0 },
    ],
    toBody: (r) => ({
      name: r.name,
      category_id: r.category_id ? Number(r.category_id) : null,
      price: parseEuros(r.price),
      vat_rate: Number(r.vat_rate),
      stock: r.stock === '' ? null : Number(r.stock),
      barcode: nullIfEmpty(r.barcode),
      color: r.color,
      position: Number(r.position) || 0,
    }),
  });

  await crudSection($('#a-cats'), {
    title: 'Catégories',
    endpoint: '/categories',
    columns: [
      { label: 'Nom', f: (c) => `<span class="tag" style="background:${esc(c.color)};color:#fff">${esc(c.name)}</span>` },
      { label: 'Ordre', num: 1, f: (c) => c.position },
    ],
    fields: (c) => [
      { name: 'name', label: 'Nom', value: c.name, required: true },
      { name: 'color', label: 'Couleur', type: 'color', value: c.color ?? '#4f46e5' },
      { name: 'position', label: 'Ordre d\'affichage', type: 'number', value: c.position ?? 0 },
    ],
    toBody: (r) => ({ name: r.name, color: r.color, position: Number(r.position) || 0 }),
  });

  await crudSection($('#a-coupons'), {
    title: 'Coupons',
    endpoint: '/coupons',
    columns: [
      { label: 'Code', f: (c) => `<strong>${esc(c.code)}</strong>` },
      { label: 'Libellé', f: (c) => esc(c.label ?? '') },
      { label: 'Remise', num: 1, f: (c) => (c.kind === 'percent' ? pct(c.value) : eur(c.value)) },
      { label: 'Minimum', num: 1, f: (c) => (c.min_total ? eur(c.min_total) : '—') },
      { label: 'Utilisations max', num: 1, f: (c) => c.max_uses ?? '∞' },
      { label: 'Expire le', f: (c) => c.expires_at ?? '—' },
    ],
    fields: (c) => [
      { name: 'code', label: 'Code', value: c.code, required: true },
      { name: 'label', label: 'Libellé', value: c.label ?? '' },
      { name: 'kind', label: 'Type', type: 'select', value: c.kind ?? 'percent',
        options: [{ value: 'percent', label: 'Pourcentage' }, { value: 'amount', label: 'Montant fixe' }] },
      { name: 'value', label: 'Valeur (% ou €)', inputmode: 'decimal', required: true,
        value: c.value != null ? centsToInput(c.value) : '' },
      { name: 'min_total', label: 'Montant minimum d\'achat (€)', inputmode: 'decimal', value: c.min_total ? centsToInput(c.min_total) : '' },
      { name: 'max_uses', label: 'Nombre d\'utilisations max (vide = illimité)', type: 'number', value: c.max_uses ?? '' },
      { name: 'expires_at', label: 'Date d\'expiration', type: 'date', value: c.expires_at ?? '' },
    ],
    // % et € sont tous deux stockés ×100 (points de base / centimes).
    toBody: (r) => ({
      code: r.code.trim().toUpperCase(),
      label: nullIfEmpty(r.label),
      kind: r.kind,
      value: parseEuros(r.value),
      min_total: parseEuros(r.min_total || '0'),
      max_uses: r.max_uses === '' ? null : Number(r.max_uses),
      expires_at: nullIfEmpty(r.expires_at),
    }),
  });
}

// ============================================================================
// Clients et comptes clients
// ============================================================================
export async function renderCustomers(root) {
  root.innerHTML = '<div class="page"><h2>Clients</h2><div id="c-list"></div></div>';
  await crudSection($('#c-list'), {
    title: 'Clients',
    endpoint: '/customers',
    columns: [
      { label: 'Nom', f: (c) => esc(`${c.last_name} ${c.first_name ?? ''}`) },
      { label: 'Téléphone', f: (c) => esc(c.phone ?? '') },
      { label: 'Email', f: (c) => esc(c.email ?? '') },
    ],
    fields: (c) => [
      { name: 'last_name', label: 'Nom', value: c.last_name, required: true },
      { name: 'first_name', label: 'Prénom', value: c.first_name ?? '' },
      { name: 'phone', label: 'Téléphone', type: 'tel', value: c.phone ?? '' },
      { name: 'email', label: 'Email', type: 'email', value: c.email ?? '' },
      { name: 'address', label: 'Adresse', type: 'textarea', value: c.address ?? '' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: c.notes ?? '' },
    ],
    toBody: (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, nullIfEmpty(v)])),
    onRow: customerAccount,
  });
}

async function customerAccount(customer, edit, reload) {
  const account = await api(`/customers/${customer.id}/account`);
  const action = await modal((el, close) => {
    el.innerHTML = `<h3>${esc(`${customer.first_name ?? ''} ${customer.last_name}`)}</h3>
      <p>${esc(customer.phone ?? '')} ${esc(customer.email ?? '')}</p>
      <div class="cart-total"><span>Solde du compte</span><span>${eur(account.balance)}</span></div>
      <p class="muted">${account.balance > 0 ? 'Montant dû par le client.' : account.balance < 0 ? 'Crédit en faveur du client.' : 'Compte soldé.'}</p>
      <h4>Derniers tickets</h4>
      <table>${account.sales.map((s) => `<tr><td>n° ${s.number}</td><td>${fmtDate(s.created_at)}</td><td class="num">${eur(s.total)}</td></tr>`).join('')
        || '<tr><td class="muted">Aucun achat</td></tr>'}</table>
      <div class="modal-actions">
        <button type="button" data-edit>Modifier</button>
        ${account.balance > 0 ? '<button type="button" class="primary" data-settle>Encaisser un règlement</button>' : ''}
        <button value="">Fermer</button></div>`;
    $('[data-edit]', el).onclick = () => close('edit');
    const s = $('[data-settle]', el);
    if (s) s.onclick = () => close('settle');
  });
  if (action === 'edit') return edit();
  if (action !== 'settle') return;
  const res = await formBox('Règlement du compte client', [
    { name: 'amount', label: 'Montant (€)', inputmode: 'decimal', value: centsToInput(account.balance), required: true },
    { name: 'method', label: 'Mode de paiement', type: 'select',
      options: state.paymentMethods.filter((m) => !m.is_account).map((m) => ({ value: m.id, label: m.name })) },
  ], 'Encaisser');
  if (!res) return;
  try {
    const sale = await api(`/customers/${customer.id}/settle`, {
      method: 'POST',
      body: { amount: parseEuros(res.amount), payment_method_id: Number(res.method), seller_id: state.seller?.id },
    });
    await showReceipt(sale);
    reload();
  } catch (err) { toast(err.message, true); }
}

// ============================================================================
// Statistiques
// ============================================================================
export async function renderStats(root) {
  const [daily, top] = await Promise.all([api('/stats/daily?days=30'), api('/stats/top-products?days=30')]);
  const max = Math.max(1, ...daily.map((d) => d.total));
  const total = daily.reduce((s, d) => s + d.total, 0);
  const count = daily.reduce((s, d) => s + d.count, 0);
  root.innerHTML = `<div class="page"><h2>Statistiques – 30 derniers jours</h2>
    <div class="grid-2">
      <div class="card"><div class="muted">Chiffre d'affaires TTC</div><div class="big-amount" style="text-align:left">${eur(total)}</div></div>
      <div class="card"><div class="muted">Ventes · panier moyen</div><div class="big-amount" style="text-align:left">${count} · ${eur(count ? Math.round(total / count) : 0)}</div></div>
    </div>
    <div class="card"><h3>CA par jour</h3><div class="bars">${daily.map((d) =>
      `<div style="height:${Math.max(0, (d.total / max) * 100)}%" data-label="${d.day} : ${eur(d.total)}"></div>`).join('') || '<p class="muted">Pas encore de ventes</p>'}</div></div>
    <div class="card"><h3>Meilleurs articles</h3><table><thead><tr><th>Article</th><th class="num">Qté</th><th class="num">CA TTC</th></tr></thead>
      ${top.map((t) => `<tr><td>${esc(t.label)}</td><td class="num">${t.quantity}</td><td class="num">${eur(t.total)}</td></tr>`).join('')}</table></div></div>`;
}

// ============================================================================
// Paramètres : boutique, ticket, vendeurs, moyens de paiement, intégrité
// ============================================================================
export async function renderSettings(root) {
  const s = state.settings;
  const input = (key, label, type = 'text') => `<label>${label}<input name="${key}" type="${type}" value="${esc(s[key])}"></label>`;
  root.innerHTML = `<div class="page"><h2>Paramètres</h2>
    <form class="card" id="s-form"><h3>Boutique et ticket</h3>
      <div class="grid-2"><div>
        ${input('shop_name', 'Nom de la boutique')}
        <label>Adresse<textarea name="shop_address" rows="3">${esc(s.shop_address)}</textarea></label>
        ${input('shop_phone', 'Téléphone', 'tel')}${input('shop_email', 'Email', 'email')}${input('shop_website', 'Site web')}
      </div><div>
        ${input('shop_siret', 'SIRET')}${input('shop_vat_number', 'N° TVA intracommunautaire')}
        ${input('ticket_header', 'Texte en haut du ticket')}
        <label>Message en bas du ticket<textarea name="ticket_footer" rows="3">${esc(s.ticket_footer)}</textarea></label>
      </div></div>
      <button class="primary">Enregistrer</button></form>
    <div id="s-sellers"></div><div id="s-methods"></div>
    <div class="card"><h3>Intégrité des tickets</h3>
      <p class="muted">Chaque ticket est chaîné au précédent par une empreinte SHA-256. Toute modification directe de la base est détectée.</p>
      <button id="s-verify">Vérifier la chaîne</button> <span id="s-verify-res"></span></div></div>`;

  $('#s-form').onsubmit = async (e) => {
    e.preventDefault();
    await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
    await loadReferentials();
    document.getElementById('shop-name').textContent = state.settings.shop_name;
    toast('Paramètres enregistrés');
  };
  $('#s-verify').onclick = async () => {
    const r = await api('/sales/verify');
    $('#s-verify-res').innerHTML = r.ok
      ? `<span class="tag">✔ ${r.count} tickets intègres</span>`
      : `<span class="tag red">✘ Altération détectée au ticket n° ${r.broken_at}</span>`;
  };

  await crudSection($('#s-sellers'), {
    title: 'Vendeurs',
    endpoint: '/sellers',
    columns: [{ label: 'Nom', f: (v) => esc(v.name) }, { label: 'Code PIN', f: (v) => (v.pin ? '••••' : '—') }],
    fields: (v) => [
      { name: 'name', label: 'Nom', value: v.name, required: true },
      { name: 'pin', label: 'Code PIN (vide = aucun)', inputmode: 'numeric', value: v.pin ?? '' },
    ],
    toBody: (r) => ({ name: r.name, pin: nullIfEmpty(r.pin) }),
  });

  await crudSection($('#s-methods'), {
    title: 'Moyens de paiement',
    endpoint: '/payment-methods',
    columns: [
      { label: 'Nom', f: (m) => esc(m.name) },
      { label: 'Code', f: (m) => esc(m.code) },
      { label: 'Rendu monnaie', f: (m) => (m.gives_change ? 'Oui' : '') },
      { label: 'Compte client', f: (m) => (m.is_account ? 'Oui' : '') },
    ],
    fields: (m) => [
      { name: 'name', label: 'Nom', value: m.name, required: true },
      { name: 'code', label: 'Code (ex. CASH)', value: m.code, required: true },
      { name: 'gives_change', label: 'Autorise le rendu monnaie', type: 'checkbox', value: m.gives_change },
      { name: 'is_account', label: 'Paiement sur compte client', type: 'checkbox', value: m.is_account },
      { name: 'position', label: 'Ordre', type: 'number', value: m.position ?? 0 },
    ],
    toBody: (r) => ({ name: r.name, code: r.code.toUpperCase(), gives_change: r.gives_change ? 1 : 0,
      is_account: r.is_account ? 1 : 0, position: Number(r.position) || 0 }),
  });
}
