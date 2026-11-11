import {
  api, eur, pct, esc, $, $$, toast, modal, confirmBox, formBox, parseEuros, centsToInput,
  printTicket, emailInvoice, invoiceUrl,
} from './util.js';
import { state } from './state.js';

const CART_KEY = 'caissegc.cart';

const emptyCart = () => ({ lines: [], discount: 0, coupon: null, note: '', customer: null });
let cart = loadCart();
let selectedKey = null;
let activeCategory = null;
let search = '';

function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || emptyCart(); } catch { return emptyCart(); }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* stockage indisponible */ }
}

// --- Calculs (miroir de src/services/sales.js, le serveur fait foi) --------------
const lineGross = (l) => l.quantity * l.unit_price - Math.sign(l.quantity) * l.discount;
function totals() {
  const subtotal = cart.lines.reduce((s, l) => s + lineGross(l), 0);
  const afterManual = subtotal - cart.discount;
  let couponAmount = 0;
  if (cart.coupon) {
    const c = cart.coupon;
    couponAmount = c.kind === 'percent' ? Math.round((afterManual * c.value) / 10000) : c.value;
    couponAmount = Math.max(0, Math.min(couponAmount, afterManual));
  }
  const gross = cart.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  return { gross, subtotal, couponAmount, total: afterManual - couponAmount };
}

// --- Rendu --------------------------------------------------------------------------
export function renderPos(root) {
  root.innerHTML = `
    <div class="pos">
      <section class="pos-catalog">
        <div class="pos-search">
          <input id="pos-search" placeholder="Rechercher un article ou scanner un code-barres…" autocomplete="off">
          <button id="free-item" title="Article à prix libre">+ Prix libre</button>
        </div>
        <div class="categories" id="categories"></div>
        <div class="products" id="products"></div>
      </section>
      <aside class="pos-cart">
        <div class="cart-head">
          <button id="btn-customer" class="spacer" style="text-align:left">👤 <span id="customer-label"></span></button>
          <button id="btn-new" title="Nouvelle commande">Nouvelle</button>
        </div>
        <div class="cart-lines" id="cart-lines"></div>
        <div class="cart-foot">
          <div id="cart-subs"></div>
          <div class="cart-total"><span>Total</span><span id="cart-total"></span></div>
          <div class="cart-actions">
            <button data-act="qty">Qté</button>
            <button data-act="price">Prix</button>
            <button data-act="line-discount">Remise</button>
            <button data-act="gift">Offert</button>
            <button data-act="remove">Suppr.</button>
            <button data-act="discount">Remise tot.</button>
            <button data-act="coupon">Coupon</button>
            <button data-act="note">Note</button>
          </div>
          <div class="row">
            <button id="btn-cancel" class="danger">Annuler</button>
            <button id="btn-pay" class="primary pay-btn spacer">Encaisser</button>
          </div>
        </div>
      </aside>
    </div>`;

  $('#pos-search').addEventListener('input', (e) => { search = e.target.value.trim().toLowerCase(); renderProducts(); });
  $('#pos-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const code = e.target.value.trim();
    const product = state.products.find((p) => p.barcode && p.barcode === code);
    if (product) { addProduct(product); e.target.value = ''; search = ''; renderProducts(); }
  });
  $('#free-item').onclick = addFreeItem;
  $('#btn-new').onclick = newOrder;
  $('#btn-cancel').onclick = cancelOrder;
  $('#btn-pay').onclick = openPayment;
  $('#btn-customer').onclick = chooseCustomer;
  $$('.cart-actions button').forEach((b) => { b.onclick = () => cartAction(b.dataset.act); });

  renderCategories();
  renderProducts();
  renderCart();
  $('#pos-search').focus();
}

function renderCategories() {
  const cats = [{ id: null, name: 'Tous', color: '#1f2937' }, ...state.categories];
  $('#categories').innerHTML = cats
    .map((c) => `<button data-id="${c.id ?? ''}" class="${c.id === activeCategory ? 'active' : ''}"
      style="border-color:${esc(c.color)};${c.id === activeCategory ? `background:${esc(c.color)}` : ''}">${esc(c.name)}</button>`)
    .join('');
  $$('#categories button').forEach((b) => {
    b.onclick = () => { activeCategory = b.dataset.id ? Number(b.dataset.id) : null; renderCategories(); renderProducts(); };
  });
}

