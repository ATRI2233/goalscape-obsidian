@echo off
setlocal

rem ===== 配置：复制源 与 目标 =====
set "SRC=%~dp0goalscape-obsidian"
set "DEST=D:\all codes projeck\ob库--个人记录\.obsidian\plugins\goalscape-obsidian"

echo 源文件夹: %SRC%
echo 目标位置: %DEST%
echo.

if not exist "%SRC%\main.js" (
    echo [错误] 源文件夹缺少 main.js，请确认路径。
    pause
    exit /b 1
)

if not exist "%DEST%" mkdir "%DEST%"

echo 正在复制替换插件文件...
copy /y "%SRC%\main.js"       "%DEST%\main.js"
copy /y "%SRC%\manifest.json" "%DEST%\manifest.json"
copy /y "%SRC%\styles.css"    "%DEST%\styles.css"

if errorlevel 1 (
    echo.
    echo [错误] 复制失败。
    pause
    exit /b 1
)

echo.
echo 完成！请重启 Obsidian 或重新加载插件。
pause
endlocal
