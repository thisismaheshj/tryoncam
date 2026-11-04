#!/bin/sh
# Renders the X (Twitter) profile headers.
# Output: out/tryoncam-x-header-<v>.png (1500x500, what X asks for)
#         out/tryoncam-x-header-<v>@2x.jpg (3000x1000, sharper on high-density screens)
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p out
for v in A B C; do
  lower=$(echo $v | tr 'A-Z' 'a-z')
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1500,500 --virtual-time-budget=5000 --allow-file-access-from-files \
    --screenshot="out/raw-$lower.png" "file://$PWD/header.html?v=$v" >/dev/null 2>&1
  ffmpeg -loglevel error -y -i "out/raw-$lower.png" -q:v 2 "out/tryoncam-x-header-$lower@2x.jpg"
  ffmpeg -loglevel error -y -i "out/raw-$lower.png" -vf scale=1500:500:flags=lanczos "out/tryoncam-x-header-$lower.png"
  rm -f "out/raw-$lower.png"
done
rm -rf out/draft
ls -la out