function renderProducts() {
  const catColor = Object.fromEntries(state.categories.map((c) => [c.id, c.color]));
  const list = state.products.filter((p) =>
    (activeCategory == null || p.category_id === activeCategory) &&
    (!search || p.name.toLowerCase().includes(search) || (p.barcode || '').includes(search)));
  $('#products').innerHTML = list.length
    ? list.map((p) => `<button data-id="${p.id}" style="--c:${esc(p.color || catColor[p.category_id] || '#4f46e5')}">
        <span>${esc(p.name)}</span>
        <small>${eur(p.price)}${p.stock != null ? ` · <span class="${p.stock <= 0 ? 'stock-low' : ''}">stock ${p.stock}</span>` : ''}</small>
      </button>`).join('')
    : '<p class="muted">Aucun article. Ajoutez-en dans l\'onglet « Articles ».</p>';
  $$('#products button').forEach((b) => {
    b.onclick = () => addProduct(state.products.find((p) => p.id === Number(b.dataset.id)));
  });
}

function renderCart() {
  const customerLabel = cart.customer ? cart.customer.name : 'Client (facultatif)';
  $('#customer-label').textContent = customerLabel;
  const linesEl = $('#cart-lines');
  if (!cart.lines.length) {
    linesEl.innerHTML = '<div class="cart-empty">Nouvelle commande<br><small>Touchez un article pour l\'ajouter</small></div>';
  } else {
    linesEl.innerHTML = cart.lines.map((l) => {
      const gift = l.discount && l.discount >= Math.abs(l.quantity * l.unit_price);
      return `<div class="cart-line ${l.key === selectedKey ? 'selected' : ''}" data-key="${l.key}">
        <span>${esc(l.label)}</span><strong>${eur(lineGross(l))}</strong>
        <span class="qty">${l.quantity} × ${eur(l.unit_price)} · TVA ${pct(l.vat_rate)}</span><span></span>
        ${l.discount ? `<span class="disc">${gift ? 'Offert' : `Remise -${eur(l.discount)}`}</span>` : ''}
      </div>`;
    }).join('');
    $$('.cart-line', linesEl).forEach((el) => {
      el.onclick = () => { selectedKey = el.dataset.key === selectedKey ? null : el.dataset.key; renderCart(); };
    });
  }
  const t = totals();
  const subs = [
    `<div class="cart-sub"><span>Sous-total</span><span>${eur(t.subtotal)}</span></div>`,
    cart.discount ? `<div class="cart-sub"><span>Remise</span><span>-${eur(cart.discount)}</span></div>` : '',
    cart.coupon ? `<div class="cart-sub"><span>Coupon ${esc(cart.coupon.code)}</span><span>-${eur(t.couponAmount)}</span></div>` : '',
    cart.note ? `<div class="cart-sub"><span>📝 ${esc(cart.note)}</span></div>` : '',
  ];
  $('#cart-subs').innerHTML = subs.join('');
  $('#cart-total').textContent = eur(t.total);
  $('#btn-pay').disabled = !cart.lines.length;
  saveCart();
}

// --- Actions sur le panier ------------------------------------------------------------
function addProduct(p) {
  const existing = cart.lines.find((l) => l.product_id === p.id && !l.discount && l.unit_price === p.price);
  if (existing) existing.quantity += 1;
  else {
    const key = crypto.randomUUID();
    cart.lines.push({ key, product_id: p.id, label: p.name, unit_price: p.price, vat_rate: p.vat_rate, quantity: 1, discount: 0 });
    selectedKey = key;
  }
  renderCart();
}

async function addFreeItem() {
  const res = await formBox('Article à prix libre', [
    { name: 'label', label: 'Libellé', value: 'Divers', required: true },
    { name: 'price', label: 'Prix TTC (€)', inputmode: 'decimal', required: true },
    { name: 'vat_rate', label: 'TVA', type: 'select', value: 2000,
      options: state.vatRates.map((v) => ({ value: v.rate, label: v.label })) },
  ], 'Ajouter');
  if (!res) return;
  const price = parseEuros(res.price);
  if (price == null || price < 0) return toast('Prix invalide', true);
  const key = crypto.randomUUID();
  cart.lines.push({ key, product_id: null, label: res.label, unit_price: price, vat_rate: Number(res.vat_rate), quantity: 1, discount: 0 });
  selectedKey = key;
  renderCart();
}

