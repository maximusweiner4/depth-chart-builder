@echo off
setlocal

if "%~1"=="" (
    echo Usage: fetch-roster.bat ^<roster-url^>
    echo Example: fetch-roster.bat https://ohiostatebuckeyes.com/sports/football/roster
    exit /b 1
)

echo.
echo ========================================
echo   College Football Depth Chart Builder
echo ========================================
echo.

cd /d "%~dp0"

echo Checking for dependencies...
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Fetching roster from: %~1
echo This may take a moment...
echo.

node scrape-roster.js "%~1"

if %errorlevel% neq 0 (
    echo.
    echo Error fetching roster. Please check the URL and try again.
    pause
    exit /b 1
)

echo.
echo Updating depth chart...
node update-html.js

echo.
echo ========================================
echo   Done! Open index.html to use your depth chart.
echo ========================================
echo.

pause
