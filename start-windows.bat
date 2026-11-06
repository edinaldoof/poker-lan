@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js nao encontrado. Instale a versao 20 ou superior em https://nodejs.org e tente novamente.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Instalando dependencias ^(primeira execucao^)...
  call npm install
  if errorlevel 1 goto :failed
)

echo Iniciando Mesa Real...
call npm start
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo Ocorreu um erro. Leia as mensagens acima.
pause
exit /b 1
