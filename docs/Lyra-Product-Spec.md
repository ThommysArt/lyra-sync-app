# Lyra — Product Specification

**Version:** 1.0 (MVP)  
**Status:** Draft  
**Last Updated:** 2026-07-17  
**Codename:** Lyra

---

## 1. Overview

Lyra is a privacy-first, cross-platform application that creates a trusted local network of the user’s own devices. It enables seamless clipboard synchronization, fast file transfer, remote file browsing, and lightweight device control — all without any central servers, accounts, or cloud dependencies.

The primary connection mode is the local network. Tailscale can be used optionally on a per-device basis to extend the trusted network across the internet while preserving the same security and pairing model.

Lyra draws heavily from the design philosophy and technical approaches of LocalSend (discovery + transfer protocol) and Sefirah (clipboard sync, device linking, and storage access patterns).

### 1.1 Vision

> Your devices should feel like a single cohesive system when they are near each other (or connected via Tailscale), while remaining completely private and under your control.

### 1.2 Core Pillars

1. **Trusted Device Network** — Permanent pairing with clear ownership and revocation.
2. **Clipboard Continuity** — Automatic and manual clipboard sharing between paired devices.
3. **File Access & Transfer** — Fast peer-to-peer transfers + the ability to browse another device’s files.
4. **Local-First & Private** — No accounts, no telemetry, no external servers for core functionality.

---

## 2. Goals and Non-Goals

### 2.1 Goals (v1)

- Create a permanent, user-controlled network of trusted devices.
- Provide reliable clipboard synchronization (text + basic images where platform allows).
- Enable fast, resumable file and folder transfers between any pair of devices.
- Allow browsing of another device’s file system from within the app (with smart shortcuts).
- Support sending content to multiple devices simultaneously.
- Work primarily on the local network, with optional Tailscale support.
- Maintain a high level of security through cryptographic pairing and explicit trust.

### 2.2 Non-Goals (v1)

- No user accounts or cloud backend of any kind.
- No continuous folder synchronization (that is the domain of tools like Syncthing).
- No full remote desktop or advanced remote control.
- No SMS, call, or deep notification mirroring.
- No true OS-level network drive mounting (in-app browser only).
- No screen mirroring (planned for a future version).

---

## 3. Target Platforms

| Platform       | Technology Stack                  | Priority |
|----------------|-----------------------------------|----------|
| Windows        | Electron + Vite + TanStack Router | High     |
| macOS          | Electron + Vite + TanStack Router | High     |
| Linux          | Electron + Vite + TanStack Router | High     |
| Android        | React Native (Expo) + HeroUI      | High     |
| iOS            | React Native (Expo) + HeroUI      | Medium   |

**Desktop UI foundation:** React + TypeScript + Tailwind CSS + shadcn/ui  
**Mobile UI foundation:** React Native + HeroUI Native + Uniwind/Tailwind

---

## 4. Core Concepts

### 4.1 Device Identity

Every installation of Lyra generates a unique, long-term device identity consisting of:

- A cryptographic key pair (public/private)
- A human-readable device name (user-editable)
- A device type (desktop / mobile)
- A fingerprint derived from the public key
- Optional device model / OS information

The private key never leaves the device. The public key and fingerprint are used for pairing and authentication.

### 4.2 Trusted Network

A user’s “network” is simply the set of devices that have completed the pairing process with each other. There is no central coordinator.

- Pairing is permanent until explicitly removed by the user on either device.
- Once paired, devices automatically recognize and trust each other on subsequent discoveries.
- Auto-accept of transfers and clipboard items is the default behavior between paired devices (can be overridden per device or globally).

### 4.3 Discovery

Lyra uses a hybrid discovery system:

1. **Local Network (Primary)**  
   - UDP multicast announcements (LocalSend-inspired)  
   - HTTP registration / info exchange on a well-known port

