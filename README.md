# caissegc

Nouvel outil logiciel de caisse pour GC : une caisse enregistreuse web, tactile et sur mesure. Cette base reprend les fonctions de [caisse.enregistreuse.fr](https://caisse.enregistreuse.fr/) utilisées en boutique.

> ⚠️ **Conformité NF525** : depuis 2018, un commerçant assujetti à la TVA doit utiliser un logiciel de caisse **certifié** (LNE ou AFNOR/Infocert). Cette base met en place les mécanismes techniques exigés (inaltérabilité, sécurisation, conservation, archivage), mais **elle n'est pas certifiée**. Gardez votre caisse certifiée actuelle pour l'encaissement réel tant que la certification n'est pas obtenue. Voir [docs/NF525.md](docs/NF525.md).

## Fonctionnalités (v0.1)

| Domaine | Fonctions |
|---|---|
| **Commande** | Nouvelle commande, Annuler, sous-total, note imprimée sur le ticket, article à prix libre, recherche et code-barres, quantité et prix modifiables |
| **Réductions** | Remise sur une ligne (% ou €), **article offert** (100 %), remise sur le total, **coupons** (%, montant fixe, minimum d'achat, date d'expiration, nombre d'utilisations max) |
| **Paiements** | Espèces (avec rendu monnaie), Carte Bleue, Chèque, Virement, **Compte client**, **paiement mixte**. Les moyens de paiement sont paramétrables. |
| **Remboursements** | Avoir sur n'importe quel ticket, remboursé par les mêmes moyens de paiement ou au choix (espèces, chèque, carte…). Le ticket d'origine n'est jamais modifié. |
| **Clients** | Fiche client, **compte client** (achats à crédit, solde, encaissement d'un règlement) |
| **Documents** | Impression du ticket 80 mm, **facture** HTML (imprimable en PDF), envoi de la facture **par email** (ouvre votre messagerie avec le lien) |
| **Ticket** | En-tête boutique (adresse, téléphone, email, site, SIRET, n° TVA), n° de ticket, date et heure, vendeur, articles et remises, total, détail par moyen de paiement, rendu, **ventilation de la TVA**, message de bas de ticket |
| **Clôture** | Rapport **X** (en cours) et clôture **Z** : ventilation par TVA, moyen de paiement, vendeur et catégorie, espèces attendues et écart de caisse, cumul perpétuel |
| **Sécurité** | Tickets chaînés par empreinte SHA-256 (toute altération est détectée), avoirs au lieu de suppressions, journal des actions, vendeurs avec code PIN |
| **Gestion** | Articles, catégories (couleurs), stock, vendeurs, statistiques (CA par jour, panier moyen, meilleurs articles) |
| **Import** | Import des articles, catégories, clients et vendeurs depuis caisse.enregistreuse.fr (API ou exports CSV/JSON) |

## Démarrage

Prérequis : **Node.js 22.13 ou plus récent** (la base SQLite utilise le module intégré `node:sqlite`, sans compilation).

```bash
npm install
cp .env.example .env      # facultatif
npm run seed              # facultatif : données de démonstration (vendeur « Gérant », PIN 1234)
npm start                 # http://localhost:3000
```

- `npm run dev` : redémarre le serveur à chaque modification
- `npm test` : tests automatiques

La base de données est un simple fichier (`data/caisse.db`). **Sauvegardez-le régulièrement.**

## Récupérer vos données de caisse.enregistreuse.fr

```bash
# Via l'API : renseignez CE_SHOP_ID et CE_API_KEY dans .env
npm run import:ce -- --dry-run   # affiche un exemple de chaque type sans rien écrire
npm run import:ce

# Via des exports : déposez categories.csv, products.csv, customers.csv, sellers.csv
# (ou .json) dans data/import/
npm run import:ce -- --dir data/import
```

Le script gère les noms de colonnes courants (`nom`/`designation`, `prix`, `tva`, `rayon`, `codebarre`…), les montants au format français (`1,20`) et les séparateurs `;` ou `,`. L'import peut être relancé sans créer de doublons. Les adresses des services API sont une hypothèse : vérifiez-les dans la documentation API de votre compte et ajustez `ENDPOINTS` et `FIELDS` en haut de `scripts/import-caisse-enregistreuse.js`.

L'historique des ventes n'est pas importé : pour la conformité, il reste dans la caisse d'origine (et dans vos archives de clôture).

## Architecture

```
src/
  server.js              point d'entrée HTTP
  app.js                 routes de l'API REST (/api/...)
  db.js                  schéma SQLite et valeurs par défaut
  money.js               calculs en centimes, TVA, répartition des remises
  services/sales.js      ventes, avoirs, coupons, compte client, chaînage des tickets
  services/closures.js   rapports X et clôtures Z
  services/invoice.js    génération des factures
  routes/crud.js         CRUD générique des référentiels
public/                  interface web (HTML, CSS et JS sans framework ni étape de build)
  js/pos.js              écran de caisse
  js/views.js            tickets, clôture, articles, clients, stats, paramètres
scripts/                 données de démo, import caisse.enregistreuse.fr
test/                    tests (node --test)
```

Principes :
- **Montants en centimes** (entiers) et taux de TVA en points de base (`2000` = 20 %). Aucun calcul en virgule flottante.
- Les prix sont saisis **TTC**. Le HT est calculé par ligne après répartition des remises au prorata.
- Un ticket validé n'est **jamais modifié ni supprimé** : une annulation crée un avoir.
- L'API REST est documentée dans [docs/API.md](docs/API.md) et la suite prévue dans [docs/ROADMAP.md](docs/ROADMAP.md).
