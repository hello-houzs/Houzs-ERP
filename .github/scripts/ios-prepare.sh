#!/usr/bin/env bash
#
# Apply every Info.plist key and entitlement the Houzs ERP iOS shell needs.
#
# The ios/ native project is NOT committed - it is generated on the macOS
# runner by `npx cap add ios` (the owner develops on Windows, where that
# command cannot run because it shells out to pod install). So nothing here may
# assume a hand-edited project: each key is deleted and re-added, which makes
# the script idempotent and gives the same result whether it runs against a
# freshly generated project or one someone later commits from a Mac.
#
# Usage: bash .github/scripts/ios-prepare.sh <path to ios/App> [aps-environment]
#   e.g. bash .github/scripts/ios-prepare.sh frontend/ios/App production
#
set -euo pipefail

APP_ROOT=${1:?usage: ios-prepare.sh <path to ios/App> [aps-environment]}
APS_ENV=${2:-production}

PLIST="$APP_ROOT/App/Info.plist"
ENTITLEMENTS="$APP_ROOT/App/App.entitlements"
PB=/usr/libexec/PlistBuddy

if [ ! -f "$PLIST" ]; then
  echo "ios-prepare: Info.plist not found at $PLIST" >&2
  echo "ios-prepare: did 'npx cap add ios' run and succeed?" >&2
  exit 1
fi

put_string() {
  "$PB" -c "Delete :$1" "$PLIST" >/dev/null 2>&1 || true
  "$PB" -c "Add :$1 string $2" "$PLIST"
}

put_bool() {
  "$PB" -c "Delete :$1" "$PLIST" >/dev/null 2>&1 || true
  "$PB" -c "Add :$1 bool $2" "$PLIST"
}

# --- Privacy usage strings ------------------------------------------------
# iOS kills the app on first use of a capability whose usage string is
# missing, and App Review rejects the binary outright. Each string below maps
# to a real surface in the app (see the grep trail in src/mobile), not to a
# capability we might one day want.

# MobileScan / MobileNewSO order-slip capture and MobilePOD proof-of-delivery
# both use <input type="file" capture="environment">, which opens the camera.
put_string NSCameraUsageDescription \
  "Houzs ERP uses the camera to photograph order slips for scanning and to capture proof-of-delivery photos."

# The same inputs without capture, plus attachment pickers in Announcements,
# PMS and service cases, read from the photo library.
put_string NSPhotoLibraryUsageDescription \
  "Houzs ERP lets you attach photos from your library to orders, service cases and delivery records."

put_string NSPhotoLibraryAddUsageDescription \
  "Houzs ERP saves exported documents and delivery photos to your photo library."

# Attachment inputs that accept video/* offer Record Video, which needs the
# microphone even though the app never records audio on its own.
put_string NSMicrophoneUsageDescription \
  "Houzs ERP records audio only when you attach a video to an order or service case."

# MobilePOD calls navigator.geolocation.getCurrentPosition when a driver
# confirms a delivery, so the POD record carries the drop-off point.
put_string NSLocationWhenInUseUsageDescription \
  "Houzs ERP records your location when you confirm a delivery, so the proof of delivery carries the drop-off point."

# --- Background modes -----------------------------------------------------
# @capacitor/push-notifications needs remote-notification to be woken by APNs
# while backgrounded.
"$PB" -c "Delete :UIBackgroundModes" "$PLIST" >/dev/null 2>&1 || true
"$PB" -c "Add :UIBackgroundModes array" "$PLIST"
"$PB" -c "Add :UIBackgroundModes:0 string remote-notification" "$PLIST"

# --- Export compliance ----------------------------------------------------
# The app uses only HTTPS, which is exempt. Declaring it here stops App Store
# Connect from asking the owner the same encryption question on every single
# TestFlight build.
put_bool ITSAppUsesNonExemptEncryption false

# --- Entitlements ---------------------------------------------------------
# Written unconditionally so the file exists, but only wired into the build
# (via CODE_SIGN_ENTITLEMENTS) on the signed path - an unsigned build has no
# provisioning profile to satisfy aps-environment.
cat > "$ENTITLEMENTS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>${APS_ENV}</string>
</dict>
</plist>
PLIST

echo "ios-prepare: patched $PLIST"
"$PB" -c "Print" "$PLIST"
echo "ios-prepare: wrote $ENTITLEMENTS (aps-environment=${APS_ENV})"
