// Crée le fichier .env à partir de .env.example s'il n'existe pas encore.
import { copyFileSync, existsSync } from 'node:fs';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('Fichier .env créé à partir de .env.example : adaptez-le si besoin.');
}
