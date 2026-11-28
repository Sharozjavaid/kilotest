# kilo app

The Expo (React Native) app: Home, New batch, Batch, Review, Export, Record with script, B-roll, Styles, You and Weekly goal. Contracts live in `../packages/edl` (built to `dist/`); the API is `docs/CONTRACTS.md` section 5.

```sh
npm install
npm run typecheck
npm test
```

## Run in mock mode (no server)

`EXPO_PUBLIC_MOCK=1` swaps the API for an in-memory mock of every route with the server's status machine on timers, seeded with a returning creator's account (add `?fresh=1` to the web URL for a first-time user).

```sh
npm run start:mock                 # web, in the browser
EXPO_PUBLIC_MOCK=1 npx expo start  # a dev build on a device or simulator
npm run export:web                 # static mock build in .work/web (add EXPO_OFFLINE=1 without network)
```

On web the recorder uses the browser camera (`getUserMedia` + `MediaRecorder`). Takes are kept in memory there, so a page reload keeps the script and progress but not the takes.

## Run against a local server

Start the server (`../server`, `KILO_AUTH=dev`, local storage), then:

```sh
EXPO_PUBLIC_API_URL=http://<your computer's LAN IP>:8787 npx expo start --dev-client
```

With no `EXPO_PUBLIC_SUPABASE_URL` the app signs in with dev auth (`dev:<user id>` tokens). For Supabase auth set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`. A phone must reach the server over the LAN, so use the computer's IP, not `localhost`.

## End-to-end against the real server

```sh
npm run e2e                       # everything: database, server, web export, eight flows
E2E_ONLY=upload,review npm run e2e
E2E_SKIP_BUILD=1 npm run e2e      # reuse the last web export
npm run e2e:batch30               # the 30-video run (opt-in, 30 to 60 minutes; E2E_ONLY=batch30)
```

`e2e/run.mjs` starts PostgreSQL (`../server/scripts/dev-db.sh`), a fresh `kilo_e2e`
database, the server in dev mode with the real pipeline (fixture transcriber, heuristic
decider, local storage, dev auth, 120 s signed links), exports the app for web without mock
mode, serves it, and drives it with Playwright at 390x844 through `e2e/flows/`: upload,
review, versions (history, compare and restore), broll, export, recorder (Chromium's fake
camera), styles (with the weekly goal) and failures. Later flows use what the upload flow made. Logs, downloads and server output go
to `.work/e2e/`; screenshots of every main screen with real data to `.work/shots-real/`.

### The 30-video run

`npm run e2e:batch30` is PLAN.md's phase 1 test as far as a browser takes it. It needs the
recordings first: `node ../fixtures/make-batch30.mjs --generate` (specs in
`fixtures/specs/batch30/`, output in `fixtures/out/batch30/`, about two minutes). As one fresh
creator, through the UI only, `e2e/flows/batch30.mjs`:

- picks the 72 clips (in two picks, as the device picker takes 60 at a time), merges the
  multi-clip recordings in the batch editor, names them, adds B-roll to nine, sets the batch to
  General with three hooks and gives videos their own kind of video and hooks in the editor, so
  the one batch mixes General, UGC ad and TikTok Shop with one, two and three openings, and starts
  one batch of 30;
- watches the Batch and Home screens until all 30 are ready (upload and analysis progress, the
  header count, nothing failed or stuck for ten minutes), with uploads one video at a time, the
  connection cut for eight seconds mid-upload (uploads pause, no finished file is sent again),
  Home not polled while the Batch screen is in front, and Home's ready list in batch order;
- reviews every video: rows against the EDL, the automatic edit against the fixture's ground
  truth (`manifest.json`), fixes every wrong line by tapping its row, makes a deliberate edit on
  ten (cuts a kept line or restores a cut take), turns captions on for five, Looks good, Next video;
- waits for every final render (the batch stays on Home while it exports), downloads every
  version from each Export screen reached through All videos (Finished, search by title), and
  checks each file: 1080x1920, the EDL's frame rate, duration within two
  frames of the saved edit, -14 LUFS within 1.5, and every frame traced through the edit to the
  fixture unit it shows (no cut line; the blue kept band and orange cut band where they belong);
- ends on Home with all 30 finished and marks one as posted.

`E2E_BATCH30_MODE` picks the batch's default mode (each video's own follows the plan in the flow),
`E2E_BATCH30_COUNT=n` runs the first n recordings while working on the flow. Timings, disk, browser memory, request counts, every automatic-edit mistake and every
finding go to `.work/e2e/batch30/report.json`; the EDLs before and after review to
`.work/e2e/batch30/edls/`.

## Behaviour worth knowing

- **Uploads** (`src/uploads/`): one video's files at a time (`videosAtOnce`), so the first
  videos edit while later ones upload; a file waiting out a retry does not hold up the rest.
  A lost connection pauses the queue (running uploads stop without spending an attempt, a tus
  upload keeps its place, finished files are never sent again) and a failure with no answer
  from the server is retried with growing waits, never marked failed. Finished files of a video
  still uploading are kept across relaunches so "2 of 3 files in" stays true. The Batch screen
  says whose move it is: uploading, waiting its turn on this phone, paused offline, retrying,
  files not on this phone, or queued on the server. The queue is stored per signed-in account and cleared on
  sign-out. `uploads/complete` is read per file: a refused file is sent again on a fresh
  target (`POST /v1/uploads/targets`), then marked failed with a retry that asks for a
  fresh target; a file whose video was deleted is dropped. An upload refused as expired
  or unauthorised gets a fresh target at once. Home and Batch stop polling a video that
  is `uploading` when this phone has nothing left to send for it.
- **Saving edits** (`src/review/`): `EdlSaver.flush()` resolves false when the save
  failed; passing failures are retried by themselves. "Looks good" waits for the save
  and says so if it cannot; Export gets the revision reviewed (`?rev=`) and refuses to
  render a different one. Unsaved taps are kept per video on the device and replayed
  when the video is opened again.
- **Sign-out**: unregisters this device's push token (`DELETE /v1/devices`) and clears
  the account's uploads and unsaved edits before the session goes. A 503
  `auth_unavailable` is retried, never treated as a sign-out.
- **Polling**: only the screen in front polls (`useIsFocused`); a screen under another one also
  stops listening to the cache, so it neither polls nor refetches on invalidations until it
  is in front again. Review and Export read the batch without polling it.
- **Home and All videos**: a batch keeps its card until every video in it is done. Home lists
  ready videos newest batch first, in each batch's order, and the latest ten finished; All
  videos (`/videos`, from Home) pages through everything (`GET /v1/videos?order=batch&limit=40`)
  in a virtualised list with a status filter, title search, batch headers that open the batch,
  remembered thumbnails and no polling.
- **Review**: a variant's hidden base overlays are named on their line ("Bold title left out of
  Hook B", Show), and a shown one is hidden from its marker; the B-roll screen and the overlay
  sheet ("Shown in") and Export's tiles follow the same rules (`src/review/variantOverlays.ts`).
  Cut rows say why in plain words (`src/review/cuts.ts`), a cut retake offers Keep both, and
  "N cuts" with previous and next plays each cut with 1.5 s either side, then stops.
- **Versions** (Review's menu, `src/app/versions/`, `src/app/compare/`, `src/review/versions.ts`):
  every saved revision, newest first, with who made it. Tapping one compares it with the current
  edit: two skip players on the same proxy, the newer leading and the older following through
  `mapTime` (re-seeked only past 0.3 s of drift, held still where it cut the footage, "Cut here"
  on the player that lost it), one play and one scrub bar, and `diffEdl`'s change list. Restore
  brings a version back as a new revision; a 409 reloads and says the edit changed.
- **New batch**: each video in the editor can have its own kind of video and hooks; it follows
  the batch until changed, and only what differs is sent as `NewVideo.settings`.
- **Mock** (`src/api/mock/`): follows the server's rules; `src/api/conformance/scenarios.ts`
  runs the same scenarios against the mock (jest) and the server
  (`server/test/conformance.test.ts`).

## Device builds

The recorder uses `react-native-vision-camera` (v5, Nitro modules), which is native code: the app needs a development build, not Expo Go. `ios/` and `android/` are generated from `app.json` and `app.config.js`; do not edit them by hand.

```sh
npx eas-cli@latest login
npx eas-cli@latest init                                   # once: links the project, writes extra.eas.projectId (push needs it)
npx eas-cli@latest env:create --environment development --name EXPO_PUBLIC_API_URL --value http://<ip>:8787
npx eas-cli@latest build --profile development --platform ios        # or android; installs a dev client
npx expo start --dev-client
```

Profiles in `eas.json`:

| Profile | What | Environment |
|---|---|---|
| `development` | Dev client, internal distribution (Android APK) | EAS env `development` |
| `development-simulator` | Same, for the iOS simulator (no camera there) | EAS env `development` |
| `preview` | Release build for testers, internal distribution | EAS env `preview` |
| `production` | Store build, build number auto-incremented. Refuses to build without an `https://` `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (`app.config.js`), so it can never ship with development sign-in or the mock | EAS env `production` |

