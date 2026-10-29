@echo off
rem Builds Agent Terminal Manager for Windows.
rem
rem   build.bat           installer + portable exe + unpacked app (release\)
rem   build.bat dir       only the unpacked app (release\win-unpacked), fastest
rem   build.bat test      run the unit tests, then build everything
rem
setlocal
cd /d "%~dp0"

where npm >nul 2>nul || (echo npm not found. Install Node.js 22 or newer. & exit /b 1)

if not exist node_modules (
  echo Installing dependencies...
  call npm install || exit /b 1
)

if /i "%~1"=="test" (
  echo Running unit tests...
  call npm test || exit /b 1
)

rem Version from version.txt into package.json (app, exe file version, artifact names)
call node scripts\version.js || exit /b 1

echo Building renderer and MCP bridge...
call node scripts\build-renderer.js || exit /b 1

if /i "%~1"=="dir" (
  echo Packaging unpacked app...
  call npx electron-builder --win dir || goto failed
) else (
  echo Packaging installer, portable exe and unpacked app...
  call npx electron-builder --win || goto failed
)

echo.
echo Done. Output in %cd%\release
exit /b 0

:failed
echo.
echo Build failed. If it says "resource busy or locked", close the running app from release\win-unpacked and try again.
exit /b 1
