#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Payjoin FFI React Native Bindings Generator - FOR MAINTAINERS ONLY
# ============================================================================

OS=$(uname -s)

echo "🔨 Building Payjoin FFI React Native Bindings"
echo "Platform: $OS"
echo ""

if ! command -v cargo &> /dev/null; then
    echo "❌ Error: cargo not found. Install Rust from https://rustup.rs"
    exit 1
fi

if ! command -v rustc &> /dev/null; then
    echo "❌ Error: rustc not found. Install Rust from https://rustup.rs"
    exit 1
fi

echo "📦 Installing dependencies..."
pnpm install --ignore-scripts

echo "📦 Ensuring Android Rust targets are installed..."
rustup target add aarch64-linux-android
rustup target add armv7-linux-androideabi
rustup target add x86_64-linux-android
rustup target add i686-linux-android

echo ""
echo "🤖 Building for Android..."
pnpm ubrn:android

# Build for iOS (macOS only)
if [ "$OS" = "Darwin" ]; then
    echo ""
    echo "📦 Ensuring iOS Rust targets are installed..."
    rustup target add aarch64-apple-ios
    rustup target add x86_64-apple-ios
    rustup target add aarch64-apple-ios-sim

    echo ""
    echo "🍎 Building for iOS..."
    pnpm ubrn:ios
else
    echo ""
    echo "⏭️  Skipping iOS build (macOS only)"
fi

echo ""
echo "🔧 Applying post-generation patches..."
bash scripts/patch-bindings.sh
echo "✅ Patches applied"

echo ""
echo "📦 Building JS bindings..."
pnpm prepare

echo ""
echo "✅ Build complete!"
