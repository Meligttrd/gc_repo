#!/bin/bash
# Installe et lance la caisse sur Mac : double-cliquez sur ce fichier
# (la première fois : clic droit > Ouvrir, pour passer la protection de macOS).
cd "$(dirname "$0")" || exit 1
echo
echo "=== Caisse GC : installation et lancement ==="
echo

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
}

# 1. Node.js 22.13 ou plus récent
if ! node_ok; then
  echo "Installation de Node.js..."
  if command -v brew >/dev/null 2>&1; then
    brew install node
  else
    PKG=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE 'node-v22\.[0-9]+\.[0-9]+\.pkg' | head -1)
    if [ -n "$PKG" ] && curl -fL -o "/tmp/$PKG" "https://nodejs.org/dist/latest-v22.x/$PKG"; then
      echo "Votre mot de passe Mac est demandé pour installer Node.js :"
      sudo installer -pkg "/tmp/$PKG" -target /
    fi
  fi
  export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
  if ! node_ok; then
    echo "Impossible d'installer Node.js automatiquement."
    echo "Installez la version LTS depuis https://nodejs.org/fr/download puis relancez ce fichier."
    open https://nodejs.org/fr/download 2>/dev/null
    read -r -p "Appuyez sur Entrée pour fermer..."
    exit 1
  fi
fi

# 2. Dépendances (crée aussi le fichier .env)
echo "Installation des dépendances..."
npm install --no-fund --no-audit || { read -r -p "Échec de npm install. Entrée pour fermer..."; exit 1; }

# 3. Données de démonstration (seulement si la caisse est vide)
npm run seed

# 4. Lancement et ouverture du navigateur
echo
echo "La caisse s'ouvre dans votre navigateur. Laissez cette fenêtre ouverte ;"
echo "fermez-la (ou Ctrl+C) pour arrêter la caisse."
echo
(sleep 3; open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null) &
npm start