async function cartAction(act) {
  if (act === 'discount') return globalDiscount();
  if (act === 'coupon') return applyCoupon();
  if (act === 'note') return editNote();
  const line = cart.lines.find((l) => l.key === selectedKey) ?? cart.lines.at(-1);
  if (!line) return toast('Sélectionnez un article', true);
  selectedKey = line.key;
  const gross = Math.abs(line.quantity * line.unit_price);

  if (act === 'remove') {
    cart.lines = cart.lines.filter((l) => l !== line);
    selectedKey = null;
  } else if (act === 'gift') {
    line.discount = line.discount >= gross ? 0 : gross; // bascule offert / non offert
  } else if (act === 'qty') {
    const res = await formBox(`Quantité – ${line.label}`, [
      { name: 'q', label: 'Quantité', type: 'number', value: line.quantity, required: true },
    ]);
    if (!res) return;
    const q = Number(res.q);
    if (!Number.isInteger(q) || q === 0) return toast('Quantité invalide', true);
    line.quantity = q;
    line.discount = Math.min(line.discount, Math.abs(q * line.unit_price));
  } else if (act === 'price') {
    const res = await formBox(`Prix unitaire – ${line.label}`, [
      { name: 'p', label: 'Prix TTC (€)', inputmode: 'decimal', value: centsToInput(line.unit_price), required: true },
    ]);
    if (!res) return;
    const p = parseEuros(res.p);
    if (p == null || p < 0) return toast('Prix invalide', true);
    line.unit_price = p;
    line.discount = Math.min(line.discount, Math.abs(line.quantity * p));
  } else if (act === 'line-discount') {
    const d = await askDiscount(`Remise – ${line.label}`, gross);
    if (d == null) return;
    line.discount = d;
  }
  renderCart();
}

// Demande une remise en % ou en € ; renvoie un montant en centimes.
async function askDiscount(title, base) {
  const res = await formBox(title, [
    { name: 'kind', label: 'Type', type: 'select', value: 'percent',
      options: [{ value: 'percent', label: 'Pourcentage (%)' }, { value: 'amount', label: 'Montant (€)' }] },
    { name: 'value', label: 'Valeur (0 pour supprimer la remise)', inputmode: 'decimal', required: true },
  ], 'Appliquer');
  if (!res) return null;
  const v = Number(String(res.value).replace(',', '.'));
  if (!Number.isFinite(v) || v < 0) { toast('Valeur invalide', true); return null; }
  const amount = res.kind === 'percent' ? Math.round((base * Math.min(v, 100)) / 100) : Math.round(v * 100);
  return Math.min(amount, base);
}

async function globalDiscount() {
  if (!cart.lines.length) return;
  const base = Math.max(0, totals().subtotal);
  const d = await askDiscount('Remise sur le total', base);
  if (d == null) return;
  cart.discount = d;
  renderCart();
}

async function applyCoupon() {
  if (cart.coupon) {
    cart.coupon = null;
    renderCart();
    return toast('Coupon retiré');
  }
  const res = await formBox('Coupon', [{ name: 'code', label: 'Code du coupon', required: true }], 'Appliquer');
  if (!res) return;
  try {
    const t = totals();
    cart.coupon = await api(`/coupons/check/${encodeURIComponent(res.code)}?total=${t.subtotal - cart.discount}`);
    toast(`Coupon ${cart.coupon.code} appliqué`);
    renderCart();
  } catch (err) { toast(err.message, true); }
}

async function editNote() {
  const res = await formBox('Note sur la commande', [
    { name: 'note', label: 'Commentaire (imprimé sur le ticket)', type: 'textarea', value: cart.note },
  ]);
  if (!res) return;
  cart.note = res.note.trim();
  renderCart();
}

async function chooseCustomer() {
  const customers = await api('/customers');
  const res = await formBox('Client', [
    { name: 'id', label: 'Client', type: 'select', value: cart.customer?.id ?? '',
      options: [{ value: '', label: '— Aucun —' }, ...customers.map((c) => ({
        value: c.id, label: `${c.last_name} ${c.first_name ?? ''}${c.phone ? ` · ${c.phone}` : ''}`,
      }))] },
  ], 'Valider');
  if (!res) return;
  const c = customers.find((x) => x.id === Number(res.id));
  cart.customer = c ? { id: c.id, name: `${c.first_name ?? ''} ${c.last_name}`.trim() } : null;
  renderCart();
}

function newOrder() {
  if (cart.lines.length) return cancelOrder();
  cart = emptyCart();
  selectedKey = null;
  renderCart();
}

async function cancelOrder() {
  if (!cart.lines.length) return;
  if (!(await confirmBox('Annuler la commande en cours ?', 'Annuler la commande', true))) return;
  cart = emptyCart();
  selectedKey = null;
  renderCart();
}

