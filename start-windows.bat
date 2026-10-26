@echo off
cd /d "%~dp0"
echo Starting ClearRun...
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 run.py
) else (
  python run.py
)
if errorlevel 1 (
  echo.
  echo Could not start. Install Python 3 from https://www.python.org/downloads/ and tick "Add Python to PATH".
)
pause
