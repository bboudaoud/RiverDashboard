@REM Open an http server here
start python -m http.server 8000

@REM Open the page in a browser
start chrome --disable-web-security http://localhost:8000
