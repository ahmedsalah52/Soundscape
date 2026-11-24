@echo off
rem Windows: double-click this file to install (first run) and start the panel.
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if errorlevel 1 (
    echo Python 3.9 or newer is required: https://www.python.org/downloads/
    pause
    exit /b 1
  )
)
if not exist ".venv\.installed" (
  echo Installing dependencies...
  ".venv\Scripts\python.exe" -m pip install -q --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || (pause & exit /b 1)
  type nul > ".venv\.installed"
)
".venv\Scripts\python.exe" -m app.server %*
pause
