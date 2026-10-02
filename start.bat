@echo off
rem skill-tank: start the local server hidden (127.0.0.1:4700) and open the page
wscript.exe "%~dp0tools\start-hidden.vbs"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:4700/
