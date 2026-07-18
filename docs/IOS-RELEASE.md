# iOS release runbook

How the Houzs ERP iOS app gets built, signed and distributed, from a Windows
machine with no Mac.

Everything Xcode-shaped happens on a GitHub macOS runner
(`.github/workflows/ios-build.yml`). You never need macOS. You do need an
Apple Developer account, and the parts that involve your identity - creating
the account, choosing passwords, generating and holding the signing key
material - are yours to do. Claude will not create the Apple account, will not
set or hold any password, and will not handle certificate or key files. Paste
secret values only into GitHub's secret UI. Never into chat, never into a file
in this repo.

---

## What already works, today, with no Apple account

The workflow runs green with zero secrets configured. It produces an
**unsigned** `.ipa`. That build cannot be installed on a phone - it exists to
prove the app compiles and the pipeline is sound before you pay Apple.

1. GitHub > **Actions** tab > **iOS build** in the left sidebar.
2. **Run workflow** > pick the branch (`feat/ios-app`) > **Run workflow**.
3. Wait roughly 10-20 minutes.
4. Open the finished run > scroll to **Artifacts** > download
   `ios-build-<number>`. Inside: `HouzsERP-unsigned-<number>.ipa` and the raw
   `xcodebuild` logs.

The run summary states plainly whether the build was signed or unsigned, and
which secrets were missing.

### Why there is no `ios/` folder in the repo

The native Xcode project is generated on the runner by `npx cap add ios` on
every build. That command runs `pod install`, which cannot run on Windows, so
a committed project could only ever have come from a Mac nobody has.
Generating it keeps the build reproducible from the web sources alone.

Because of that, no Info.plist change is ever made by hand. Camera, photo
library, microphone and location usage strings, plus the
`remote-notification` background mode, are applied on every build by
`.github/scripts/ios-prepare.sh`. If you need a new permission string, edit
that script - not Xcode.

If someone with a Mac later commits `frontend/ios/`, the workflow detects it
and syncs the committed project instead of regenerating. No workflow edit
needed.

---

## Step 1 - Apple Developer Program account

You do this yourself, at <https://developer.apple.com/programs/enroll/>.

- Enrol as the **organisation** (Houzs Century), not as an individual.
  Organisation enrolment is what later unlocks Apple Business Manager and
  custom app distribution. Individual enrolment does not.
- Organisation enrolment requires a **D-U-N-S number** for the company. Apple
  has a free lookup and request form during enrolment. Allow days, sometimes
  a couple of weeks, for Apple to verify. Start this first - it is the long
  pole.
- Cost: USD 99 per year.

Once enrolled, go to <https://developer.apple.com/account> > **Membership
details**. Copy the **Team ID** - ten characters, like `A1B2C3D4E5`.

> Secret 1 of 7: `APPLE_TEAM_ID` = that ten-character Team ID.

---

## Step 2 - Register the App ID

<https://developer.apple.com/account> > **Certificates, Identifiers &
Profiles** > **Identifiers** > the blue **+**.

1. Select **App IDs** > Continue > **App** > Continue.
2. Description: `Houzs ERP`.
3. Bundle ID: select **Explicit** and enter exactly
   **`com.houzscentury.erp`**. This must match `appId` in
   `frontend/capacitor.config.ts` character for character, or signing fails.
4. Under **Capabilities**, tick **Push Notifications**.
5. Continue > Register.

---

## Step 3 - Distribution certificate, made on Windows

A distribution certificate normally comes from Keychain Access on a Mac. The
equivalent on Windows is OpenSSL. Git for Windows ships it, so run these in
Git Bash. Do this in a folder **outside this repo** - `.gitignore` already
blocks `*.key` and `*.pem`, but do not rely on that.

```bash
# 1. Private key. This file is the crown jewel. Back it up somewhere safe
#    and offline. If you lose it you must revoke and start this step over.
openssl genrsa -out ios_distribution.key 2048

# 2. Certificate signing request. Use your own email and country code.
openssl req -new -key ios_distribution.key -out ios_distribution.csr \
  -subj "/emailAddress=YOUR_EMAIL/CN=Houzs Century Distribution/C=MY"
```

