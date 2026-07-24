@echo off
rem G-ON - tache LEGERE du matin : archives SECONDES du jour revolu + publication.
rem La tache de nuit (02:22, choix Meddy : ne pas charger la machine aux heures
rem de travail) tourne AVANT la publication Vision du jour J-1 — ce second
rem passage en fin de matinee rattrape J-1 des qu'il est publie. Quelques
rem minutes au plus : gen-sec-archive saute tout fichier deja present, et la
rem publication ne pousse que le nouveau. Idempotent, meme log que la nuit.
setlocal enabledelayedexpansion
cd /d "%~dp0"
set LOG=%LOCALAPPDATA%\gon-regen.log
set WORST=0

echo [%date% %time%] ===== sec matin ===== >> "%LOG%"
call :step "sec-bars ALL" node gen-sec-archive.js ALL 7
call :step "publish" node publish-daily.js
echo [%date% %time%] ===== fin sec matin (worst=%WORST%) ===== >> "%LOG%"
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