Set `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` per EAS environment. Push notifications need the EAS project id (from `eas init`) and, for iOS, push credentials (`eas credentials`).

Permissions (camera, microphone, photo library, notifications) are declared in `app.json`. Without a device it is not possible to check: vision-camera capture, the 1080p/60 fps format selection and the 30 fps fallback, permission denial and the Settings link, background uploads of recorded takes, and push.

Which path is for what:

- **EAS** (above): every iOS build, store builds (`production`), and tester builds that need push (EAS holds the project id and the push credentials). Builds on Expo's servers; needs an Expo account.
- **Local Android build** (below): a release APK built on your own Linux or macOS machine with no account, to install on an Android phone and try the recorder, uploads and export against a server you run. Push is off in it (no EAS project id), and it is signed with the debug key, so it is not for the Play Store.

## iOS build (on a Mac)

The iOS app uses the system's own chrome: the native tab bar (`expo-router/native-tabs`), native navigation bars, sheets and menus, SF Symbols, and on iOS 26 Liquid Glass (`expo-glass-effect`) with motion on the UI thread (Reanimated 4) and haptics. The minimum is **iOS 16.4** (the highest minimum among the native modules: Expo's modules, `expo-glass-effect`, `expo-symbols`, `@expo/ui` all need 16.4); Liquid Glass appears on iOS 26 and later, and iOS 16.4 to 25 get the system blur and the standard bars instead (`docs/design/ios-redesign.md` section 7). `ios/` is generated by `expo prebuild` from `app.json` and `app.config.js` and is gitignored: never edit or commit it.

