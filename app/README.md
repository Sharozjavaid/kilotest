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
npm run e2e                       # everything: database, server, web export, seven flows
E2E_ONLY=upload,review npm run e2e
E2E_SKIP_BUILD=1 npm run e2e      # reuse the last web export
```

`e2e/run.mjs` starts PostgreSQL (`../server/scripts/dev-db.sh`), a fresh `kilo_e2e`
database, the server in dev mode with the real pipeline (fixture transcriber, heuristic
decider, local storage, dev auth, 120 s signed links), exports the app for web without mock
mode, serves it, and drives it with Playwright at 390x844 through `e2e/flows/`: upload,
review, broll, export, recorder (Chromium's fake camera), styles (with the weekly goal) and
failures. Later flows use what the upload flow made. Logs, downloads and server output go
to `.work/e2e/`; screenshots of every main screen with real data to `.work/shots-real/`.

## Behaviour worth knowing

- **Uploads** (`src/uploads/`): the queue is stored per signed-in account and cleared on
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
- **Mock** (`src/api/mock/`): follows the server's rules; `src/api/conformance/scenarios.ts`
  runs the same scenarios against the mock (jest) and the server
  (`server/test/conformance.test.ts`).

## Device builds

The recorder uses `react-native-vision-camera` (v5, Nitro modules), which is native code: the app needs a development build, not Expo Go. `ios/` and `android/` are generated from `app.json`; do not edit them by hand.

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
| `preview` | Release build for testers, internal distribution, update channel `preview` | EAS env `preview` |
| `production` | Store build, build number auto-incremented, channel `production` | EAS env `production` |

Set `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` per EAS environment. Push notifications need the EAS project id (from `eas init`) and, for iOS, push credentials (`eas credentials`).

Permissions (camera, microphone, photo library, notifications) are declared in `app.json`. Without a device it is not possible to check: vision-camera capture, the 1080p/60 fps format selection and the 30 fps fallback, permission denial and the Settings link, background uploads of recorded takes, and push.

## Layout

```
src/app/          routes (expo-router)
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
