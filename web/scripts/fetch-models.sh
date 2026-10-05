#!/bin/sh
# Downloads the Vosk models served with the app into static/models.
# Keep in sync with DEFAULT_MODEL_PATHS in src/lib/app/settings.ts and the vocabulary job in
# .github/workflows/ci.yml.
set -eu

cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p static/models
for model in vosk-model-small-en-us-0.15 vosk-model-small-ja-0.22; do
	if [ -s "static/models/$model.tar.gz" ]; then
		echo "static/models/$model.tar.gz exists"
		continue
	fi
	curl -fsSL --retry 3 -o "$work/$model.zip" "https://alphacephei.com/vosk/models/$model.zip"
	unzip -q "$work/$model.zip" -d "$work/$model"
	# vosk-browser expects a .tar.gz with a single top-level directory.
	tar -C "$work/$model" -czf "static/models/$model.tar.gz" "$model"
	echo "static/models/$model.tar.gz"
done
