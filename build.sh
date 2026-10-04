#!/bin/sh
set -e

VERSION="1.0.0"
VENV_DIR="./build_resources/venv"
MM_DIR="./MajsoulMax"

echo "[build] Cleaning up old builds..."
rm -rf release/ build_resources/ extraResources/ dist/

echo "[build] Creating venv..."
python3 -m venv "$VENV_DIR"

echo "[build] Installing dependencies..."
. "$VENV_DIR/bin/activate"
pip install -r "$MM_DIR/requirements.txt"
deactivate

echo "[build] Copying venv to extraResources..."
mkdir -p build_resources/extraResources
cp -r "$VENV_DIR" build_resources/extraResources/

echo "[build] Building AppImage with electron-builder..."
export NODE_ENV=production
npm run build:npm

echo "[build] Done! Release files in release/"
