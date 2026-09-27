// --- Appels API -------------------------------------------------------------
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

// --- Montants (centimes) ------------------------------------------------------
const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
export const eur = (cents) => fmt.format((cents ?? 0) / 100);
export const pct = (bp) => `${(bp / 100).toLocaleString('fr-FR')} %`;

// "12,5" -> 1250 ; renvoie null si la saisie est invalide.
export function parseEuros(text) {
  const n = Number(String(text).replace(/\s|€/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
export const centsToInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');

// --- DOM ----------------------------------------------------------------------
export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const fmtDate = (iso) =>
  new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

let toastTimer;
export function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

// Affiche une modale. `render(el, close)` remplit le contenu ; la promesse renvoie
// la valeur passée à close().
export function modal(render) {
  const dialog = $('#modal');
  const content = $('#modal-content');
  return new Promise((resolve) => {
    let result;
    const close = (value) => { result = value; dialog.close(); };
    dialog.addEventListener('close', () => { content.innerHTML = ''; resolve(result); }, { once: true });
    content.innerHTML = '';
    content.onsubmit = null;
    render(content, close);
    dialog.showModal();
  });
}

export function confirmBox(message, okLabel = 'Confirmer', danger = false) {
  return modal((el, close) => {
    el.innerHTML = `<h3>Confirmation</h3><p>${esc(message)}</p>
      <div class="modal-actions"><button value="no">Retour</button>
      <button type="button" class="${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`;
    $('[data-ok]', el).onclick = () => close(true);
  });
}

// Formulaire générique : fields = [{ name, label, type, value, options, step }]
export function formBox(title, fields, okLabel = 'Enregistrer') {
  return modal((el, close) => {
    el.innerHTML = `<h3>${esc(title)}</h3>${fields.map(fieldHtml).join('')}
      <div class="modal-actions"><button value="">Annuler</button>
      <button type="submit" class="primary" data-ok>${esc(okLabel)}</button></div>`;
    $('[data-ok]', el).onclick = (e) => {
      e.preventDefault();
      if (!el.reportValidity()) return;
      const out = {};
      for (const f of fields) {
        const input = el.elements[f.name];
        out[f.name] = f.type === 'checkbox' ? input.checked : input.value;
      }
      close(out);
    };
    setTimeout(() => el.querySelector('input, select, textarea')?.focus(), 0);
  });
}

function fieldHtml(f) {
  const req = f.required ? 'required' : '';
  if (f.type === 'select') {
    return `<label>${esc(f.label)}<select name="${f.name}" ${req}>${f.options
      .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select></label>`;
  }
  if (f.type === 'textarea') {
    return `<label>${esc(f.label)}<textarea name="${f.name}" rows="3" ${req}>${esc(f.value)}</textarea></label>`;
  }
  if (f.type === 'checkbox') {
    return `<label><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''} style="width:auto"> ${esc(f.label)}</label>`;
  }
  return `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value)}"
    ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${req}></label>`;
}

// --- Impression du ticket de caisse (80 mm) -----------------------------------
export function ticketHtml(sale, shop) {
  const vat = new Map();
  for (const l of sale.lines) {
    const v = vat.get(l.vat_rate) ?? { ht: 0, ttc: 0 };
    v.ht += l.total_ht;
    v.ttc += l.total;
    vat.set(l.vat_rate, v);
  }
  const sub = sale.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const line = (a, b, cls = '') => `<div class="line ${cls}"><span>${a}</span><span>${b}</span></div>`;
  return `<div class="ticket">
    <div class="center"><strong>${esc(shop.shop_name)}</strong><br>
      ${esc(shop.shop_address).replace(/\n/g, '<br>')}
      ${shop.shop_phone ? `<br>Tél. ${esc(shop.shop_phone)}` : ''}
      ${shop.shop_email ? `<br>${esc(shop.shop_email)}` : ''}
      ${shop.shop_website ? `<br>${esc(shop.shop_website)}` : ''}
      ${shop.shop_siret ? `<br>SIRET ${esc(shop.shop_siret)}` : ''}
      ${shop.shop_vat_number ? `<br>TVA ${esc(shop.shop_vat_number)}` : ''}
      ${shop.ticket_header ? `<br>${esc(shop.ticket_header)}` : ''}
    </div><hr>
    ${line(`${sale.refund_of ? 'AVOIR' : 'Ticket'} n° ${sale.number}`, fmtDate(sale.created_at))}
    ${sale.seller_name ? line('Vendeur', esc(sale.seller_name)) : ''}
    ${sale.customer_name ? line('Client', esc(sale.customer_name)) : ''}
    <hr>
    ${sale.lines.map((l) => `
      ${line(`${l.quantity} x ${esc(l.label)}`, eur(l.quantity * l.unit_price))}
      ${l.quantity !== 1 ? `<div class="muted">&nbsp;&nbsp;${eur(l.unit_price)} l'unité</div>` : ''}
      ${l.discount ? line(l.discount >= Math.abs(l.quantity * l.unit_price) ? '&nbsp;&nbsp;Offert' : '&nbsp;&nbsp;Remise', `-${eur(l.discount)}`) : ''}
    `).join('')}
    <hr>
    ${sale.discount ? line('Sous-total', eur(sub - sale.lines.reduce((s, l) => s + Math.sign(l.quantity) * l.discount, 0))) : ''}
    ${sale.discount ? line(`Remise${sale.coupon_code ? ` (${esc(sale.coupon_code)})` : ''}`, `-${eur(sale.discount)}`) : ''}
    ${line('TOTAL TTC', eur(sale.total), 'big')}
    ${sale.payments.map((p) => line(esc(p.name), eur(p.amount))).join('')}
    ${sale.change_given ? line('Rendu', eur(sale.change_given)) : ''}
    <hr>
    ${[...vat].map(([rate, v]) => line(`TVA ${pct(rate)} (HT ${eur(v.ht)})`, eur(v.ttc - v.ht))).join('')}
    ${line('Total HT', eur(sale.total_ht))}
    ${sale.note ? `<hr>${esc(sale.note)}` : ''}
    <hr>
    <div class="center">${esc(shop.ticket_footer)}</div>
    <div class="center" style="font-size:9px">Empreinte ${sale.hash.slice(0, 16)}</div>
  </div>`;
}

export function printTicket(sale, shop) {
  $('#print-area').innerHTML = ticketHtml(sale, shop);
  window.print();
}

export function invoiceUrl(sale) {
  return `${location.origin}/api/sales/${sale.id}/invoice`;
}

// Ouvre la messagerie avec l'email du client et le lien vers la facture.
export function emailInvoice(sale, shop) {
  const subject = `Votre facture ${shop.shop_name} - ticket n° ${sale.number}`;
  const body = `Bonjour,\n\nVeuillez trouver votre facture ici : ${invoiceUrl(sale)}\n\nMontant : ${eur(sale.total)}\n\n${shop.ticket_footer}`;
  location.href = `mailto:${encodeURIComponent(sale.customer_email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
