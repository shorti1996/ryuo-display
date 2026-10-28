#!/usr/bin/env bash
# Renders the demo's stand-in media into web/demo/media/: short procedural clips and stills at
# 896×432 (the panel's 2240×1080 at 40 %), each with a JPEG thumbnail. The mock API in
# mock-api.ts serves them as /api/media/preview and /api/media/thumb. Needs ffmpeg with
# libx264 and drawtext. Run from anywhere; it overwrites what is there.
set -euo pipefail

out="$(dirname "$(realpath "$0")")/media"
mkdir -p "$out"
size=896x432
seconds=8
font=$(fc-match -f '%{file}' 'sans:bold')

# clip <name> <filtergraph source>: an 8 s H.264 loop, and its thumbnail from 2 s in.
clip() {
  local name=$1 graph=$2
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$graph" -t "$seconds" \
    -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -movflags +faststart -an "$out/$name"
  ffmpeg -hide_banner -loglevel error -y -ss 2 -i "$out/$name" -frames:v 1 -vf scale=448:-2 -q:v 4 "$out/$name.jpg"
}

# still <name> <filtergraph source>: one PNG frame, and the same frame as its thumbnail.
still() {
  local name=$1 graph=$2
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$graph" -frames:v 1 "$out/$name"
  ffmpeg -hide_banner -loglevel error -y -i "$out/$name" -vf scale=448:-2 -q:v 4 "$out/$name.jpg"
}

clip aurora-drift.mp4 \
  "gradients=s=$size:r=30:n=4:c0=0x061a3a:c1=0x16c79a:c2=0x6a2cff:c3=0x02040c:type=radial:speed=0.015:seed=7"
clip sunset-bloom.mp4 \
  "gradients=s=$size:r=30:n=4:c0=0xff7a18:c1=0xaf002d:c2=0x319197:c3=0x0b0b1e:type=circular:speed=0.02:seed=11"
clip neon-life.mp4 \
  "life=s=224x108:r=30:mold=8:ratio=0.12:life_color=#ff2d6f:death_color=#1a0612:mold_color=#3a0ccf,scale=$size:flags=neighbor"
clip synthwave-spiral.mp4 \
  "gradients=s=$size:r=30:n=3:c0=0xff2a6d:c1=0x05d9e8:c2=0x1b0b3a:type=spiral:speed=0.03:seed=3,hue=h=t*20"
clip plasma-flow.mp4 \
  "nullsrc=s=448x216:r=30,geq=r='70+60*sin(X/41+T*1.3)':g='18+16*sin(Y/29+T*0.8)':b='120+100*sin((X+Y)/53+T*0.7)',scale=$size"
still rog-red-glow.png \
  "gradients=s=$size:n=3:c0=0xe5252b:c1=0x2a0000:c2=0x050506:type=radial:x0=448:y0=216:x1=1100:y1=600,drawtext=fontfile=$font:text=RYUO IV:fontsize=96:fontcolor=white@0.92:x=(w-tw)/2:y=(h-th)/2"
still display-black.png "color=c=black:s=$size"

# The cooler's built-in presets, stood in for by more gradients.
palettes=("0xe5252b 0x120406" "0x00b4ff 0x020814" "0xffb000 0x140a00" "0x9b5cff 0x0a0418" "0x2bff88 0x021208")
types=(linear circular square spiral radial)
for index in 0 1 2 3 4; do
  read -r first second <<<"${palettes[$index]}"
  clip "RYUO_IV_HW_Info_0$((index + 1)).mp4" \
    "gradients=s=$size:r=30:n=2:c0=$first:c1=$second:type=${types[$index]}:speed=0.02:seed=$index"
done

du -ch "$out"/* | tail -1
