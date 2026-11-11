@echo off
rem Installe et lance la caisse sous Windows : double-cliquez sur ce fichier.
chcp 65001 >nul
title Caisse GC
cd /d "%~dp0"

echo.
echo === Caisse GC : installation et lancement ===
echo.

rem 1. Node.js 22.13 ou plus récent
set "NODE_OK=0"
where node >nul 2>nul && node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" && set "NODE_OK=1"
if "%NODE_OK%"=="0" (
  echo Installation de Node.js LTS ^(une fenetre d'autorisation peut s'ouvrir^)...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo Impossible d'installer Node.js automatiquement.
    echo Installez la version LTS depuis la page qui va s'ouvrir, puis relancez ce fichier.
    start "" https://nodejs.org/fr/download
    pause
    exit /b 1
  )
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
)

rem 2. Dépendances (crée aussi le fichier .env)
echo Installation des dependances...
call npm install --no-fund --no-audit
if errorlevel 1 ( echo Echec de npm install. & pause & exit /b 1 )

rem 3. Données de démonstration (seulement si la caisse est vide)
call npm run seed

rem 4. Lancement et ouverture du navigateur
echo.
echo La caisse s'ouvre dans votre navigateur. Laissez cette fenetre ouverte ;
echo fermez-la pour arreter la caisse.
echo Si Windows demande l'autorisation du pare-feu, acceptez pour les tablettes du reseau.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
call npm start
pause
