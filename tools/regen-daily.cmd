@echo off
rem G-ON - regeneration quotidienne des archives POI depuis Binance Vision,
rem puis invalidation des zombies (cassure/balayage) et backfill du profil
rem d'approche (approachAtr), pour TOUS les symboles suivis. Chaque etape
rem loggue son propre errorlevel ; le script sort avec le pire code
rem rencontre (visible dans le Task Scheduler).
setlocal enabledelayedexpansion
cd /d "%~dp0"
set LOG=%LOCALAPPDATA%\gon-regen.log
set WORST=0
set SYMBOLS=BTCUSDT ETHUSDT SOLUSDT BNBUSDT XRPUSDT DOGEUSDT ADAUSDT LINKUSDT APTUSDT ARBUSDT OPUSDT SUIUSDT FILUSDT INJUSDT ETCUSDT AAVEUSDT WLDUSDT TIAUSDT 1000PEPEUSDT 1000SHIBUSDT

echo [%date% %time%] ===== regen quotidien ===== >> "%LOG%"

for %%S in (%SYMBOLS%) do (
  call :step "regen %%S"    node regen-archive.js %%S
  call :step "invalid %%S"  node backfill-invalidation.js %%S
  call :step "approach %%S" node backfill-approach.js %%S
)

rem verdicts de la regle de retest (BTC seulement : pourcentages calibres BTC)
call :step "outcome BTCUSDT" node backfill-outcome.js BTCUSDT

rem PUBLICATION : commit + push des archives regenerees vers GitHub, sinon
rem github.io reste gele au dernier push et il manque des niveaux recents.
rem On ne pousse QUE les fichiers d'archive (donnees), jamais le code.
echo [%date% %time%] --- publication github --- >> "%LOG%"
cd /d "%~dp0\..\.."
git add g-on/poi/antho-v1-m15-pois.json g-on/poi/archive-*-m15.json >> "%LOG%" 2>&1
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "chore(g-on): archives POI quotidiennes" >> "%LOG%" 2>&1
  git push >> "%LOG%" 2>&1
  echo [%date% %time%] publication exit %errorlevel% >> "%LOG%"
) else (
  echo [%date% %time%] aucune archive modifiee, rien a publier >> "%LOG%"
)

echo [%date% %time%] ===== fin (worst=%WORST%) ===== >> "%LOG%"
exit /b %WORST%

:step
set NAME=%~1
echo [%date% %time%] --- %NAME% --- >> "%LOG%"
%2 %3 %4 %5 %6 >> "%LOG%" 2>&1
set CODE=%errorlevel%
echo [%date% %time%] %NAME% exit %CODE% >> "%LOG%"
rem un crash natif de node donne un code NEGATIF : GTR seul ne l'eleverait pas
if %CODE% NEQ 0 if %WORST% EQU 0 set WORST=1
if %CODE% GTR %WORST% set WORST=%CODE%
exit /b 0
