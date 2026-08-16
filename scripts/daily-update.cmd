@echo off
REM Daily update wrapper for Task Scheduler. Loads .env (not picked up
REM automatically when npm runs from a workspace directory), then runs the pull
REM and recompute, appending to logs\daily-update.log.
setlocal enabledelayedexpansion

cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
set "LOGFILE=%~dp0..\logs\daily-update.log"

if not exist ".env" (
  echo [wrapper] .env not found in %CD% >> "%LOGFILE%"
  exit /b 2
)

REM KEY=VALUE lines only; blanks and # comments skipped.
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if not "%%A"=="" set "%%A=%%B"
)

if "%DATABASE_URL%"=="" (
  echo [wrapper] DATABASE_URL missing from .env >> "%LOGFILE%"
  exit /b 2
)
if "%LIQUIPEDIA_API_KEY%"=="" (
  echo [wrapper] LIQUIPEDIA_API_KEY missing from .env >> "%LOGFILE%"
  exit /b 2
)

REM The database is a local container; starting it here means a reboot that
REM leaves Docker down does not silently skip a day.
docker start power-ranking-db >nul 2>&1

echo. >> "%LOGFILE%"
echo ======== run started ======== >> "%LOGFILE%"
call npm run daily --workspace=@power-ranking/ingestion >> "%LOGFILE%" 2>&1
set "RESULT=%ERRORLEVEL%"
echo ======== run finished, exit %RESULT% ======== >> "%LOGFILE%"

exit /b %RESULT%
