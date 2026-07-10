@echo off
cd /d "%~dp0"
echo リーフファイト対戦ツールを起動しています...
echo 少し待つと "Local: http://localhost:5300/" という行が出ます。そこをブラウザで開いてください。
echo 終わるときはこのウィンドウを閉じるか、Ctrl+Cを押してください。
echo.
npm run dev
pause
