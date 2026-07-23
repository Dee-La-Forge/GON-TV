@echo off
rem G-ON - extension ARRIERE 2025 de toutes les archives POI (one-shot).
rem BTCUSDT d'abord (365 jours + outcome), puis les alts (~533 jours chacun :
rem toute 2025 + le trou janvier->juin 2026 d'avant leur creation).
rem Long (~20-30 h au total) ; interruptible sans risque : checkpoints tous
rem les 20 jours dans %TMP%\gon-vision-cache, relancer ce script reprend ou
rem saute (idempotent). Chaque etape loggue son errorlevel ; sortie = pire code.
setlocal enabledelayedexpansion
cd /d "%~dp0"
set LOG=%LOCALAPPDATA%\gon-extend-2025.log
set WORST=0
set START=2025-01-01
set SYMBOLS=BTCUSDT ETHUSDT SOLUSDT BNBUSDT XRPUSDT DOGEUSDT ADAUSDT LINKUSDT APTUSDT ARBUSDT OPUSDT SUIUSDT FILUSDT INJUSDT ETCUSDT AAVEUSDT WLDUSDT TIAUSDT 1000PEPEUSDT 1000SHIBUSDT

echo [%date% %time%] ===== extension 2025 (depuis %START%) ===== >> "%LOG%"

for %%S in (%SYMBOLS%) do (
  call :step "extend %%S"   node extend-archive-past.js %%S %START%
  call :step "invalid %%S"  node backfill-invalidation.js %%S
  call :step "approach %%S" node backfill-approach.js %%S
)

rem verdicts de la regle de retest (BTC seulement : pourcentages calibres BTC)
call :step "outcome BTCUSDT" node backfill-outcome.js BTCUSDT

echo [%date% %time%] ===== fin extension 2025 (worst=%WORST%) ===== >> "%LOG%"
exit /b %WORST%

:step
set NAME=%~1
echo [%date% %time%] --- %NAME% --- >> "%LOG%"
%2 %3 %4 %5 %6 >> "%LOG%" 2>&1
set CODE=%errorlevel%
echo [%date% %time%] %NAME% exit %CODE% >> "%LOG%"
if %CODE% NEQ 0 if %WORST% EQU 0 set WORST=1
if %CODE% GTR %WORST% set WORST=%CODE%
exit /b 0