### Prerequisites

| What | Version | Notes |
|---|---|---|
| macOS with Xcode | Xcode 26 (iOS 26 SDK) | Liquid Glass, the floating tab bar, the bottom accessory and glass bar buttons only exist when the app is built against the iOS 26 SDK. An older Xcode builds the app with the pre-26 look everywhere. Open Xcode once to install the iOS platform and accept the licence. |
| Command line tools | `xcode-select -p` shows Xcode 26 | `sudo xcode-select -s /Applications/Xcode.app` if not. |
| CocoaPods | 1.16 or later | `brew install cocoapods`. `expo prebuild` / `expo run:ios` run `pod install`. |
| Node, npm | Node 22 | |
| A simulator or an iPhone | iOS 26 to see glass; 16.4 or later to run | The recorder needs a real iPhone (no camera in the simulator). |

### Build and run

```sh
cd packages/edl && npm install && npm run build && cd ../../app   # the app imports @kilo/edl's dist/
npm install
npx expo prebuild -p ios                        # generates ios/ and runs pod install
npx expo run:ios                                # Debug build on a simulator (pick one with --device "iPhone 17")
npx expo run:ios --device                       # Debug build on a connected iPhone
npx expo run:ios --device --configuration Release   # Release build on the iPhone: JS bundled in, no Metro needed
```

A Debug build is a development client: it loads the JavaScript from Metro on the Mac (`npx expo start --dev-client` if it is not already running), so the phone must be on the same Wi-Fi. A Release build carries the bundle and runs on its own.

After changing `app.json`, `app.config.js` or a native dependency, run `npx expo prebuild -p ios --clean` again.

### Signing with a free Apple ID (Personal Team)

1. Xcode, Settings, Accounts: add your Apple ID. That gives a "Personal Team".
2. A Personal Team cannot sign the Push Notifications capability that `expo-notifications` adds, so prebuild without it:
   ```sh
   KILO_IOS_PERSONAL_TEAM=1 npx expo prebuild -p ios --clean
   ```
   Push is then off in that build; everything else works. (With a paid developer account leave the variable unset.)
