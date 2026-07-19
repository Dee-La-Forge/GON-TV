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

echo [%date% %time%] ===== fin (worst=%WORST%) ===== >> "%LOG%"
exit /b %WORST%

:step
set NAME=%~1
echo [%date% %time%] --- %NAME% --- >> "%LOG%"
%2 %3 %4 >> "%LOG%" 2>&1
set CODE=%errorlevel%
echo [%date% %time%] %NAME% exit %CODE% >> "%LOG%"
if %CODE% GTR %WORST% set WORST=%CODE%
exit /b 0
