#!/usr/bin/env bash
# Download the BirdNET+ V3.0 weights into models/birdnet-v3.0/ (DECISIONS.md #133) and check them
# against models/birdnet-v3.0/SHA256SUMS. They are not in git: the audio model is 174 MB, over
# GitHub's 100 MB file limit. Safe to re-run: files that already match are left alone.
#
#   scripts/fetch-model-v3.sh
#
# Source: Zenodo record 24362980 (BirdNET+ V3.0 model files, version 3.0.1). The ONNX Runtime engine file
# (ort-wasm-simd-threaded-<version>.wasm, 15 MB) is copied from node_modules/onnxruntime-web (run npm ci first):
# it is served next to the model so the front end on Vercel stays small (scripts/check-dist-size.mjs).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/models/birdnet-v3.0"
RECORD="https://zenodo.org/records/24362980/files"
AUDIO_SRC="BirdNET+_V3.0_Global_12K_FP16.onnx"
GEO_ZIP="BirdNET+_Geomodel_V3.0.5_Global_14K.zip"
GEO_IN_ZIP="BirdNET+_Geomodel_V3.0.5_Global_14K/BirdNET+_Geomodel_V3.0.5_Global_14K_FP16.onnx"

cd "$DIR"
expected() {
  local file="$1"
  awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }' SHA256SUMS
}
ok() {
  local file="$1"
  [[ -f "$file" ]] && [[ "$(sha256sum "$file" | cut -d' ' -f1)" == "$(expected "$file")" ]]
}
# HTTPS only, also after Zenodo's redirects to its file store.
fetch() { curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 4 --retry-delay 5 "$@"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if ok audio.onnx; then
  echo "audio.onnx: already there"
else
  echo "audio.onnx: downloading $AUDIO_SRC (174 MB)"
  fetch -o "$tmp/audio.onnx" "$RECORD/$AUDIO_SRC?download=1"
  mv "$tmp/audio.onnx" audio.onnx
fi

if ok geo.onnx; then
  echo "geo.onnx: already there"
else
  echo "geo.onnx: downloading $GEO_ZIP (111 MB) for the 8 MB location model inside it"
  fetch -o "$tmp/geo.zip" "$RECORD/$GEO_ZIP?download=1"
  unzip -p "$tmp/geo.zip" "$GEO_IN_ZIP" > geo.onnx
fi

ORT_VERSION="$(node -p "require('$DIR/../../node_modules/onnxruntime-web/package.json').version")"
ORT_WASM="ort-wasm-simd-threaded-$ORT_VERSION.wasm"
if ok "$ORT_WASM"; then
  echo "$ORT_WASM: already there"
else
  echo "$ORT_WASM: copying from node_modules/onnxruntime-web"
  cp "$DIR/../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" "$ORT_WASM"
fi

sha256sum -c SHA256SUMS