3. `open ios/kilo.xcworkspace`, select the `kilo` target, Signing & Capabilities: tick "Automatically manage signing" and pick your Personal Team. If `app.kilo.editor` is taken for your team, change the bundle identifier in Xcode only for this local build (not in `app.json`).
4. Build once from Xcode (or `npx expo run:ios --device`). On the iPhone, the first time: Settings, Privacy & Security, Developer Mode on (restart), then Settings, General, VPN & Device Management, trust your developer certificate. Personal Team builds expire after 7 days; build again.

### Which server the app talks to

`EXPO_PUBLIC_*` values are baked into the bundle at build time: set them in the shell for both `prebuild` and `run:ios`.

- **Every screen without a server:** `EXPO_PUBLIC_MOCK=1 npx expo run:ios` (or with `--device --configuration Release`). The in-memory mock serves every route with the server's status machine on timers, seeded with a returning creator. Nothing leaves the phone; uploads and renders are simulated.
- **Against the server on your Mac:** start it as `server/README.md` says (`npm install`, `eval "export $(bash scripts/dev-db.sh)"` for a throwaway PostgreSQL, then `npm run dev`, which uses `KILO_AUTH=dev`, local storage and the offline pipeline; real analysis and rendering need `ffmpeg` on the Mac). Then build the app with `EXPO_PUBLIC_API_URL=http://<your Mac's LAN IP>:8787` (System Settings, Wi-Fi, Details). Leave `EXPO_PUBLIC_SUPABASE_URL` unset to sign in with dev auth. On the simulator `http://localhost:8787` also works. The server must listen on all interfaces, the phone must be on the same network, and iOS asks once to allow Kilo on the local network: allow it (Settings, Privacy & Security, Local Network, if you said no). Plain HTTP to a LAN IP or `.local` name is allowed by the generated App Transport Security settings (`NSAllowsLocalNetworking`); any other server must be `https://`.

### EAS instead of a local build

`npx eas-cli@latest build --profile development --platform ios` (a device dev client) or `--profile development-simulator` builds on Expo's Macs with the Xcode image EAS selects (it must be an Xcode 26 image for Liquid Glass), and handles signing and push credentials with a paid Apple developer account. See "Device builds" above for login, `eas init` and the environment variables.

### What has and has not been checked

