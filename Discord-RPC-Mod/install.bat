@echo off
setlocal

rem Set target folder and file
set "target=%USERPROFILE%\.serika-presence"
set "url=https://raw.githubusercontent.com/emr09-cmd/Serika-Mod/refs/heads/main/Discord-RPC-Mod/runner.js"
set "destination=%target%\runner.js"

rem Check if Serika is installed
if exist "%target%" (
    echo [FOUND] %target% exists.
    echo.
    echo Press I to install runner.js, or C to cancel...
    choice /c IC /n /m "" >nul
    if errorlevel 2 (
        echo Cancelled by user.
        exit /b
    )
    echo Installing runner.js...
    powershell -Command "Invoke-WebRequest -Uri '%url%' -OutFile '%destination%' -UseBasicParsing"
    if exist "%destination%" (
        echo Download complete: %destination%
    ) else (
        echo Failed to download the file. Please check your internet connection or URL.
    )
) else (
    echo [NOT FOUND] %target% does not exist.
    echo Please install Serika from the official website:
    echo https://streaming.serika.dev/settings
    pause
    exit /b
)

pause
endlocal