2. **Tailscale (Optional)**  
   - Devices that have Tailscale running can discover each other via Tailscale IPs / MagicDNS  
   - Multicast may not work reliably over Tailscale; therefore direct probing of known Tailscale peers and manual addition are supported

3. **Manual / Favorites**  
   - Users can add devices by Tailscale name, IP, or by completing pairing via QR/code even when not on the same network

### 4.4 Pairing System

Two pairing methods are supported:

**Method A — QR Code (Preferred when one device has a camera)**  
- The desktop (or any device without a convenient camera) displays a QR code containing:
  - Device public key / fingerprint
  - Temporary pairing token
  - Connection information (IP/port or Tailscale identifier)
- The mobile device scans the QR code and initiates the pairing handshake.
- Both sides must confirm the pairing.

**Method B — Pairing Code**  
- One device displays a short numeric or alphanumeric code (e.g. 6–8 characters).
- The other device enters the code.
- A secure handshake follows using the code as a short-lived shared secret.
- Both sides must confirm.

After successful pairing:
- The devices exchange and store each other’s public keys / fingerprints.
- They appear in each other’s “Paired Devices” list.
- Future connections are authenticated using the stored keys.

Unpairing can be performed from either device and immediately revokes trust.

---

## 5. Feature Specifications

### 5.1 Paired Devices Management

**Location:** Settings → Paired Devices

- List of all currently paired devices with:
  - Device name
  - Device type / platform
  - Last seen timestamp
  - Current online/offline status
  - Connection type (Local / Tailscale / Both)
- Ability to rename a paired device (local nickname)
- Ability to remove (unpair) a device
- Per-device settings:
  - Auto-accept incoming transfers
  - Auto-accept clipboard items
  - Show in main device list

### 5.2 Device Status

Each online paired device periodically shares a lightweight status payload:

- Battery level (%) and charging state (when available)
- Current network type (Wi-Fi name if available, or “Ethernet” / “Cellular” / “Tailscale”)
- Device name and platform version
- Optional: free storage space on primary volume

Status is displayed next to the device in the main list and in the device detail view. Updates are sent at a low frequency to minimize battery and bandwidth impact.

### 5.3 Clipboard Sync

**Supported content:**
- Plain text (primary)
- Images (where the platform clipboard APIs allow)

**Behavior:**
- When content is copied on a device, it can be automatically pushed to other paired devices (configurable).
- Receiving devices can automatically write the content to their system clipboard or show a notification with an “Copy” action.
- Manual “Send Clipboard” action is always available.

**Platform notes:**
- Desktop (Windows / macOS / Linux): Full support for monitoring and writing.
- Android: Full support; automatic monitoring requires Accessibility Service permission.
- iOS: Receiving is supported. Automatic detection of copy events is heavily restricted by the system; manual send is the reliable path.

### 5.4 Clipboard History

- Local-only history of recent clipboard items (text + images where supported).
- Configurable retention (default: last 20–50 items or time-based).
- Ability to re-send any history item to one or more paired devices.
- Ability to pin important items.
- Clear history action.

iOS support will be limited compared to other platforms due to system restrictions.

### 5.5 File Transfer

Core transfer capabilities (inspired by LocalSend protocol):

- Send files and folders to one or multiple paired devices.
- Receive files with progress indication.
- Pause and resume individual transfers or the entire session.
- Cancel transfers.
- Conflict handling (rename / overwrite / skip) when the destination already has a file with the same name.
- Transfer speed and ETA display.
- Optional verification of file integrity after transfer.

**Multi-device send:**  
A single send operation can target multiple paired devices simultaneously. Each target maintains its own independent transfer session and progress.

### 5.6 Transfer History

- Persistent local log of all sent and received transfers.
- Information stored per transfer:
  - Direction (sent / received)
  - Device name
  - File/folder names and total size
  - Timestamp
  - Status (completed, failed, cancelled, partial)
  - Duration and average speed
- Ability to re-send any previously sent item.
- Search and basic filtering.
- Option to clear history.

