#!/bin/sh
# Renders every thumbnail design at link-preview and YouTube sizes.
# Output: site/assets/og/og-<v>.jpg (1200x630) and store/og/out/yt-<v>.jpg (1280x720).
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p out ../../site/assets/og
for v in A B C D E F; do
  for size in 1200x630 1280x720; do
    w=${size%x*}; h=${size#*x}
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
      --window-size=$w,$h --virtual-time-budget=4000 --allow-file-access-from-files \
      --screenshot="out/raw-$v-$w.png" "file://$PWD/thumb.html?v=$v&w=$w&h=$h" >/dev/null 2>&1
  done
  lower=$(echo $v | tr 'A-Z' 'a-z')
  ffmpeg -loglevel error -y -i out/raw-$v-1200.png -q:v 3 ../../site/assets/og/og-$lower.jpg
  ffmpeg -loglevel error -y -i out/raw-$v-1280.png -q:v 2 out/yt-$lower.jpg
done
rm -f out/raw-*.png
ls -la ../../site/assets/og out
