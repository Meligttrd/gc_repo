import { networkInterfaces } from 'node:os';
import { openDatabase } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

// Adresses IPv4 de l'ordinateur sur le réseau local (pour les tablettes et téléphones).
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const db = openDatabase();
createApp(db).listen(port, host, () => {
  console.log('Caisse GC démarrée');
  console.log(`  Sur cet ordinateur : http://localhost:${port}`);
  if (host === '0.0.0.0') {
    for (const ip of lanAddresses()) console.log(`  Sur le réseau local : http://${ip}:${port}`);
  }
});