// --- Encaissement (paiement simple ou mixte) ---------------------------------------
async function openPayment() {
  const { total } = totals();
  const methods = state.paymentMethods;
  const payments = [];
  let entry = '';

  const sale = await modal((el, close) => {
    const paid = () => payments.reduce((s, p) => s + p.amount, 0);
    const remaining = () => total - paid();

    const render = () => {
      const rest = remaining();
      el.innerHTML = `
        <h3>Encaissement – ${eur(total)}</h3>
        <div class="pay-list">${payments.map((p, i) => `<div><span>${esc(p.name)}</span>
          <span>${eur(p.amount)} <button type="button" class="ghost" data-del="${i}">✕</button></span></div>`).join('')}</div>
        <div class="cart-sub"><span>${rest >= 0 ? 'Reste à payer' : 'Rendu monnaie'}</span><strong>${eur(Math.abs(rest))}</strong></div>
        <div class="big-amount">${entry ? `${entry.replace('.', ',')} €` : `<span class="muted">${eur(Math.max(rest, 0))}</span>`}</div>
        <div class="keypad">${['7', '8', '9', '4', '5', '6', '1', '2', '3', ',', '0', '⌫']
          .map((k) => `<button type="button" data-key="${k}">${k}</button>`).join('')}</div>
        <div class="row">${[500, 1000, 2000, 5000].map((v) => `<button type="button" data-quick="${v}">${eur(v)}</button>`).join('')}</div>
        <div class="pay-methods">${methods.map((m) => `<button type="button" data-method="${m.id}">${esc(m.name)}</button>`).join('')}</div>
        <div class="modal-actions">
          <button value="">Retour</button>
          <button type="button" class="primary" data-validate ${rest > 0 ? 'disabled' : ''}>Valider la vente</button>
        </div>`;

      $$('[data-key]', el).forEach((b) => {
        b.onclick = () => {
          const k = b.dataset.key;
          if (k === '⌫') entry = entry.slice(0, -1);
          else if (k === ',') { if (!entry.includes('.')) entry = `${entry || '0'}.`; }
          else if (!/\.\d\d$/.test(entry)) entry += k;
          render();
        };
      });
      $$('[data-quick]', el).forEach((b) => { b.onclick = () => { entry = String(Number(b.dataset.quick) / 100); render(); }; });
      $$('[data-del]', el).forEach((b) => { b.onclick = () => { payments.splice(Number(b.dataset.del), 1); render(); }; });
      $$('[data-method]', el).forEach((b) => {
        b.onclick = () => {
          const m = methods.find((x) => x.id === Number(b.dataset.method));
          const amount = entry ? Math.round(Number(entry) * 100) : Math.max(remaining(), 0);
          if (!amount) return;
          if (m.is_account && !cart.customer) return toast('Choisissez d\'abord un client pour le paiement sur compte', true);
          if (!m.gives_change && amount > remaining()) return toast(`Pas de rendu monnaie en ${m.name}`, true);
          payments.push({ payment_method_id: m.id, name: m.name, amount });
          entry = '';
          render();
        };
      });
      $('[data-validate]', el).onclick = async () => {
        try {
          const created = await api('/sales', {
            method: 'POST',
            body: {
              lines: cart.lines.map(({ product_id, label, unit_price, vat_rate, quantity, discount }) =>
                ({ product_id, label, unit_price, vat_rate, quantity, discount })),
              discount: cart.discount,
              coupon_code: cart.coupon?.code,
              note: cart.note || undefined,
              customer_id: cart.customer?.id,
              seller_id: state.seller?.id,
              payments: payments.map(({ payment_method_id, amount }) => ({ payment_method_id, amount })),
            },
          });
          close(created);
        } catch (err) { toast(err.message, true); }
      };
    };
    // Total nul (article offert) : validation directe en espèces.
    if (total === 0) payments.push({ payment_method_id: methods.find((m) => m.gives_change)?.id ?? methods[0].id, name: 'Offert', amount: 0 });
    render();
  });

  if (!sale) return;
  cart = emptyCart();
  selectedKey = null;
  renderCart();
  await refreshStock();
  showReceipt(sale);
}

async function refreshStock() {
  state.products = await api('/products');
  renderProducts();
}

export async function showReceipt(sale) {
  await modal((el, close) => {
    el.innerHTML = `<h3>${sale.refund_of ? 'Avoir' : 'Vente'} n° ${sale.number} enregistrée</h3>
      <div class="big-amount">${eur(sale.total)}</div>
      ${sale.change_given ? `<div class="cart-total"><span>Rendu</span><span>${eur(sale.change_given)}</span></div>` : ''}
      <div class="row">
        <button type="button" data-print>🖨 Imprimer le ticket</button>
        <button type="button" data-invoice>Facture</button>
        <button type="button" data-email>✉ Facture par email</button>
      </div>
      <div class="modal-actions"><button class="primary" value="ok">Nouvelle commande</button></div>`;
    $('[data-print]', el).onclick = () => printTicket(sale, state.settings);
    $('[data-invoice]', el).onclick = () => window.open(invoiceUrl(sale), '_blank');
    $('[data-email]', el).onclick = () => emailInvoice(sale, state.settings);
    void close;
  });
}
