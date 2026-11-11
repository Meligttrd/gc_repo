# API REST

Toutes les routes sont préfixées par `/api`. Montants en **centimes**, taux de TVA en **points de base** (`2000` = 20 %).

## Référentiels (CRUD)

`GET /x`, `GET /x/:id`, `POST /x`, `PUT /x/:id`, `DELETE /x/:id`

| Ressource | Champs | Remarques |
|---|---|---|
| `/categories` | name*, color, position | suppression logique (`active = 0`), `?all=1` pour tout voir |
| `/products` | name*, price*, vat_rate, category_id, barcode, stock (null = non suivi), color, position | suppression logique |
| `/customers` | last_name*, first_name, email, phone, address, notes | |
| `/sellers` | name*, pin | suppression logique |
| `/payment-methods` | name*, code*, gives_change, is_account, position | suppression logique |
| `/coupons` | code*, kind* (`percent`/`amount`), value*, label, min_total, max_uses, expires_at | suppression logique |

- `GET /vat-rates` : taux de TVA disponibles
- `GET /coupons/check/:code?total=` : vérifie un coupon et calcule sa remise
- `GET /settings`, `PUT /settings` : paramètres boutique et ticket (`shop_name`, `shop_address`, `shop_phone`, `shop_email`, `shop_website`, `shop_siret`, `shop_vat_number`, `ticket_header`, `ticket_footer`)
- `POST /login` `{ pin }` ou `{ seller_id }` (vendeur sans PIN)

## Ventes

### `POST /sales`

```json
{
  "lines": [
    { "product_id": 3, "quantity": 2 },
    { "product_id": 8, "discount": 120 },
    { "label": "Divers", "unit_price": 500, "vat_rate": 2000 }
  ],
  "discount": 0,
  "coupon_code": "BIENVENUE10",
  "note": "Sans sucre",
  "customer_id": null,
  "seller_id": 1,
  "payments": [
    { "payment_method_id": 1, "amount": 1000 },
    { "payment_method_id": 2, "amount": 250 }
  ]
}
```

- `discount` sur une ligne : remise TTC. Égale au montant de la ligne, elle rend l'article **offert**.
- `discount` global : remise TTC sur le total. Elle s'ajoute à celle du coupon et est répartie au prorata des lignes.
- Le rendu monnaie n'est possible que sur un moyen de paiement `gives_change` (espèces).
- Un paiement sur un moyen `is_account` exige un `customer_id`.

Autres routes :
- `GET /sales?from=&to=&customer_id=&limit=&offset=` : liste des tickets
- `GET /sales/:id` : détail (lignes, paiements, avoir éventuel)
- `GET /sales/:id/invoice` : facture HTML
- `POST /sales/:id/refund` `{ payment_method_id?, seller_id?, note? }` : crée un avoir
- `GET /sales/verify` : vérifie la chaîne d'empreintes

## Compte client

- `GET /customers/:id/account` : `{ balance, sales }` (balance > 0 : montant dû par le client)
- `POST /customers/:id/settle` `{ amount, payment_method_id }` : encaisse un règlement (ticket à 0 €)

## Clôtures

- `GET /report/current` : rapport X
- `POST /closures` `{ cash_counted? }` : clôture Z
- `GET /closures`, `GET /closures/:id`

## Statistiques

- `GET /stats/daily?days=30`
- `GET /stats/top-products?days=30`
