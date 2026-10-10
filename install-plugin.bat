@echo off
setlocal

rem ===== config: where the build lives, and where the plugin goes =====
set "SRC=%~dp0goalscape-obsidian"

if not defined GS_VAULT (
    echo [error] GS_VAULT is not set, so this script does not know your vault.
    echo         Set it once and reopen this terminal:
    echo             setx GS_VAULT "D:\path\to\your-vault"
    echo         Or set it for this window only:
    echo             set GS_VAULT=D:\path\to\your-vault
    pause
    exit /b 1
)

set "DEST=%GS_VAULT%\.obsidian\plugins\goalscape-obsidian"

echo source       : %SRC%
echo destination  : %DEST%
echo.

if not exist "%SRC%\main.js" (
    echo [error] main.js is missing - run "npm run build" inside goalscape-obsidian first.
    pause
    exit /b 1
)

if not exist "%DEST%" mkdir "%DEST%"

echo copying...
copy /y "%SRC%\main.js"       "%DEST%\main.js"
copy /y "%SRC%\manifest.json" "%DEST%\manifest.json"
copy /y "%SRC%\styles.css"    "%DEST%\styles.css"

if errorlevel 1 (
    echo.
    echo [error] copy failed.
    pause
    exit /b 1
)

echo.
echo Done. A running Obsidian does not hot-reload: disable and re-enable the plugin.
pause
endlocal
