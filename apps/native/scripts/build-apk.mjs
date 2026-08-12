#!/usr/bin/env node
/**
 * Build a variant-specific Android APK and copy it to a versioned filename:
 *   dist/lyra-0.2.3-dev.apk
 *   dist/lyra-0.2.3-preview.apk
 *
 * Usage:
 *   APP_VARIANT=development node scripts/build-apk.mjs debug
 *   APP_VARIANT=preview     node scripts/build-apk.mjs release
 *   node scripts/build-apk.mjs release --skip-prebuild
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nativeRoot = resolve(__dirname, "..");
const androidRoot = join(nativeRoot, "android");
const distDir = join(nativeRoot, "dist");

const buildType = (process.argv[2] || "release").toLowerCase(); // debug | release
const skipPrebuild = process.argv.includes("--skip-prebuild");

function resolveVariant() {
  const raw = (process.env.APP_VARIANT || "").toLowerCase().trim();
  if (raw === "development" || raw === "dev") return "development";
  if (raw === "preview" || raw === "pre") return "preview";
  if (raw === "production" || raw === "prod") return "production";
  // Infer from build type when unset
  return buildType === "debug" ? "development" : "preview";
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(nativeRoot, "package.json"), "utf8"));
  return pkg.version || "0.0.0";
}

function variantSlug(variant) {
  if (variant === "development") return "dev";
  if (variant === "preview") return "preview";
  return "prod";
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || nativeRoot,
    env: { ...process.env, ...opts.env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function findNewestApk(dir) {
  if (!existsSync(dir)) return null;
  const apks = readdirSync(dir)
    .filter((f) => f.endsWith(".apk") && !f.endsWith("-unsigned.apk"))
    .map((f) => join(dir, f))
    .filter((p) => existsSync(p));
  if (apks.length === 0) return null;
  apks.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return apks[0];
}

const variant = resolveVariant();
const version = readVersion();
const slug = variantSlug(variant);
process.env.APP_VARIANT = variant;
// expo-constants createExpoConfig requires NODE_ENV (Gradle invokes node without Expo CLI)
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = buildType === "debug" ? "development" : "production";
}

console.log(`\n[lyra] Building ${variant} APK · version ${version} · ${buildType}\n`);

function resolveAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_SDK,
    join(process.env.HOME || "", "Android/Sdk"),
    "/opt/android-sdk",
    "/usr/local/lib/android/sdk",
    "/opt/android/sdk",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && existsSync(join(c, "platform-tools", "adb"))) return c;
  }
  return null;
}

function ensureAndroidLocalProperties() {
  const sdk = resolveAndroidSdk();
  if (!sdk) {
    console.warn("[lyra] ANDROID_HOME not found — gradle will need sdk.dir in android/local.properties");
    return;
  }
  // Ensure env is set for child processes (Gradle + Expo prebuild)
  if (!process.env.ANDROID_HOME) process.env.ANDROID_HOME = sdk;
  if (!process.env.ANDROID_SDK_ROOT) process.env.ANDROID_SDK_ROOT = sdk;
  const propsPath = join(androidRoot, "local.properties");
  try {
    const content = `sdk.dir=${sdk.replace(/\\/g, "\\\\")}\n`;
    if (!existsSync(propsPath) || readFileSync(propsPath, "utf8") !== content) {
      writeFileSync(propsPath, content, "utf8");
      console.log(`[lyra] wrote android/local.properties → ${sdk}`);
    }
  } catch (e) {
    console.warn("[lyra] could not write local.properties", e);
  }
}

if (!skipPrebuild) {
  // --clean so package id / applicationId switches apply when flipping variants
  // Ensure SDK is known to Expo prebuild (it creates local.properties from ANDROID_HOME)
  ensureAndroidLocalProperties();
  const sdkForPrebuild = resolveAndroidSdk();
  run(
    "pnpm",
    ["exec", "expo", "prebuild", "--platform", "android", "--clean", "--non-interactive"],
    {
      env: {
        APP_VARIANT: variant,
        NODE_ENV: process.env.NODE_ENV,
        ...(sdkForPrebuild ? { ANDROID_HOME: sdkForPrebuild, ANDROID_SDK_ROOT: sdkForPrebuild } : {}),
      },
    },
  );
  // Expo --clean deletes local.properties — recreate it for Gradle
  ensureAndroidLocalProperties();
} else if (!existsSync(androidRoot)) {
  console.error("[lyra] android/ missing — run without --skip-prebuild first");
  process.exit(1);
} else {
  ensureAndroidLocalProperties();
}

// Raise Gradle heap after prebuild (Expo default Metaspace often OOMs on CI)
const gradleProps = join(androidRoot, "gradle.properties");
if (existsSync(gradleProps) && process.env.CI === "true") {
  try {
    let props = readFileSync(gradleProps, "utf8");
    const jvm =
      "org.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=2g -XX:ReservedCodeCacheSize=512m -Dfile.encoding=UTF-8";
    if (/^org\.gradle\.jvmargs=/m.test(props)) {
      props = props.replace(/^org\.gradle\.jvmargs=.*$/m, jvm);
    } else {
      props += `\n${jvm}\n`;
    }
    if (!props.includes("org.gradle.workers.max")) {
      props +=
        "\norg.gradle.workers.max=2\norg.gradle.parallel=false\norg.gradle.daemon=false\nkotlin.daemon.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=1g\n";
    }
    writeFileSync(gradleProps, props, "utf8");
    console.log("[lyra] CI: raised Gradle memory in gradle.properties");
  } catch (e) {
    console.warn("[lyra] could not patch gradle.properties", e);
  }
}

const gradleTask = buildType === "debug" ? "assembleDebug" : "assembleRelease";
run("chmod", ["+x", "gradlew"], { cwd: androidRoot });
const sdkForGradle = resolveAndroidSdk();
run("./gradlew", [gradleTask], {
  cwd: androidRoot,
  env: {
    APP_VARIANT: variant,
    NODE_ENV: process.env.NODE_ENV,
    EXPO_PUBLIC_LYRA_ENV:
      process.env.EXPO_PUBLIC_LYRA_ENV ||
      (variant === "development" ? "development" : variant === "preview" ? "preview" : "production"),
    ...(sdkForGradle ? { ANDROID_HOME: sdkForGradle, ANDROID_SDK_ROOT: sdkForGradle } : {}),
  },
});

const apkDir = join(
  androidRoot,
  "app/build/outputs/apk",
  buildType === "debug" ? "debug" : "release",
);
const src = findNewestApk(apkDir);
if (!src) {
  console.error(`[lyra] No APK found under ${apkDir}`);
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
const outName = `lyra-${version}-${slug}.apk`;
const dest = join(distDir, outName);
copyFileSync(src, dest);

const sizeMb = (statSync(dest).size / (1024 * 1024)).toFixed(1);
console.log(`\n[lyra] APK ready: ${dest} (${sizeMb} MiB)`);
console.log(`[lyra] Install: adb install -r ${dest}\n`);
