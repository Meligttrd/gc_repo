import { api, $, $$, esc, modal, toast } from './util.js';
import { state, loadReferentials } from './state.js';
import { renderPos } from './pos.js';
import { renderTickets, renderClosure, renderArticles, renderCustomers, renderStats, renderSettings } from './views.js';

const VIEWS = {
  caisse: renderPos,
  tickets: renderTickets,
  cloture: renderClosure,
  articles: renderArticles,
  clients: renderCustomers,
  stats: renderStats,
  parametres: renderSettings,
};
const SELLER_KEY = 'caissegc.seller';

async function route() {
  const name = location.hash.slice(1) || 'caisse';
  const view = VIEWS[name] ?? VIEWS.caisse;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  try {
    await view($('#view'));
  } catch (err) {
    toast(err.message, true);
  }
}

// Sélection du vendeur (code PIN si défini).
async function chooseSeller() {
  const sellers = await api('/sellers');
  if (!sellers.length) {
    setSeller(null);
    return;
  }
  const seller = await modal((el, close) => {
    el.innerHTML = `<h3>Qui êtes-vous ?</h3>
      <div class="pay-methods">${sellers.map((s) => `<button type="button" data-id="${s.id}">${esc(s.name)}</button>`).join('')}</div>
      <label id="pin-wrap" hidden>Code PIN<input id="pin" type="password" inputmode="numeric" autocomplete="off"></label>
      <div class="modal-actions"><button value="">Plus tard</button></div>`;
    $$('[data-id]', el).forEach((b) => {
      b.onclick = async () => {
        const s = sellers.find((x) => x.id === Number(b.dataset.id));
        if (!s.pin) return close(await api('/login', { method: 'POST', body: { seller_id: s.id } }));
        $('#pin-wrap', el).hidden = false;
        const pin = $('#pin', el);
        pin.value = '';
        pin.focus();
        pin.onkeydown = async (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          try { close(await api('/login', { method: 'POST', body: { pin: pin.value } })); } catch (err) { toast(err.message, true); }
        };
      };
    });
  });
  if (seller) setSeller(seller);
}

function setSeller(seller) {
  state.seller = seller;
  try { localStorage.setItem(SELLER_KEY, JSON.stringify(seller)); } catch { /* ignoré */ }
  $('#seller-badge').textContent = seller ? `👤 ${seller.name}` : '👤 Vendeur';
}

async function start() {
  await loadReferentials();
  $('#shop-name').textContent = state.settings.shop_name || 'Caisse GC';
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SELLER_KEY)); } catch { /* ignoré */ }
  setSeller(saved);
  $('#seller-badge').onclick = chooseSeller;
  window.addEventListener('hashchange', route);
  await route();
}

start().catch((err) => toast(err.message, true));
