#!/usr/bin/env node
/*
 * Patch the uniffi-bindgen-react-native include-path lookup in a generated
 * android/CMakeLists.txt.
 *
 * The ubrn template emits:
 *
 *     # Resolve the path to the uniffi-bindgen-react-native package
 *     execute_process(
 *         COMMAND node -p "require.resolve('uniffi-bindgen-react-native/package.json')"
 *         OUTPUT_VARIABLE UNIFFI_BINDGEN_PATH
 *         OUTPUT_STRIP_TRAILING_WHITESPACE
 *     )
 *     get_filename_component(UNIFFI_BINDGEN_PATH "${UNIFFI_BINDGEN_PATH}" DIRECTORY)
 *
 * uniffi-bindgen-react-native 0.31.0-3 added an "exports" map that does not
 * expose "./package.json", so require.resolve throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. CMake's execute_process leaves
 * OUTPUT_VARIABLE empty when the command fails, the include directory becomes
 * "/cpp/includes", and the build fails much later with
 * "'UniffiCallInvoker.h' file not found".
 *
 * This replaces the block with one that resolves the "." export (always
 * present) and walks up to the directory that actually contains cpp/includes,
 * then hard-fails at CMake configure time if the headers are not there.
 *
 * Node rather than python: node is guaranteed present in this repo's toolchain
 * (CMake itself shells out to it), whereas `python3` vs `python` differs
 * between CI images and Windows dev machines.
 *
 * Run via scripts/patch-bindings.sh after every ubrn regeneration. Idempotent.
 */

const fs = require("fs");

// Sentinel proving this patch was applied. Must appear in REPLACEMENT and must
// never appear in the upstream-generated file.
const PATCH_MARKER = "PATCHED by scripts/patch-bindings.sh";

const REPLACEMENT = `# Resolve the path to the uniffi-bindgen-react-native package.
#
# PATCHED by scripts/patch-bindings.sh -- do not hand-edit; see that script.
#
# The ubrn template resolves 'uniffi-bindgen-react-native/package.json', but
# 0.31.0-3 added an "exports" map that does not expose "./package.json", so
# require.resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED. execute_process leaves
# OUTPUT_VARIABLE empty on failure, the include path silently degrades to
# "/cpp/includes", and the build dies much later with a confusing
# "'UniffiCallInvoker.h' file not found".
#
# Instead resolve the "." export (always present) and walk up to whichever
# directory actually contains cpp/includes. That works whether the package is
# hoisted to the app's root node_modules or nested under this library.
#
# Resolution is anchored to CMAKE_CURRENT_SOURCE_DIR, passed as argv[1]:
# execute_process runs in the *build* directory, which lives under .cxx/ and
# would resolve to the wrong node_modules (or none at all).
execute_process(
    COMMAND node -e "const path=require('path'),fs=require('fs');const{createRequire}=require('module');const req=createRequire(path.join(process.argv[1],'noop.js'));let d=path.dirname(req.resolve('uniffi-bindgen-react-native'));while(d!==path.parse(d).root&&!fs.existsSync(path.join(d,'cpp','includes')))d=path.dirname(d);process.stdout.write(d)" "\${CMAKE_CURRENT_SOURCE_DIR}"
    OUTPUT_VARIABLE UNIFFI_BINDGEN_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
# get_filename_component normalizes Windows path separators.
get_filename_component(UNIFFI_BINDGEN_PATH "\${UNIFFI_BINDGEN_PATH}" ABSOLUTE)

# Fail at configure time rather than emitting a broken -I flag and failing in
# the middle of the C++ compile.
if (NOT EXISTS "\${UNIFFI_BINDGEN_PATH}/cpp/includes/UniffiCallInvoker.h")
  message(FATAL_ERROR
    "Could not locate the uniffi-bindgen-react-native C++ includes.\\n"
    "Resolved to: '\${UNIFFI_BINDGEN_PATH}'\\n"
    "Expected:    '\${UNIFFI_BINDGEN_PATH}/cpp/includes/UniffiCallInvoker.h'\\n"
    "Is uniffi-bindgen-react-native installed and resolvable from "
    "\${CMAKE_CURRENT_SOURCE_DIR}?")
endif()`;

// Matches the generated block from its leading comment through the
// get_filename_component call that derives the package directory.
const PATTERN = new RegExp(
  [
    "# Resolve the path to the uniffi-bindgen-react-native package\\r?\\n",
    "execute_process\\(\\s*\\r?\\n",
    "\\s*COMMAND node -p \"require\\.resolve\\('uniffi-bindgen-react-native/package\\.json'\\)\"\\s*\\r?\\n",
    "\\s*OUTPUT_VARIABLE UNIFFI_BINDGEN_PATH\\s*\\r?\\n",
    "\\s*OUTPUT_STRIP_TRAILING_WHITESPACE\\s*\\r?\\n",
    "\\)\\r?\\n",
    "(?:#[^\\r\\n]*\\r?\\n)*", // the template's "Get the directory; ..." comment lines
    "get_filename_component\\(UNIFFI_BINDGEN_PATH \"\\$\\{UNIFFI_BINDGEN_PATH\\}\" DIRECTORY\\)",
  ].join(""),
);

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error(
      `usage: ${process.argv[1]} <path-to-CMakeLists.txt>`,
    );
    return 2;
  }

  // Guard against the marker and the replacement drifting apart in a future
  // edit, which would silently break idempotency.
  if (!REPLACEMENT.includes(PATCH_MARKER)) {
    console.error(
      "::error::internal: PATCH_MARKER is missing from REPLACEMENT",
    );
    return 1;
  }

  const original = fs.readFileSync(target, "utf8");

  // Key idempotency off a marker only this patch introduces. Grepping for
  // "package.json" would false-positive: the replacement's own comment
  // mentions it while explaining the bug.
  if (original.includes(PATCH_MARKER)) {
    console.log("  CMakeLists.txt already patched, nothing to do");
    return 0;
  }

  const matches = original.match(new RegExp(PATTERN.source, "g"));
  if (!matches || matches.length !== 1) {
    // Refuse to guess: the upstream template changed shape, so a blind edit
    // could corrupt the build file.
    console.error(
      `::error::Could not match the expected uniffi resolution block in ` +
        `${target} (matched ${matches ? matches.length : 0} times). The ubrn ` +
        `template likely changed; update scripts/patch-cmake-uniffi-path.js.`,
    );
    return 1;
  }

  // Preserve the file's existing line endings: if the generated file is CRLF,
  // emit a CRLF replacement rather than mixing terminators.
  const usesCrlf = /\r\n/.test(original);
  const replacement = usesCrlf
    ? REPLACEMENT.replace(/\n/g, "\r\n")
    : REPLACEMENT;

  // Function form of replace(): the replacement is full of CMake "${VAR}"
  // references, and the string form would interpret "$" as a capture-group
  // escape and mangle them.
  fs.writeFileSync(target, original.replace(PATTERN, () => replacement), "utf8");
  console.log("  CMakeLists.txt uniffi include path patched");
  return 0;
}

process.exit(main());
