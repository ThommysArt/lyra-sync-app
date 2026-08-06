/**
 * Smoke: Xcode-style simulator geometry.
 * Run: pnpm --filter web exec node scripts/smoke-geometry.mjs
 */
import {
  computeSimulatorLayout,
  resolveDeviceProfile,
  formatScale,
} from "../src/lib/device-geometry.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const pixel = { type: "mobile", platform: "android", name: "Pixel 6" };
const profile = resolveDeviceProfile(pixel);
assert(profile.id === "pixel-6", `expected pixel-6 got ${profile.id}`);

// Tall phone needs a tall display for true 100% (same as Xcode Simulator)
const layout100 = computeSimulatorLayout({
  device: pixel,
  maxOuterWidth: 1920,
  maxOuterHeight: 1400,
  preferredScale: 1,
});
assert(layout100.scale === 1, `expected 100% got ${layout100.scale}`);
assert(layout100.windowWidth > layout100.deviceWidth, "window wider than device");
assert(layout100.deviceWidth > layout100.screenWidth, "bezel adds width");
assert(
  Math.abs(layout100.shellAspect - layout100.deviceWidth / layout100.deviceHeight) < 0.001,
  "shell aspect",
);

// On a typical 1080p laptop, Pixel steps down (correct Simulator behavior)
const layout1080 = computeSimulatorLayout({
  device: pixel,
  maxOuterWidth: 1920,
  maxOuterHeight: 1080,
  preferredScale: 1,
});
assert(layout1080.scale < 1, `1080p should scale down, got ${layout1080.scale}`);

// Small display forces step-down
const layoutSmall = computeSimulatorLayout({
  device: pixel,
  maxOuterWidth: 500,
  maxOuterHeight: 700,
  preferredScale: 1,
});
assert(layoutSmall.scale < 1, `should scale down, got ${layoutSmall.scale}`);
assert(layoutSmall.windowHeight <= 700 - 16, "fits height");

// Live frame refines aspect (1080x2400 phone)
const fromFrame = computeSimulatorLayout({
  device: pixel,
  frameWidth: 1080,
  frameHeight: 2400,
  maxOuterWidth: 1600,
  maxOuterHeight: 1000,
});
assert(fromFrame.screenHeight > fromFrame.screenWidth, "portrait from frame");
const ratio = fromFrame.screenHeight / fromFrame.screenWidth;
assert(Math.abs(ratio - 2400 / 1080) < 0.02, `aspect ${ratio}`);

// iPhone profile
const iphone = resolveDeviceProfile({ type: "mobile", platform: "ios", name: "iPhone 15" });
assert(iphone.id === "iphone-15", iphone.id);

console.log("pixel@100%", {
  window: `${layout100.windowWidth}x${layout100.windowHeight}`,
  device: `${layout100.deviceWidth}x${layout100.deviceHeight}`,
  screen: `${layout100.screenWidth}x${layout100.screenHeight}`,
  scale: formatScale(layout100.scale),
});
console.log("pixel@small", {
  window: `${layoutSmall.windowWidth}x${layoutSmall.windowHeight}`,
  scale: formatScale(layoutSmall.scale),
});
console.log("SMOKE_GEOMETRY_OK");
