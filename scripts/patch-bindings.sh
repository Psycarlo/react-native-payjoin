#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ----------------------------------------------------------------------------
#    Fix source_files globs to avoid duplicate symbol errors on RN 0.82+.
#    - ios/**/* -> ios/* (no recursive glob)
#    - ios/generated/**/*.{h,m,mm} -> ios/generated/**/*.{h} (headers only)
#    Reference: https://github.com/breez/spark-sdk/commit/84131fd4a1a154a8ede9a6570edd80a947a759cc
# ----------------------------------------------------------------------------
PODSPEC=$(find "$PROJECT_DIR" -maxdepth 1 -name "*.podspec" | head -1)
if [ -n "$PODSPEC" ]; then
  if grep -q '"ios/\*\*/\*' "$PODSPEC" || grep -q '{h,m,mm}"' "$PODSPEC"; then
    echo "  Patching $(basename "$PODSPEC")..."

    # ios/**/*.{h,m,mm,swift} -> ios/*.{h,m,mm,swift}
    sed -i.bak 's|"ios/\*\*/\*\.{h,m,mm,swift}"|"ios/*.{h,m,mm,swift}"|g' "$PODSPEC"

    # ios/generated/**/*.{h,m,mm} -> ios/generated/**/*.{h}
    sed -i.bak 's|"ios/generated/\*\*/\*\.{h,m,mm}"|"ios/generated/**/*.{h}"|g' "$PODSPEC"

    rm -f "$PODSPEC.bak"
    echo "  $(basename "$PODSPEC") patched"
  else
    echo "  $(basename "$PODSPEC") already patched, skipping"
  fi

  # Release tags are v-prefixed (v0.1.0), but the generated podspec points
  # :tag at the bare version. Harmless for the vendored framework, wrong for
  # anyone resolving the pod from source.
  if grep -q ':tag => "#{s.version}"' "$PODSPEC"; then
    echo "  Patching $(basename "$PODSPEC") (v-prefixed source tag)..."
    sed -i.bak 's|:tag => "#{s.version}"|:tag => "v#{s.version}"|' "$PODSPEC"
    rm -f "$PODSPEC.bak"
  fi
else
  echo "  No podspec found, skipping"
fi

# ----------------------------------------------------------------------------
#    Fix kotlinVersion property lookup in generated android/build.gradle.
#    The ubrn template hardcodes its test-fixture name in the buildscript
#    block ("DummyLibForAndroid_kotlinVersion") instead of the {{ name }}
#    placeholder, so the fallback lookup misses Payjoin_kotlinVersion from
#    gradle.properties and resolves to null in apps that don't set
#    rootProject.ext.kotlinVersion.
# ----------------------------------------------------------------------------
BUILD_GRADLE="$PROJECT_DIR/android/build.gradle"
if [ -f "$BUILD_GRADLE" ]; then
  if grep -q 'DummyLibForAndroid_kotlinVersion' "$BUILD_GRADLE"; then
    echo "  Patching build.gradle (DummyLibForAndroid_kotlinVersion)..."
    sed -i.bak 's/DummyLibForAndroid_kotlinVersion/Payjoin_kotlinVersion/g' "$BUILD_GRADLE"
    rm -f "$BUILD_GRADLE.bak"
    echo "  build.gradle patched"
  else
    echo "  build.gradle already patched, skipping"
  fi
else
  echo "  build.gradle not found, skipping"
fi

# ----------------------------------------------------------------------------
#    Fix C++ reserved keywords used as parameter names in generated FFI code.
#    Some words are valid Rust identifiers but reserved in C++, so the uniffi
#    codegen emits them verbatim into extern "C" declarations and the C++
#    compile fails. Rename them in parameter positions.
#
#    NOTE: the payjoin API surface is checked for each of these on every
#    regeneration; the loop is a no-op when a keyword does not appear.
# ----------------------------------------------------------------------------
CPP_FFI="$PROJECT_DIR/cpp/generated/payjoin.cpp"
if [ -f "$CPP_FFI" ]; then
  patched=0
  for kw in template class new delete operator register public private protected this; do
    if grep -q "RustBuffer $kw," "$CPP_FFI"; then
      echo "  Patching payjoin.cpp (C++ reserved keyword '$kw')..."
      sed -i.bak "s/RustBuffer $kw,/RustBuffer ${kw}_,/g" "$CPP_FFI"
      rm -f "$CPP_FFI.bak"
      patched=1
    fi
  done
  if [ "$patched" = "0" ]; then
    echo "  payjoin.cpp needs no keyword patches, skipping"
  fi
else
  echo "  payjoin.cpp not found, skipping"
fi

# ----------------------------------------------------------------------------
#    Re-add wrapper export to index.tsx (codegen overwrites it each time).
# ----------------------------------------------------------------------------
INDEX_TSX="$PROJECT_DIR/src/index.tsx"
if [ -f "$INDEX_TSX" ]; then
  if ! grep -q "from './wrapper'" "$INDEX_TSX"; then
    echo "  Patching index.tsx (adding wrapper export)..."
    # Insert after the generated re-export. awk rather than `sed a\`, whose
    # line-continuation form is brittle across sed implementations and fails
    # silently — leaving the wrapper unexported while still reporting success.
    awk '
      { print }
      !done && /^export \* from ".\/generated\/payjoin";$/ ||
      !done && /^export \* from '"'"'\.\/generated\/payjoin'"'"';$/ {
        print ""
        print "// Export the ergonomic wrappers (lives outside generated/ so codegen won'"'"'t overwrite)."
        print "export * from '"'"'./wrapper'"'"';"
        done = 1
      }
    ' "$INDEX_TSX" > "$INDEX_TSX.tmp" && mv "$INDEX_TSX.tmp" "$INDEX_TSX"

    # Verify, rather than trusting the edit landed.
    if grep -q "from './wrapper'" "$INDEX_TSX"; then
      echo "  index.tsx patched"
    else
      echo "::error::Failed to add wrapper export to index.tsx" >&2
      exit 1
    fi
  else
    echo "  index.tsx already has wrapper export, skipping"
  fi
fi

echo "Done."
