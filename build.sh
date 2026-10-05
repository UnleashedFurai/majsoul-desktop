#!/bin/sh
set -e

PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.14.8+20261003-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
PYTHON_DIR="./build_resources/python"
PIP_URL="https://files.pythonhosted.org/packages/py3/p/pip/pip-24.3.1-py3-none-any.whl"
PIP_DIR="./build_resources/pip"
PIP_FILE="pip-24.3.1-py3-none-any.whl"

TARGET="${1:-}"

if [ -z "$TARGET" ]; then
	echo "No target speciffied. Exiting."
	exit 1
fi

# Fetch Python if missing
if [ ! -d "$PYTHON_DIR" ]; then
	echo "[build] Fetching standalone Python..."
	mkdir -p "$PYTHON_DIR"
	curl -L "$PYTHON_URL" | tar -xz -C "$PYTHON_DIR"

	# Fix Python dir if it extracts to another python/ dir
	if [ -d "$PYTHON_DIR/python" ]; then
		echo "[build] Detected nested python/ directory, flattening..."
		mv "$PYTHON_DIR/python"/* "$PYTHON_DIR/"
		rmdir "$PYTHON_DIR/python"
	fi
else
	echo "[build] Python already cached, skipping download..."
fi

# Fetch pip if missing
mkdir -p "$PIP_DIR"
if [ ! -f "$PIP_DIR/$PIP_FILE" ]; then
	echo "[build] Fetching pip wheel..."
	curl -L "$PIP_URL" -o "$PIP_DIR/$PIP_FILE"
else
	echo "[build] Pip already cached..."
fi

echo "[build] Building $TARGET..."
export NODE_ENV=production
npm run build:"$TARGET"

echo "[build] Done!"
