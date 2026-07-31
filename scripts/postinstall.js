#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execSync } = require("child_process");

const MAX_REDIRECTS = 5;
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const BASE_URL =
  "https://github.com/Psycarlo/react-native-payjoin/releases/download";

const ARTIFACTS = [
  {
    name: "Android",
    zipName: "android-artifacts.zip",
    checksumKey: "android",
    existsPath: path.join(PACKAGE_ROOT, "android", "src", "main", "jniLibs"),
    buildCmd: "pnpm ubrn:android",
  },
  {
    name: "iOS",
    zipName: "ios-artifacts.zip",
    checksumKey: "ios",
    existsPath: path.join(PACKAGE_ROOT, "build", "RnPayjoin.xcframework"),
    buildCmd: "pnpm ubrn:ios",
    platformGuard: "darwin",
  },
];

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    const request = (requestUrl) => {
      const proto = requestUrl.startsWith("https") ? https : require("http");
      proto
        .get(requestUrl, (response) => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.resume();
            if (++redirects > MAX_REDIRECTS) {
              reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
              return;
            }
            request(response.headers.location);
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            reject(
              new Error(
                `Download failed with status ${response.statusCode}: ${requestUrl}`,
              ),
            );
            return;
          }

          const file = fs.createWriteStream(destPath);
          response.pipe(file);
          file.on("finish", () => {
            file.close(resolve);
          });
          file.on("error", (err) => {
            fs.unlinkSync(destPath);
            reject(err);
          });
        })
        .on("error", reject);
    };

    request(url);
  });
}

function verifyChecksum(filePath, expectedChecksum) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => {
      const actual = hash.digest("hex");
      if (actual !== expectedChecksum) {
        reject(
          new Error(
            `Checksum mismatch for ${path.basename(filePath)}\n` +
              `  Expected: ${expectedChecksum}\n` +
              `  Got:      ${actual}`,
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    execSync(
      `powershell -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'"`,
      { stdio: "pipe" },
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "pipe" });
  }
}

function cleanup(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    // ignore
  }
}

async function downloadAndExtract(name, url, zipPath, checksum) {
  try {
    console.log(`[react-native-payjoin] Downloading ${name} artifacts...`);
    await download(url, zipPath);

    console.log(`[react-native-payjoin] Verifying ${name} checksum...`);
    await verifyChecksum(zipPath, checksum);

    console.log(`[react-native-payjoin] Extracting ${name} artifacts...`);
    extractZip(zipPath, PACKAGE_ROOT);
    cleanup(zipPath);

    console.log(`[react-native-payjoin] ${name} artifacts: OK`);
  } catch (err) {
    cleanup(zipPath);
    throw err;
  }
}

async function main() {
  if (process.env.SKIP_PAYJOIN_POSTINSTALL) {
    console.log(
      "[react-native-payjoin] Skipping postinstall (SKIP_PAYJOIN_POSTINSTALL is set)",
    );
    return;
  }

  const allExist = ARTIFACTS.every(
    (a) =>
      fs.existsSync(a.existsPath) ||
      (a.platformGuard && process.platform !== a.platformGuard),
  );
  if (allExist) {
    console.log(
      "[react-native-payjoin] Native artifacts already present, skipping download",
    );
    return;
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  const { checksums } = packageJson;

  if (!checksums || !checksums.android) {
    console.log(
      "[react-native-payjoin] No checksums found in package.json, skipping download",
    );
    console.log("  To build native binaries manually, run:");
    for (const artifact of ARTIFACTS) {
      if (!artifact.platformGuard || process.platform === artifact.platformGuard) {
        console.log(`    ${artifact.buildCmd}`);
      }
    }
    return;
  }

  const releaseTag = packageJson.releaseTag || `v${packageJson.version}`;
  if (!releaseTag) {
    console.error("[react-native-payjoin] No releaseTag found in package.json");
    process.exit(1);
  }

  console.log(
    `[react-native-payjoin] Downloading prebuilt binaries for ${releaseTag}...`,
  );

  for (const artifact of ARTIFACTS) {
    if (artifact.platformGuard && process.platform !== artifact.platformGuard) {
      continue;
    }
    if (fs.existsSync(artifact.existsPath)) {
      continue;
    }

    const checksum = checksums[artifact.checksumKey];
    if (!checksum) {
      console.log(
        `[react-native-payjoin] No ${artifact.name} checksum found, skipping`,
      );
      console.log(`  To build manually: ${artifact.buildCmd}`);
      continue;
    }

    const zipPath = path.join(PACKAGE_ROOT, artifact.zipName);
    const url = `${BASE_URL}/${releaseTag}/${artifact.zipName}`;

    try {
      await downloadAndExtract(artifact.name, url, zipPath, checksum);
    } catch (err) {
      console.error(
        `[react-native-payjoin] Failed to download ${artifact.name} artifacts: ${err.message}`,
      );
      console.error(
        `  To build manually: ${artifact.buildCmd}`,
      );
      process.exit(1);
    }
  }

  console.log("[react-native-payjoin] Native artifacts installed successfully");
}

main().catch((err) => {
  console.error(`[react-native-payjoin] Postinstall failed: ${err.message}`);
  process.exit(1);
});