### 5.7 File Explorer (Remote Browse)

Users can browse the file system of any online paired device from within Lyra.

**Capabilities:**
- Navigate folders
- View file metadata (size, modified date)
- Preview supported file types where feasible
- Multi-select files and folders
- Download selected items to the local device
- Upload local files/folders into the remote location
- Delete / rename (with confirmation) on the remote device (optional, can be restricted)

**Smart Folder Shortcuts** (always available at the top level of a remote device):

- Photos / Camera Roll
- Documents
- Downloads
- Desktop (desktop devices)
- Screenshots
- (Platform-specific additional shortcuts may be added)

These shortcuts resolve to the appropriate standard locations on the remote device.

### 5.8 Open URL on Other Device

- From any device, a user can send a URL to one or more paired devices.
- The receiving device offers to open the URL in the default browser (or shows a notification with an Open action).
- Useful for continuing research or sharing links instantly.

### 5.9 Drag and Drop (Desktop)

- Drag files or folders from the native file manager onto a device in the Lyra device list → initiates a send.
- Drag files into the remote file explorer view → uploads to the current remote folder.
- Drag from the remote file explorer to the local desktop → downloads.

### 5.10 Keyboard Shortcuts (Desktop)

A set of global and in-app keyboard shortcuts will be provided for power users. Exact key bindings are left to implementation, but the following actions should be supported:

- Focus search / device list
- Send current clipboard to selected device(s)
- Open file explorer for selected device
- Pause / resume active transfers
- Open settings
- Quit application

### 5.11 Pairing UX Requirements

- Desktop devices primarily display QR codes and pairing codes (they are not expected to scan).
- Mobile devices can both scan QR codes and enter pairing codes.
- Clear visual indication when a pairing request is incoming.
- Both sides must explicitly confirm before the pairing is finalized.
- After pairing, the new device appears immediately in the paired list and main device list (if online).

---

## 6. Security Model

- All device-to-device communication after pairing is authenticated using the stored public keys / fingerprints.
- Optional encryption of the transport (HTTPS with self-signed certificates or application-level encryption) is recommended and should be the default.
- Pairing requires explicit user confirmation on both sides.
- Unpairing on either side immediately invalidates the trust relationship.
- No data is ever sent to external servers as part of core functionality.
- Clipboard and file data remain solely on the participating devices and the local/Tailscale network.

---

## 7. Architecture Principles

- **Peer-to-peer only** — Every device is both client and server.
- **No central coordinator** — The network is fully decentralized.
- **Shared protocol** — A common TypeScript-defined protocol (with Zod schemas) is used across desktop and mobile.
- **Local HTTP(S) servers** — Receiving devices run short-lived or long-lived local servers for transfers and browsing.
- **Hybrid discovery** — Multicast + direct probing + manual addition.
- **Minimal background work** — Status updates and discovery are kept lightweight to preserve battery life on mobile.
- **Graceful degradation** — Features that cannot be fully supported on a platform (especially iOS clipboard monitoring) fall back to manual actions rather than failing.

---

## 8. Future Considerations (Post-v1)

The following are explicitly out of scope for the initial release but are candidates for later versions:

- Screen mirroring
- More advanced remote actions
- Richer notification integration
- Optional end-to-end encrypted relay for cases where neither local network nor Tailscale is available
- Plugin / extension system
- True virtual filesystem mounts on selected platforms

---

## 9. Success Criteria for v1

- A user can permanently pair a desktop and a mobile device in under two minutes using either QR or code.
- Clipboard text copied on one paired device appears on the other with minimal friction.
- Files can be sent to multiple devices with pause/resume support and full transfer history.
- A user can browse Photos and Documents on another device and download or open files.
- The application works reliably on a normal home Wi-Fi network and continues to work when Tailscale is enabled on the devices.
- No account creation or external service is required at any point.

---

**End of Product Specification**
