#!/usr/bin/env bash
# Сборка сцены в один файл index.html (Three.js и весь код внутри)
set -e
cd "$(dirname "$0")"
mkdir -p dist
npx esbuild src/main.js --bundle --minify --format=iife --target=es2019 --outfile=dist/bundle.js --log-level=warning
python3 - <<'PY'
t = open('template.html', encoding='utf-8').read()
b = open('dist/bundle.js', encoding='utf-8').read().replace('</script', '<\\/script')
open('index.html', 'w', encoding='utf-8').write(t.replace('/*BUNDLE*/', b))
PY
rm -f dist/bundle.js
python3 gen_pwa.py
ls -l index.html
