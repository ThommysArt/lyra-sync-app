import type {
  ClipboardItem,
  DeviceIdentity,
  FileEntry,
  PairedDevice,
  SmartFolder,
  Transfer,
} from "@lyra-sync-app/protocol";

import { generateId } from "./identity";

/** Seed paired demo devices so the UI is useful before real network peers exist. */
export function createDemoPairedDevices(self: DeviceIdentity): PairedDevice[] {
  const now = Date.now();
  return [
    {
      id: "demo_macbook",
      name: "Thommy's MacBook",
      nickname: undefined,
      type: "desktop",
      platform: "macos",
      fingerprint: "a1b2c3d4e5f60718a1b2c3d4e5f60718",
      publicKey: "demo_pub_mac",
      model: "MacBook Pro",
      osVersion: "macOS 15.5",
      pairedAt: now - 1000 * 60 * 60 * 24 * 12,
      lastSeenAt: now - 1000 * 30,
      online: true,
      connectionType: "local",
      autoAcceptTransfers: true,
      autoAcceptClipboard: true,
      showInMainList: true,
      status: {
        deviceId: "demo_macbook",
        batteryLevel: 72,
        isCharging: true,
        networkType: "wifi",
        networkName: "Home-5G",
        freeStorageBytes: 128 * 1024 ** 3,
        updatedAt: now - 1000 * 30,
      },
    },
    {
      id: "demo_pixel",
      name: "Pixel 9",
      type: "mobile",
      platform: "android",
      fingerprint: "f decafe1234567890abcdef12345678".replace(/\s/g, ""),
      publicKey: "demo_pub_pixel",
      model: "Pixel 9",
      osVersion: "Android 16",
      pairedAt: now - 1000 * 60 * 60 * 24 * 3,
      lastSeenAt: now - 1000 * 60 * 8,
      online: true,
      connectionType: "both",
      autoAcceptTransfers: true,
      autoAcceptClipboard: false,
      showInMainList: true,
      status: {
        deviceId: "demo_pixel",
        batteryLevel: 41,
        isCharging: false,
        networkType: "wifi",
        networkName: "Home-5G",
        freeStorageBytes: 42 * 1024 ** 3,
        updatedAt: now - 1000 * 60 * 8,
      },
    },
    {
      id: "demo_windows",
      name: "Office PC",
      type: "desktop",
      platform: "windows",
      fingerprint: "99887766554433221100aabbccddeeff",
      publicKey: "demo_pub_win",
      model: "Desktop",
      osVersion: "Windows 11",
      pairedAt: now - 1000 * 60 * 60 * 24 * 40,
      lastSeenAt: now - 1000 * 60 * 60 * 26,
      online: false,
      connectionType: "tailscale",
      autoAcceptTransfers: false,
      autoAcceptClipboard: false,
      showInMainList: true,
      status: {
        deviceId: "demo_windows",
        batteryLevel: null,
        isCharging: null,
        networkType: "ethernet",
        networkName: "Ethernet",
        freeStorageBytes: 512 * 1024 ** 3,
        updatedAt: now - 1000 * 60 * 60 * 26,
      },
    },
  ].filter((d) => d.id !== self.id);
}

export function createDemoClipboardHistory(self: DeviceIdentity): ClipboardItem[] {
  const now = Date.now();
  return [
    {
      id: generateId("clip"),
      type: "text",
      text: "https://ui.shadcn.com/docs/components/button",
      sourceDeviceId: "demo_macbook",
      sourceDeviceName: "Thommy's MacBook",
      createdAt: now - 1000 * 60 * 4,
      pinned: true,
    },
    {
      id: generateId("clip"),
      type: "text",
      text: "Meeting notes: sync clipboard + multi-device send for Lyra MVP",
      sourceDeviceId: self.id,
      sourceDeviceName: self.name,
      createdAt: now - 1000 * 60 * 25,
      pinned: false,
    },
    {
      id: generateId("clip"),
      type: "text",
      text: "lyra-pairing://v1/ABCD12",
      sourceDeviceId: "demo_pixel",
      sourceDeviceName: "Pixel 9",
      createdAt: now - 1000 * 60 * 90,
      pinned: false,
    },
  ];
}