Then in the portal: **Certificates** > **+** > **Apple Distribution** >
Continue > upload `ios_distribution.csr` > Continue > **Download**. You get
`distribution.cer`.

Convert Apple's certificate plus your private key into the `.p12` bundle the
build needs:

```bash
# 3. Apple hands back DER; OpenSSL wants PEM.
openssl x509 -inform DER -in distribution.cer -out distribution.pem

# 4. Bundle certificate + private key. You will be asked to invent an export
#    password - choose one, and remember it, it becomes a secret below.
openssl pkcs12 -export -legacy \
  -in distribution.pem -inkey ios_distribution.key \
  -out distribution.p12 -name "Apple Distribution"
```

If `-legacy` is rejected by your OpenSSL version, drop the flag and retry.

Now base64 the `.p12` so it can live in a GitHub secret. In PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("distribution.p12")) | Set-Clipboard
```

> Secret 2 of 7: `IOS_DIST_CERT_P12_BASE64` = paste the clipboard.
> Secret 3 of 7: `IOS_DIST_CERT_PASSWORD` = the export password you invented in step 4.

---

## Step 4 - Provisioning profile

Portal > **Profiles** > **+**.

1. Under **Distribution**, choose **App Store Connect**. (Choose **Ad Hoc**
   instead only if you want to sideload onto a fixed list of registered
   devices without TestFlight - it requires registering each device's UDID
   first, which is more work than TestFlight.)
2. App ID: **Houzs ERP - com.houzscentury.erp** > Continue.
3. Certificate: the **Apple Distribution** certificate from step 3 > Continue.
4. Profile name: `Houzs ERP App Store` > Generate > **Download**. You get a
   `.mobileprovision` file.

Base64 it the same way:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("Houzs_ERP_App_Store.mobileprovision")) | Set-Clipboard
```

> Secret 4 of 7: `IOS_PROVISIONING_PROFILE_BASE64` = paste the clipboard.

The workflow reads the profile's name and UUID out of the file itself, so
there is no fifth secret for those.

**Whenever you renew the certificate or the profile (both expire - the
certificate after 1 year, the profile after 1 year), redo the base64 and
update these two secrets.** An expired profile is the most common cause of a
build that used to work suddenly failing to sign.

---

## Step 5 - App Store Connect API key (only needed for TestFlight upload)

<https://appstoreconnect.apple.com> > **Users and Access** > **Integrations**
tab > **App Store Connect API** > **Team Keys** > the **+**.

1. Name: `GitHub Actions`. Access: **App Manager**.
2. Generate. The page now shows **Issuer ID** (a long UUID, at the top of the
   list) and your new key's **Key ID** (ten characters).
