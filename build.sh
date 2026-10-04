#!/bin/sh
set -e

PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.14.8+20261003-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
PYTHON_DIR="./build_resources/python"

echo "[build] Cleaning old builds..."
rm -rf release/ dist/

# Only fetch Python if missing
if [ ! -d "$PYTHON_DIR" ]; then
	echo "[build] Fetching standalone Python..."
	mkdir -p "$PYTHON_DIR"
	curl -L "$PYTHON_URL" | tar -xz -C "$PYTHON_DIR"
else
	echo "[build] Python already cached, skipping download..."
fi

echo "[build] Building AppImage..."
export NODE_ENV=production
npm run build:npm

echo "[build] Done! Release files in release/"