This was built on Linux, which cannot compile iOS. Checked: TypeScript over every platform file (`.ios.tsx`, `.native.tsx`), jest, the web export and the browser end-to-end suite, and `expo prebuild -p ios` (Info.plist strings, `UIUserInterfaceStyle` Automatic, `CADisableMinimumFrameDurationOnPhone`, deployment target 16.4 in the Podfile and the Xcode project, bundle id `app.kilo.editor`, the push entitlement and its removal with `KILO_IOS_PERSONAL_TEAM=1`, and the autolinked pods: ExpoGlassEffect, ExpoBlur, ExpoSymbols, ExpoHaptics, ExpoUI, RNReanimated, RNWorklets, RNGestureHandler, VisionCamera, NitroModules, RNScreens). Not checked, because it needs a Mac: `pod install` and the Xcode compile and link; how anything looks or moves on a device (glass, the floating tab bar minimising on scroll, the uploads bottom accessory appearing and leaving, native header buttons and menus, large titles collapsing with the screen's scroll view, the SwiftUI segmented control and New menu, sheets at their detents, SF Symbols, haptics, 120 Hz); dark mode on a device; and the pre-26 fallbacks on an iOS 18 simulator.

## Android build (local, no EAS)

`android/` is generated by `expo prebuild` (Continuous Native Generation) and is gitignored: never edit or commit it. Every native setting lives in `app.json`, `app.config.js` and the config plugins, so `prebuild --clean` can always recreate it.

### Prerequisites

| What | Version | Notes |
|---|---|---|
| Node, npm | Node 22 | `npm install` in `app/` |
| JDK | 17 | `apt install openjdk-17-jdk-headless`; the React Native Gradle plugin builds with a Java 17 toolchain. Set `JAVA_HOME` to it. |
| Android command-line tools | latest from https://developer.android.com/studio#command-tools | Unzip to `$ANDROID_HOME/cmdline-tools/latest` (for example `ANDROID_HOME=/opt/android-sdk`). |
| SDK packages | `platform-tools`, `platforms;android-37.0`, `build-tools;37.0.0`, `ndk;27.1.12297006` | `sdkmanager --install ...` and accept the licences. Gradle also fetches `cmake;3.22.1` itself on the first build. |

Disk: the SDK above is 2.7 GB, the Gradle cache about 4 GB after one build, `android/` about 1 GB and the native build output under `node_modules/*/android` about 2 GB (about 10 GB in all, plus the JDK).

```sh
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=/opt/android-sdk
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
yes | sdkmanager --install "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006"
```

### Environment

`EXPO_PUBLIC_*` values are baked into the JavaScript bundle at build time and readable by anyone who has the APK, so only public values go there. Set them in the shell for both the prebuild and the Gradle build (Gradle runs the bundler):

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_API_URL` | The Kilo server the phone talks to, for example `http://192.168.1.20:8787` (your computer's LAN IP, server started with `KILO_AUTH=dev`) or an `https://` URL. Required: without it the app points at `localhost`, which on a phone is the phone itself. |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | The Supabase project URL and its anon (public) key, for email sign-in. Leave both unset to use dev sign-in (`dev:<user id>` tokens), which only a server with `KILO_AUTH=dev` accepts. Never the service-role key. |
| `EXPO_PUBLIC_MOCK` | Leave unset for a device build (`1` swaps the API for the in-memory mock). |

Android release builds refuse plain HTTP. `app.config.js` therefore allows cleartext traffic only when `EXPO_PUBLIC_API_URL` starts with `http://`; with an `https://` URL the APK keeps cleartext off. After changing the URL, run the prebuild again.

### Build

```sh
cd app
export EXPO_PUBLIC_API_URL=http://192.168.1.20:8787
npx expo prebuild --platform android --clean
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
./gradlew --stop
# APK: android/app/build/outputs/apk/release/app-release.apk
```

`-PreactNativeArchitectures=arm64-v8a` builds for 64-bit ARM only, which is every current phone; drop it to build all four ABIs (`armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`, as EAS does), which takes longer and makes a bigger APK. On a shared or small machine add `--max-workers=2` and set the Gradle heap in `~/.gradle/gradle.properties` (`org.gradle.jvmargs=-Xmx3g`) rather than in the generated project.

Measured on a 4-core Linux machine shared with other work, 2 Gradle workers: 11 min 19 s for the first build (including most dependency downloads), 7 min 52 s after `prebuild --clean` with a warm Gradle cache. The APK is 50.1 MB (21.7 MB to download, compressed), arm64-v8a only, release mode with R8, Hermes bytecode and the JavaScript bundle embedded. Biggest parts: native libraries 33 MB (React Native 7.0 MB, vision-camera 6.0 MB, Hermes 2.7 MB, Reanimated 2.1 MB), `classes.dex` 9.9 MB, fonts 6.1 MB (all 18 Inter styles are bundled because `src/ui/fonts.ts` imports from the package index; the app loads four), the JS bundle 3.9 MB.

### Install on a phone

The APK is signed with the debug key. Uninstall any other build of `app.kilo.editor` first (an EAS build has a different signature).

- **With adb**: on the phone, Settings, About phone, tap Build number seven times, then Developer options, USB debugging. Connect it by USB and run `adb install -r android/app/build/outputs/apk/release/app-release.apk` (`adb` is in `$ANDROID_HOME/platform-tools`; `adb devices` must list the phone).
- **By sending the file**: send `app-release.apk` to the phone (Drive, email, a chat app, USB file copy), open it there and allow "Install unknown apps" for the app that opened it when asked.

The phone must reach `EXPO_PUBLIC_API_URL`: same Wi-Fi as the computer for a LAN address, and the server listening on all interfaces, not only `localhost`.

## Layout

```
src/app/          routes (expo-router); each tab is a group with its own stack: (tabs)/(home), (styles), (you)
src/api/          API client, query hooks, in-memory mock (mock/)
src/ui/           design tokens and shared controls
src/recorder/     recording session (pure), draft store, camera (.native / .web)
src/broll/        overlay editing rules, template prop forms, B-roll sheet
src/styles/       saved styles: logic, hooks, chooser
src/goal/         weekly goal form logic
src/review/       review player, saver with conflict handling, captions control
src/uploads/      resumable upload queue
.work/            scratch: web export, screenshots, browser drives (gitignored)
```