3. **Download API Key** - a file named `AuthKey_XXXXXXXXXX.p8`. Apple lets you
   download it exactly once. Save it somewhere safe immediately.

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXXXXXXXX.p8")) | Set-Clipboard
```

> Secret 5 of 7: `ASC_KEY_ID` = the ten-character Key ID.
> Secret 6 of 7: `ASC_ISSUER_ID` = the Issuer ID UUID.
> Secret 7 of 7: `ASC_API_KEY_P8_BASE64` = paste the clipboard.

---

## Step 6 - Put the secrets into GitHub

Repo > **Settings** > **Secrets and variables** > **Actions** > **New
repository secret**, once per row.

| Secret name | Value comes from |
| --- | --- |
| `APPLE_TEAM_ID` | Step 1 - Membership details, Team ID |
| `IOS_DIST_CERT_P12_BASE64` | Step 3 - base64 of `distribution.p12` |
| `IOS_DIST_CERT_PASSWORD` | Step 3 - the export password you invented |
| `IOS_PROVISIONING_PROFILE_BASE64` | Step 4 - base64 of the `.mobileprovision` |
| `ASC_KEY_ID` | Step 5 - Key ID |
| `ASC_ISSUER_ID` | Step 5 - Issuer ID |
| `ASC_API_KEY_P8_BASE64` | Step 5 - base64 of `AuthKey_*.p8` |

The first four switch the build from unsigned to signed. The last three are
needed only if you tick the TestFlight upload box. Secrets are write-only in
GitHub's UI - once saved, nobody, including you, can read them back, only
overwrite them. That is by design.

---

## Step 7 - Create the app record in App Store Connect

Needed before any upload will be accepted.

<https://appstoreconnect.apple.com> > **Apps** > **+** > **New App**.

- Platform: iOS. Name: `Houzs ERP`. Primary language: English.
- Bundle ID: pick **com.houzscentury.erp** from the dropdown (it appears
  because of step 2).
- SKU: anything internal and unique, e.g. `houzs-erp-ios`.
- User access: Full Access.

---

## Step 8 - Run a signed build

Actions > **iOS build** > **Run workflow**:

- **Export method**: `app-store-connect` for TestFlight. `ad-hoc` for direct
  device install. `development` for debug builds on registered devices.
- **Upload to TestFlight**: tick it once you are ready to put the build in
  front of staff.
- **Force unsigned**: leave off. It exists to reproduce the pre-Apple build
  path if signing ever misbehaves and you need to isolate whether the app
  itself still compiles.

The build number is the GitHub run number, so it always increases - App Store
Connect rejects a re-used build number.

The signed `.ipa` lands in the run's **Artifacts** as before. If the
TestFlight box was ticked, it is also uploaded; Apple then takes 5-30 minutes
to process it before it appears in TestFlight.

---

## Distribution path

### Now: TestFlight

App Store Connect > your app > **TestFlight**.

- **Internal Testing**: add staff by Apple ID email (they must first be added
  under Users and Access). Up to 100 internal testers, no Apple review, build
  available within minutes of processing. This is how the team should get the
  app during the pilot.
- Testers install the free **TestFlight** app from the App Store and accept
  the emailed invitation.
- A TestFlight build expires after 90 days. Ship a new build before then, or
  the app stops opening.
- **External Testing** (up to 10,000 testers) does require a review pass, and
  is unnecessary if everyone is on the payroll.

### Later: Apple Business Manager custom app

The right long-term home for an internal ERP. It is not a public App Store
listing and it never appears in search - Apple reviews it, then it is
available only to your organisation.

1. Enrol the company in Apple Business Manager at
   <https://business.apple.com> (again needs the D-U-N-S number). Note the
   **Organisation ID** from ABM > Preferences > Enrollment Information.
2. In App Store Connect > your app > **Pricing and Availability**, set
   distribution to **Custom App** and add that Organisation ID.
3. Submit the build for review as normal. Custom app review is lighter than
   public review, but it is still a review - the app must not crash on launch
   and the login screen must be usable by the reviewer, so give them a working
   test account in the review notes.
4. Once approved, the app appears in ABM > **Apps and Books**. Buy licences
   (free ones for a free app) and assign them to staff Apple IDs or to
   devices.

The alternative, the Apple Developer Enterprise Program, is a different USD
299/year membership with a strict 100+ employee bar and no App Review at all.
Do not plan around it unless Apple has already approved you for it.

---

## What Claude does and does not do

Does: writes and maintains the workflow, the plist patch script and this
document; reads build logs and diagnoses failures; changes the app's code.

Does not: create the Apple Developer or App Store Connect account; choose or
enter any password; generate, hold, read or transmit the private key, the
`.p12`, the provisioning profile or the `.p8`; type any secret value anywhere.
Those are yours end to end. If a secret value ever appears in chat or in a
file in this repo, treat it as compromised - revoke it in Apple's portal and
issue a new one.

---

## Troubleshooting

**Build is green but the summary says UNSIGNED.** One of the four signing
secrets is empty. The summary names which.

**`No signing certificate "Apple Distribution" found`.** The `.p12` does not
contain the private key. Redo step 3 part 4 - `-inkey ios_distribution.key`
is the part that matters.

**`Provisioning profile ... doesn't match the bundle identifier`.** The App ID
in step 2 is not exactly `com.houzscentury.erp`.

**`The provisioning profile is expired`.** Regenerate in step 4 and update
`IOS_PROVISIONING_PROFILE_BASE64`.

**TestFlight rejects the upload with a duplicate build number.** Re-run the
workflow; the run number will have advanced.

**Push notifications never arrive.** Signing and the `remote-notification`
background mode only cover the client half. The server still needs an APNs
authentication key (portal > Keys > **+** > Apple Push Notifications service)
wired into the backend. That is separate work, not part of this pipeline.
