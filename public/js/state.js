import { api } from './util.js';

// État partagé entre les écrans (référentiels chargés au démarrage).
export const state = {
  settings: {},
  categories: [],
  products: [],
  paymentMethods: [],
  vatRates: [],
  seller: null,
};

export async function loadReferentials() {
  const [settings, categories, products, paymentMethods, vatRates] = await Promise.all([
    api('/settings'), api('/categories'), api('/products'), api('/payment-methods'), api('/vat-rates'),
  ]);
  Object.assign(state, { settings, categories, products, paymentMethods, vatRates });
}