export function createDemoTransfers(): Transfer[] {
  const now = Date.now();
  return [
    {
      id: generateId("tx"),
      direction: "received",
      deviceId: "demo_macbook",
      deviceName: "Thommy's MacBook",
      files: [
        { name: "vacation-italy.zip", size: 248_000_000, mimeType: "application/zip" },
      ],
      totalBytes: 248_000_000,
      transferredBytes: 248_000_000,
      status: "completed",
      createdAt: now - 1000 * 60 * 60 * 5,
      updatedAt: now - 1000 * 60 * 60 * 5 + 42_000,
      completedAt: now - 1000 * 60 * 60 * 5 + 42_000,
      durationMs: 42_000,
      averageSpeedBps: 5_900_000,
    },
    {
      id: generateId("tx"),
      direction: "sent",
      deviceId: "demo_pixel",
      deviceName: "Pixel 9",
      files: [
        { name: "design-spec.pdf", size: 4_200_000, mimeType: "application/pdf" },
        { name: "screenshots", size: 18_500_000 },
      ],
      totalBytes: 22_700_000,
      transferredBytes: 12_100_000,
      status: "transferring",
      createdAt: now - 1000 * 40,
      updatedAt: now - 1000 * 2,
    },
  ];
}

const SMART_FOLDER_PATHS: Record<SmartFolder, string> = {
  photos: "/Photos",
  documents: "/Documents",
  downloads: "/Downloads",
  desktop: "/Desktop",
  screenshots: "/Pictures/Screenshots",
};

export function listDemoFiles(path: string): FileEntry[] {
  const now = Date.now();
  if (path === "/" || path === "") {
    return [
      {
        name: "Photos",
        path: SMART_FOLDER_PATHS.photos,
        isDirectory: true,
        modifiedAt: now - 1000 * 60 * 60,
      },
      {
        name: "Documents",
        path: SMART_FOLDER_PATHS.documents,
        isDirectory: true,
        modifiedAt: now - 1000 * 60 * 120,
      },
      {
        name: "Downloads",
        path: SMART_FOLDER_PATHS.downloads,
        isDirectory: true,
        modifiedAt: now - 1000 * 60 * 15,
      },
      {
        name: "Desktop",
        path: SMART_FOLDER_PATHS.desktop,
        isDirectory: true,
        modifiedAt: now - 1000 * 60 * 50,
      },
      {
        name: "Screenshots",
        path: SMART_FOLDER_PATHS.screenshots,
        isDirectory: true,
        modifiedAt: now - 1000 * 60 * 10,
      },
    ];
  }

  if (path.includes("Photos") || path.includes("Screenshots")) {
    return [
      {
        name: "IMG_2048.HEIC",
        path: `${path}/IMG_2048.HEIC`,
        isDirectory: false,
        size: 3_200_000,
        modifiedAt: now - 1000 * 60 * 60 * 3,
        mimeType: "image/heic",
      },
      {
        name: "IMG_2049.HEIC",
        path: `${path}/IMG_2049.HEIC`,
        isDirectory: false,
        size: 2_800_000,
        modifiedAt: now - 1000 * 60 * 60 * 2,
        mimeType: "image/heic",
      },
      {
        name: "Camera",
        path: `${path}/Camera`,
        isDirectory: true,
        modifiedAt: now - 1000 * 60 * 60 * 24,
      },
    ];
  }

  if (path.includes("Documents")) {
    return [
      {
        name: "Lyra-Product-Spec.md",
        path: `${path}/Lyra-Product-Spec.md`,
        isDirectory: false,
        size: 18_400,
        modifiedAt: now - 1000 * 60 * 60 * 6,
        mimeType: "text/markdown",
      },
      {
        name: "budget-2026.xlsx",
        path: `${path}/budget-2026.xlsx`,
        isDirectory: false,
        size: 88_000,
        modifiedAt: now - 1000 * 60 * 60 * 48,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ];
  }

  if (path.includes("Downloads")) {
    return [
      {
        name: "installer.dmg",
        path: `${path}/installer.dmg`,
        isDirectory: false,
        size: 120_000_000,
        modifiedAt: now - 1000 * 60 * 30,
        mimeType: "application/x-apple-diskimage",
      },
      {
        name: "notes.txt",
        path: `${path}/notes.txt`,
        isDirectory: false,
        size: 2_400,
        modifiedAt: now - 1000 * 60 * 90,
        mimeType: "text/plain",
      },
    ];
  }

  return [
    {
      name: "readme.txt",
      path: `${path}/readme.txt`,
      isDirectory: false,
      size: 512,
      modifiedAt: now - 1000 * 60 * 20,
      mimeType: "text/plain",
    },
  ];
}

export { SMART_FOLDER_PATHS };
