# Kilo on iOS 26: design brief

For the two engineers rebuilding the app shell and screens. It says what to build and why. Where an Expo API is named, check the exact import path in the installed SDK (58); the behaviour described is what matters.

Research: the Appllama library of top-grossing iOS apps (26 credits). Each pattern below names the app and screen it came from, and section 8 lists them all. Kilo borrows the pattern, never the look: no other app's colours, assets, icons or layouts are copied.

---

## 1. Principles

1. **Glass is the control layer; content stays content.** Liquid Glass only for things that float above content: tab bar, nav bar buttons, the floating review toolbar, the recorder controls, sheets, menus, toasts, and small controls over video. Cards, transcript rows, lists, chips and the scrub strip are content. They are never glass and they never blur. (Glass, Detail, StrengthLog all keep content flat and put glass only on floating chrome.)
2. **Kilo's identity is in the ground and the accent, not the chrome.** The sky-tint gradient (`skyTint` to `ground` at 36%), the white `surface` cards, the single blue `accent`, the `accentGloss` primary button, Inter headings and the lowercase `kilo` wordmark stay. The native glass picks up the sky tint from behind it, so Kilo's chrome looks blue-white without being painted blue.
3. **One tinted thing per screen.** The only filled accent element on a screen is its primary action (`accentGloss`). Glass is untinted, except the recorder's "Keep, next" when it is enabled.
4. **Never glass on glass.** A glass button inside a glass bar shares the bar's material (group them in one `GlassContainer`). A sheet's contents are plain.
5. **Over video, glass is small and paused.** On the player, a glass play button shows only while the video is paused. The recorder is the one exception (live camera), with at most six glass elements.
6. **Motion confirms; it never decorates.** Every animation answers a touch or a state change, settles within 300 ms, and runs on the UI thread. Haptics mark the moments that matter (a cut, a take, a finished export), not every tap.
7. **Native where the system does it better.** Tab bar, nav bars, back gestures, sheets, menus, alerts, the photo picker and the share sheet are the real UIKit components, so they get iOS 26 glass, morphs and accessibility for free. Kilo draws its own only where the product is unique: the transcript, the scrub strip, the teleprompter and the record button.

---

## 2. Stack choices (decided)

| Need | Use | Notes |
|---|---|---|
| Tab bar | Expo Router native tabs (`NativeTabs`, a real `UITabBarController`) | iOS 26 glass, minimise on scroll, bottom accessory. Replaces `KiloTabBar` on iOS and Android; `KiloTabBar` stays as the web fallback. |
| Headers | Native stack header (react-native-screens) on every pushed screen | `headerTransparent: true`, `headerLargeTitle` only on Styles and You. iOS 26 draws glass bar buttons and the scroll-edge effect itself. Delete the in-content `Header` on iOS. |
| Glass surfaces Kilo draws | `expo-glass-effect` (`GlassView`, `GlassContainer`, `isLiquidGlassAvailable()`) | Behind one Kilo component, `<Glass>`, which also owns the fallbacks (section 7). |
| Fallback blur | `expo-blur` | iOS 18 and earlier, and web. |
| Segmented control, menus | `@expo/ui` SwiftUI `Picker` (segmented) and `ContextMenu` on iOS | Kilo's own `SegmentedControl` on Android and web. |
| Sheets | Router `presentation: 'formSheet'` with `sheetAllowedDetents`, `sheetGrabberVisible: true` | Replaces every `Modal transparent` sheet in the app. |
| Motion | `react-native-reanimated` 4 + `react-native-worklets`, `react-native-gesture-handler` | Every custom animation. |
| Haptics | `expo-haptics` | Map in section 6. |
| Icons | `expo-symbols` (SF Symbols) in native chrome on iOS; Kilo's 2px line `Icon` everywhere else | One `IconName` maps to both. |
| Long lists | `@shopify/flash-list` v2 | The transcript (up to 4000 rows) and All videos. |
| 120 Hz | `CADisableMinimumFrameDurationOnPhone: true` in `ios.infoPlist` | Without it ProMotion phones cap custom animations at 60 fps. |

New dependencies need the owner's approval (section 9).

---

## 3. Navigation shell

### Tabs

Three tabs on a native iOS 26 floating glass tab bar, with labels. Selected tint `accent`; unselected is the system's own.

| Tab | Route | SF Symbol (unselected / selected) | Root header |
|---|---|---|---|
| Videos | `(tabs)/index` | `film.stack` / `film.stack.fill` | Wordmark header (below) |
| Styles | `(tabs)/styles` | `slider.horizontal.3` (same; the system tints it) | Large title "Styles" |
| You | `(tabs)/you` | `person.crop.circle` / `person.crop.circle.fill` | Large title "You" |

- **Minimise on scroll:** `minimizeBehavior: onScrollDown` on all three tabs. The bar shrinks to the selected tab while the list scrolls down and comes back on scroll up (system behaviour).
- **Bottom accessory (uploads):** while the phone is sending files, a native bottom accessory sits above the tab bar: a 20pt progress ring, "Uploading 12 of 30", and the percentage. Tap opens that batch. It goes away when uploads finish. When the tab bar minimises, it collapses inline beside it (system behaviour). This is phone-side work, so it belongs on every tab. Server-side editing progress stays on Home's batch cards. (Pattern: the system "mini player" accessory. The library shows floating tab bars with a separate control: corner "Home", StrengthLog "Squat Strength Distribution".)

### The primary action: New

- **Where:** a glass `plus` button at the trailing edge of the Videos header, grouped in one glass capsule with an "All videos" button (`rectangle.stack`). The two big tiles on Home stay as well (approved mock-up), but they scroll away, and the header button does not.
- **What it does:** a native glass menu that morphs out of the button (iOS 26 menu presentation): **Upload clips** (`photo.on.rectangle.angled`) and **Record with script** (`video`). (Pattern: Detail "Import Media Sheet": the + button morphs into a glass menu of import sources. Captions "Mode Menu Open": a menu of modes with one-line subtitles.) Each item has a subtitle: "Kilo cuts them for you" / "Read a script, one line at a time".
- **Upload clips** opens the system photo picker straight away (multi-select, videos only). Only after the picker returns does the New batch sheet open, already holding the clips. No empty step, and no custom grid. (CapCut "Stock Media Library" shows the cost of a custom picker: a selected-clip tray and counters. The system picker already does that.)

### Header style per screen

| Screen | Header | Leading | Trailing | Scrolls under |
|---|---|---|---|---|
| Videos (Home) | Transparent, no title; wordmark `kilo` 28pt in the content's first row | none | Glass capsule: All videos, New (+) | Content scrolls under the transparent bar with the system scroll-edge fade |
| Styles, You | Large title (Inter 600 34) collapsing to inline (Inter 600 17) | none | Styles: glass `plus` (new style) | Same |
| All videos | Inline "All videos", native search field (`headerSearchBarOptions`) | glass back | none | List |
| Batch | Inline "Batch of 30", subtitle "12 done" | glass back | none | List |
| Review | Inline: title (video title, truncated) and subtitle "3 of 30" | glass back | glass `ellipsis` menu | Transcript only; the player block is pinned |
| Export | Inline "Ready to post" | glass back | none | Content |
| B-roll | Sheet header: "B-roll" | glass `xmark` | Done (text) | Content |
| Style edit | Inline "Edit style" / sheet "New style" | back / `xmark` | Save (text, accent) | Content |
| Goal | Sheet header: "Weekly goal" | none | glass `xmark` | Content |
| Record script | Inline "Record with script" | glass `xmark` | none | Content |
| Recorder | No header: dark, own glass controls | | | |
| Ready to edit (record finish) | Inline "Ready to edit" | glass back ("Back to recording") | none | Content |
| Welcome | None | | | |

Every nav-bar button is a native bar button item, so iOS 26 draws the glass. Never put a `GlassView` in a native header.

### Sheets versus pushed screens

| Flow | Presentation |
|---|---|
| Home to Review, Batch, All videos, Export | Push |
| Review to Export ("Looks good") | Push |
| Review to B-roll | Page sheet (large detent only), so the creator lands back on the same line |
| Review: captions chip | Form sheet, medium detent |
| Review: preview with effects | Full-screen modal player, fade |
| New (+) to New batch | Page sheet after the photo picker; swipe-to-dismiss asks "Discard these clips?" only when clips are selected |
| New (+) to Record with script | Full-screen modal **group** with its own stack: `record/index` (light), then push `record/camera` (dark, no swipe back), then push `record/finish` (light) |
| Goal card, You to Weekly goal | Form sheet, detents medium and large |
| Styles to edit style | Push; "New style" is a page sheet |
| Recorder: Aa (script settings), Lines | Form sheet, medium; Lines also has large; dark appearance |
| Delete video, delete style, discard | Native action sheet (`Alert` with destructive style) |
| Paywall (later) | Page sheet, large |

---

## 4. Screen by screen

Common to every screen: `Screen` keeps the sky-tint gradient ground (light) or the dark ground (dark), 20pt side gutter, and a 16pt gap between blocks. Loading uses skeletons shaped like the real content, never a centred spinner, except where noted. Errors use `ErrorState` inline with a Try again secondary button. The offline banner becomes a toast (section 5).

### 4.1 Welcome (`welcome.tsx`)

- **Layout:** the full-bleed sky gradient. Centred wordmark `kilo` at 44pt, with "AI video editor" (15, muted) under it at 38% of the height. A glass panel is docked to the bottom (radius 32, inset 12 from the edges and from the home indicator) holding the email field, then the code field, and the primary "Send me a code" / "Sign in".
- **Glass:** the bottom panel only. The field is content inside it: white 0.9 fill, radius 14, 52 high.
- **States:** sending shows the button's loading state. A wrong code shakes the field (translateX 0, -6, 6, -3, 0 over 240 ms), plays the `error` haptic, and shows a one-line message in `cut`.
- **Motion:** on launch the wordmark rises 12pt and fades in (`appear`, 320 ms). The panel slides up 40pt after a 120 ms delay (`sheetIn` spring). Email to code cross-fades the fields (`appear`). (Pattern: Captions "Sign In": the brand settles, then the sign-in sheet rises over the gradient.)

### 4.2 Videos, the Home tab (`(tabs)/index.tsx`)

- **Layout, top to bottom:** wordmark row (wordmark 28, "AI video editor" 13 muted, baseline-aligned); goal card; the two creation tiles (Upload clips: gloss; Record with script: content card), 96 high, radius 20; active batch cards; "Ready to review" section; "Finished" section; "All videos" link. The bottom inset clears the tab bar plus 24.
- **Glass:** header capsule (All videos, New); tab bar; upload accessory. Everything else is content.
- **Components:** `GoalCard` (content card: `StepBar` and a streak label); `BatchCard` (content card: title, "12 done", progress bar 6, status line); `VideoRow` (section 5); section labels 13/600 muted, sentence case.
- **Empty (first run):** below the tiles, an empty state: a `film.stack` glyph 28 in a 64 `skyTint` circle; "Your first video starts here"; one line of body; no second button (the tiles are right there).
- **Loading:** a goal-card skeleton and three row skeletons. Tiles render at once (they need no data).
- **Error:** inline `ErrorState` under the tiles. Tiles stay usable.
- **Motion:** first load staggers sections in (`appear`, 35 ms stagger, first 8 items). Pull to refresh uses the native refresh control tinted `accent`. A video moving from "editing" to "Ready to review" uses `listInsert` in its new section, and a light toast reads "Morning routine is ready to review". Batch progress uses `progress`. Tiles and cards use `press`.

### 4.3 All videos (`videos.tsx`)

- **Layout:** native search in the nav bar. Under it, one horizontal row of filter chips: All, To review, Editing, Finished, Failed (content chips, not glass). Then a FlashList of `VideoRow`s with fixed 76pt height.
- **States:** empty filter: "No videos to review" plus a text button "Show all". Empty search: "No videos called 'unbox'". Loading: 8 row skeletons. Error: inline. End of list: nothing (no "end" label). Next page: one skeleton row.
- **Motion:** chip change uses `select` (chip fill) and cross-fades the list (150 ms). No stagger on filter changes. Rows use `press`.

### 4.4 New batch (`new-batch.tsx`, page sheet)

- **Layout:** sheet header "New batch" with "30 videos" subtitle. A horizontal strip of picked clips as 9:16 thumbs, 64 wide, radius 10; tapping one opens the per-video editor (existing `VideosEditor`). Then a "Style" row (current style name, chevron, opens a native menu of saved styles). A "Kind of video" segmented control (General, UGC ad, TikTok Shop). A grouped settings card of toggles (as Style edit). A "B-roll" drop card (dashed `dropBorder`, "Add clips"). A pinned footer with the primary "Edit 30 videos".
- **Glass:** the sheet (native), and the footer: a glass bar under the primary button so the toggles scroll beneath it.
- **States:** uploading starts on submit. The sheet closes at once and Home shows the batch card with `listInsert`. No blocking spinner. On failure to create, the sheet stays, the error goes under the button, and the `error` haptic plays.
- **Motion:** clip strip insertion `listInsert`; toggles native; submit success `success` haptic only (no animation in the closing sheet). (Pattern: Captions "New Video Options": clip summary, then a segmented mode switch, then option rows, then one CTA at the bottom. Detail "Talking Head Auto Edit": a sheet of toggle rows with a segmented control on top.)

### 4.5 Batch (`batch/[id].tsx`)

- **Layout:** upload summary card (content) with progress bar. Then one row per video: thumb 44x78, title, status line, and on the right a **progress ring** (28, stroke 3) while uploading or editing; "Review" chip when ready; `exclamationmark.triangle.fill` in `cut` when failed, with Try again as a 44 secondary button under the row text. Footer: primary "Review the first one" in the glass footer bar once any video is ready.
- **Processing visual:** the thumb shows the clip's first frame with a 30% white veil while editing. The ring sits on the right, not over the thumb. (Captions "AI Editing Progress" traces progress around the preview's border. Kilo uses the plain ring, because 30 traced borders in a list would be noise.)
- **Motion:** rings use `progress`. A video becoming ready swaps ring to chip with a 150 ms cross-fade plus a 0.9-to-1 scale on the chip (`select` spring), and a `selection` haptic only if it is the first ready video of the batch. The footer button appears with `appear` from 12pt below.

### 4.6 Review (`review/[id].tsx`): the product

**Layout (pinned top block, scrolling transcript, floating toolbar):**

```
[glass back]  Morning routine          [glass ...]
              3 of 30
[ Hook A | Hook B | Hook C ]                (only with 2+ versions)
+--------+  Final length
| player |  0:51            (display 40/700, tabular)
| 120x213|  from 2:40 recorded
|  (>)   |  [sparkles] Preview with effects
+--------+  [] Kept   [] Cut (6)
====== scrub strip (kept blocks, cut blocks, playhead) ======
[ Captions off ]  [ B-roll 2 ]                 Saving... / Saved
---------------------------------------------- transcript ---
| Okay, I've used this every morning...  0:07 |   kept row
  Okay so I've been, uh, hold on.         0:03     cut row
  False start                     Put back      cut reason
...
        +--------------------------------------+
        | [<  6 cuts  >]       [ Looks good ]  |  floating glass toolbar
        +--------------------------------------+
```

- **Pinned block (content, no glass):**
  - **Hook switcher:** native segmented control (iOS 26 capsule, 32 high, full width), labels from `variant.label`. Switching restarts playback at 0. Hidden with one version.
  - **Player:** 120x213 (9:16), radius 16, `shadow.player`, `color.player` behind. Paused: glass play button 48 circle (clear glass, `play.fill` 18 white) centred. Playing: nothing over the frame. Playing a cut: a capsule at the bottom, `cut` at 90%, white "Playing a cut" 12/600. Tap the player to toggle play. Long-press opens the full-screen preview (fade-in modal).
  - **Stats column:** "Final length" 13 muted; value 40/700, tracking -1.5, `fontVariant: tabular-nums`; "from 2:40 recorded" 13 muted; "Preview with effects" link 13/600 accent with `sparkles` (a thin progress bar 3 under it while rendering); legend swatches 12x12 radius 3.
  - **Scrub strip:** unchanged geometry. Kept blocks solid `accent`, cut blocks white with a `cut` outline, overlay dots, playhead 2pt `ink` with a 10pt knob. Drag scrubs. The knob grows to 14 while dragging (`select` spring).
  - **Tools row:** captions chip ("Captions off" / "Captions: Bold"; opens a form sheet with the burn-in toggle and three styles) and a B-roll chip ("B-roll 2", opens the B-roll page sheet). Save state at the trailing edge, 12 muted: "Saving..." then "Saved", fading out after 1.5 s. Save failure: "Couldn't save. Tap to retry" in `cut`.
- **Transcript (content, FlashList):**
  - **Kept row:** `surface` card, radius 14, padding 12/14, 3pt `accent` bar on the left edge (inside the radius), text 15/21 Inter 400 `ink`, time 12 muted tabular at top-right (tap seeks). Overlay marker at the bottom-right when the line carries B-roll (`photo.on.rectangle`) or a graphic (`textformat`), 14pt muted.
  - **Cut row:** white at 0.55, 1px `cut` outline, text 15/21 `muted` struck through; under it the reason 12/600 `cut` ("False start", "Retake of the next line", "Dead air 1.8 s", "Filler") and, for retakes, a "Keep both" text button 12/600 `accent`. Cut and kept differ in fill, outline and strike, not hue alone.
  - **Playing row:** kept fill becomes `accent` at 8% and the bar 4pt. Text weight does not change (no reflow).
  - **Interaction:** tap toggles cut/kept. Tap the time to seek and play. Long-press opens a native context menu with a row preview: Play this line, Cut / Put back, Keep both (retakes), Show / Hide B-roll in this version.
  - **Auto-scroll:** while playing, keep the active row 54pt below the top of the list (animated `scrollTo`), paused for 1.5 s after the creator touches the list.
- **Floating toolbar (glass):** a glass bar inset 12 from the sides, radius 28, 64 high, above the home indicator. Left: the cut stepper, a glass capsule with `chevron.left`, "6 cuts" 15/600, `chevron.right` (each half a 44pt target). Right: the primary "Looks good" `accentGloss` pill, 48 high. The transcript scrolls under the bar; its last row clears it by 16. (Pattern: Glass "Photo Detail": a floating glass bottom toolbar over scrolling content, with separate glass groups.)
- **Ellipsis menu:** Preview with effects, Edit B-roll, Redo the edit (replan), Delete video (destructive, confirms).
- **States:**
  - Loading: pinned block skeleton (player rectangle, 3 text lines, strip) plus 8 row skeletons.
  - Not ready (queued or analyzing): replace the block with a centred card: the clip's first frame at 120x213 with a **progress stroke traced around its rounded border** (`accent`, 3pt). Under it, "Editing... 64%" 17/600 and "This page updates by itself." Pattern: Captions "AI Editing Progress". This is the single place Kilo uses the traced border.
  - Failed: the same card with an `exclamationmark.triangle.fill` in `cut`, the pipeline's message, and Try again.
  - No speech: a notice card (content, `cut` icon) above the strip.
  - Save blocked on Looks good: a toast (error) plus the inline notice.
- **Motion:**
  - Tap a row: `cutToggle` (section 6). The final length rolls to the new value (numeric content transition, 240 ms). The matching strip block cross-fades fill (160 ms). Haptic: cut `impact light`, put back `impact soft`.
  - Cut stepper: scrolls to the cut, plays it with context, and flashes the row outline to `accent` for 600 ms. `selection` haptic.
  - Hook switch: `select` on the segment thumb (native). Player cross-fades 120 ms, transcript markers update without animation.
  - Looks good: `press`. While saving, the label is replaced by a spinner in place, and the button keeps its width. Then push to Export.
  - Toast after the first manual fix in a session: "Saved. You cut 1:49." (Pattern: Videoleap "No Pauses": a success tick, then a capsule toast "You saved up 6.1s" over the player.)

### 4.7 Export (`export/[id].tsx`): "Ready to post"

- **Layout:** headline 28/600 ("Ready to post", or "3 versions ready"). A horizontal pager of versions, each a 9:16 preview card 180 wide, radius 20, centred and snapping, with the hook label as a glass capsule over the top of the video (clear glass, 12/600 white) and a render progress ring centred while rendering. Page dots under it. An info card (Format, Frame rate, Captions). Then actions.
- **Actions (glass footer bar):** primary "Save to Photos" (gloss, 56, full width). Then a row of two secondary glass buttons, "Share" (`square.and.arrow.up`, system share sheet) and "More" (menu: Send to TikTok, Send to Instagram, Mark as posted). Then a text button "Next video, 4 of 30" or "Back to Home".
- **Rendering state:** the card shows the first frame with a white veil and a ring (44, stroke 3) at the centre with the percentage under it. The primary button is disabled with the label "Preparing... 64%". Never block the screen.
- **Success moment** (all versions saved): the ring closes, then the check draws, then a pop (`success` motion, `success` haptic). The button label becomes "Saved to Photos" with `checkmark` for 2 s and stays disabled for that video. Toast: "3 versions saved to Photos". Once per export, never on reload.
- **Mark as posted** updates the goal: a toast "3 of 5 this week" and `selection` haptic.
- **Errors:** a render failure shows an error card in place of the preview (pipeline message, Try again). The revision-changed card stays as today.
- (Pattern: Instagram "New Reel Composer": centred vertical preview with glass labels on the video, and Save draft beside Share at the bottom. Videoleap "Export": preview card, then settings rows, then one CTA.)

### 4.8 B-roll (`broll/[id].tsx`, page sheet)

- **Layout:** header "B-roll", subtitle "4 clips added · 3 placed", Done. An "Adding clips" card with per-file progress rows. A "Place them for me" card (primary with `sparkles`) when clips are unplaced. Then one card per transcript line that has or could take an overlay: the line text 15, the overlay as a 44x78 thumb plus title, with secondary 44 buttons Swap / Remove, or Add. A glass footer bar holds "Add clips" (secondary) and Done (primary).
- **States:** replanning: a card with a progress bar and "Placing your clips...", and the line cards are disabled at 50% opacity. Stuck upload: Retry. Empty: "Add your own clips. Kilo places them on the lines they fit." with "Add clips" primary.
- **Motion:** placements arriving use `listInsert` on the line cards. Swap cross-fades the thumb (160 ms). Remove uses `listRemove`.

### 4.9 Styles tab (`(tabs)/styles.tsx`)

- **Layout:** large title "Styles", trailing glass `plus`. One line of explanation, 15 muted. A list of style cards (content): graphic theme swatch 44, name 16/600, "Default" chip (`skyTint` fill, `accent` text 12/600), two-line summary 13 muted.
- **States:** empty state "No styles yet" with primary "Make a style"; skeleton rows; inline error.
- **Motion:** new style returns with `listInsert`; deleting uses `listRemove`; rows use `press`.

### 4.10 Style edit (`style/[id].tsx`)

- **Layout:** inset grouped cards in the native iOS 26 settings rhythm: name field; "Use for new batches" toggle; "Kind of video" segmented; cut toggles card; captions card (toggle, then a caption-style segmented that appears only when on); B-roll and graphics card; graphic theme picker (row of swatches 44, selected with a 2pt `accent` ring). Save is in the nav bar; Delete style is a destructive text button at the bottom.
- **Motion:** the caption-style row expands with a layout transition (`listInsert` spring), never a jump. Saving shows a toast "Style saved" and a `success` haptic.

### 4.11 You tab (`(tabs)/you.tsx`)

- **Layout:** large title "You". Account card (avatar 40 in a `skyTint` circle, email, how signed in). A card with Weekly goal (opens the sheet) and Styles (switches tab). Later, a Kilo Pro row (section 4.16). Sign out as a destructive text button. Version line 12 muted centred: "kilo 1.0.0 · AI video editor".
- Pattern: Pedometer++ "Settings Appearance": large title scrolling under the glass bar with grouped cards. SCRL "More": grouped rows with plan and upgrade at the top.

### 4.12 Weekly goal (`goal.tsx`, form sheet)

- **Layout:** progress card ("3 of 5 videos posted", `StepBar`, streak). Videos-per-week stepper card. Reminder card (toggle, day and time stepper). Notifications-off card with Open Settings. Save in a glass footer.
- **Motion:** stepper value uses a numeric roll (200 ms) and the `selection` haptic per step. `StepBar` fills step by step (`progress`, 60 ms stagger).

### 4.13 Record with script (`record/index.tsx`)

- **Layout:** paste area (auto-grow, white 0.9 fill, radius 16, min 160). Primary "Split into lines". Then the editable lines card: numbered rows with a drag handle, swipe to delete, "Add a line". Footer: primary "Record 6 lines" with `video`; text button "No script, just record". Resume card at the top when a session exists.
- **Motion:** split animates the lines in (`appear` stagger 25 ms). Reordering lifts a row (scale 1.02 and shadow, `impact light` on pick-up and on drop). Deleting a line uses `listRemove`.

### 4.14 Recorder (`record/camera.tsx`): dark camera, glass teleprompter

Always dark, whatever the system appearance. The camera fills the screen. All controls are glass over it.

```
[x]        ( ● 0:12 · 60 fps · 1080p )        [flip][Aa]
+-------------------------------------------------------+
|  LINE 3 OF 6                                          |  teleprompter panel
|  Here's what nobody tells you about it.               |  (light glass, ink text)
|  Next: It takes ten seconds and it actually works.    |
+-------------------------------------------------------+

                      (camera)

+-------------------------------------------------------+
| ===== ===== ===== ----- ----- -----   (line pills)     |  control panel
| 2 lines kept                     Take 2 of this line   |  (dark glass)
|   [Lines]           ( (●) )           [Keep, next]     |
|                  Finish and edit                       |
+-------------------------------------------------------+
```

- **Top row (y = safe area + 8):**
  - Close: glass circle 44, `xmark`. Confirms if there are unsaved takes.
  - Capture badge: glass capsule 32 high. While recording: an 8pt `record` dot and the timer 13/600 tabular. Then "60 fps" (13/600, `accent`, or `cut` when the camera gives less) and "1080p" (13/600, white at 70%).
  - Right group: one `GlassContainer` with flip (`arrow.triangle.2.circlepath.camera`) and script settings (`textformat.size`), 44 each, 8 apart, so they read as one glass cluster.
- **Teleprompter panel:** top third, 16 from the sides, 12 below the top row, so the creator's eyes stay near the lens. **Light** glass (regular, forced light appearance, white tint 0.55) with `ink` text, Kilo's look and readable over any background (CONTRACTS: white glass panels on dark). Radius 28, padding 18/20.
  - "LINE 3 OF 6": 12/600 `accent`, tracking 0.5.
  - Current line: 28/34 Inter 600 `ink` (the size follows the Aa setting: 24, 28 or 34).
  - Next line: 17/22 Inter 400 `muted`, prefixed "Next:".
  - While recording, long lines auto-scroll inside the panel on the UI thread. The current line's first 1.2 s holds still.
  - (Pattern: Detail "Teleprompter Recorder": large script with the upcoming text dimmed. Kilo uses one-line-per-take panels in its own light glass rather than a full-height script.)
- **Control panel:** bottom glass panel (regular, dark), inset 12 from the sides and above the home indicator, radius 32, padding 16.
  - Line pills: one per line, 4 high, radius 2, 4 apart, filling the width. Kept `accent`, current white, to-do white at 25%. Each pill is a 44-high touch target to jump to that line.
  - Counters: "2 lines kept" and "Take 2 of this line", 13 white at 70%.
  - Controls row, centred: left side button 52 glass circle with a 12/500 label under it ("Lines" `list.bullet`, or "Delete take" `trash` in `cut` after a take). Record button in the middle. Right side button 52 ("Keep, next" `checkmark`; accent-tinted glass when enabled, plain glass at 40% when disabled).
  - **Record button:** 76 outer ring (4pt white), inner 62 circle `record`. Recording: the inner shape morphs to a 28 rounded square (radius 8). After a take: the inner circle shows `arrow.counterclockwise` 20 white ("Record again").
  - "Finish and edit": a text button 15/600 white, 44 high, under the row. Disabled at 40%.
- **Countdown:** 3, 2, 1 at 96/700 white with a soft shadow, centred.
- **After a take:** the take preview (existing) plays in a 9:16 card at the centre, radius 20, with a glass "Take 2 · 0:08" capsule.
- **States:** starting camera ("Starting..." in the badge); permission gate (light glass card centred: icon, one line, "Allow camera and microphone" primary, "Upload clips instead" text); camera stopped (glass card with Try again); low-quality notice (glass capsule above the control panel: "This camera gives 30 fps at 720p. Kilo edits it as it is.").
- **Sheets:** Aa opens a dark form sheet, medium detent: text size segmented (S/M/L), scroll speed slider with walk and run icons, countdown on/off. (Pattern: Teleprompter.com "Teleprompter Recorder": speed ruler with walk and run end icons. Detail "Teleprompter Recorder": menu rows that show their current value.) Lines opens a dark sheet listing each line with its state; tap to jump.
- **Motion:** `record` (section 6) on start/stop. The countdown uses `countdown`. Keep, next: the current pill fills `accent` from left to right (200 ms). The teleprompter cross-fades to the next line (text slides up 8pt and fades, 180 ms), with `impact light`. Delete take: the preview card scales to 0.9 and fades (160 ms), with the `warning` haptic. No blur animates on this screen, ever (it would cost camera frames).

### 4.15 Ready to edit (`record/finish.tsx`)

- **Layout:** summary card ("6 clips · 0:48"), takes list (thumb 44x78, line text, duration, play), B-roll card with "Add clips", settings card (style row, kind segmented). Footer: primary "Edit this video", text button "Back to recording".
- **Motion:** submit closes the whole record group (modal dismiss), lands on Home where the new batch card arrives with `listInsert`, and plays the `success` haptic.

### 4.16 Paid tier placement (for later; patterns only)

What the top apps do, and what Kilo should do:

- **A quiet entry point:** a small glass capsule "Get Pro" in the Home header beside New (Detail "Get Started": green "Get Pro" pill top-left; Captions "Home Import Prompt": "Get MAX" pill; CapCut "Video Editing Home": "Start Standard for only $0.99" pill). Kilo: a "kilo pro" capsule, `accent` text on glass, shown only to free users.
- **Locked features marked in place:** a small "Pro" chip on B-roll, hook versions and motion graphics controls (CapCut: diamond badges on templates and options; Detail: "Pro" chips on feature cards). Tapping one opens the paywall sheet with that feature's demo at the top.
- **The paywall:** page sheet, large. A short looping demo of the feature, two plan cards (yearly selected, with weekly price under it), one primary CTA, Restore and terms in 12 muted (CapCut "Standard Monthly Paywall"; Detail "Subscription Offer").
- **Never** gate cut, review or export (the free tier), and never show the paywall before the first finished video.

---

## 5. Component inventory

All sizes in points. Colours are CONTRACTS tokens. Dark values are new (section 5.12) and need adding to CONTRACTS.

**Type.** Inter for all content and Kilo's own controls, using the existing `typeScale`. Native chrome stays SF Pro: tab labels, native menus, alerts, action sheets, the native segmented control, search field, toast system text if system-drawn. Nav bar titles (inline and large) are set to Inter 600 so the screen title carries the brand. Numbers that change (lengths, timers, percentages) always use `fontVariant: ['tabular-nums']`. Support Dynamic Type up to 1.4x for UI text and 1.6x for the transcript and teleprompter.

### 5.1 `<Glass>` (one component, every glass surface)

| Prop | Values |
|---|---|
| `kind` | `bar` (toolbars, footers), `button` (circles and capsules), `panel` (teleprompter, recorder controls, welcome panel), `toast` |
| `appearance` | `auto` (follows the screen), `light`, `dark` (recorder) |
| `tint` | none (default), `accent` (Keep, next; Pro capsule) |
| `interactive` | true for buttons (native press shimmer on iOS 26) |

| Kind | Radius | Padding | iOS 26 | Shadow |
|---|---|---|---|---|
| bar | 28 | 8 | `GlassView` regular | system |
| button 44 | 22 | 0 | regular, interactive | system |
| panel | 28 (teleprompter), 32 (control panel, welcome) | 16 to 20 | regular | system |
| toast | 22 | 12/16 | regular | system |

Inner radii are concentric: inner radius = outer radius - padding. For example, a 48 pill inside a 64 bar with 8 padding gets radius 24 against the bar's 28. Group adjacent glass in a `GlassContainer` (spacing 8) so they blend and morph together. Section 7 has the fallbacks.

### 5.2 Content card (`Card`)

`surface` fill, 1px `hairline`, `shadow.surface`, radius 20, padding 16. Pressable cards use `press` (scale 0.98). Grouped settings cards: padding 0/16, rows divided by `hairline` inset 16. Not glass, never blurred.

### 5.3 Buttons

| Variant | Height | Radius | Fill | Label | Notes |
|---|---|---|---|---|---|
| Primary | 56 (footer), 48 (in a glass bar), 44 (inline) | half height | `accentGloss` + `shadow.gloss` | Inter 600 17 (56) / 16 (48, 44), white | Leading icon 20, gap 8; padding 24 horizontal. Disabled: `track` fill, `muted` label, no shadow. Loading: spinner in place, keeps width. |
| Secondary (glass) | 52 / 44 | half height | `<Glass kind=button>` | Inter 600 16 `ink` | Over content cards (not floating), use the content version: white fill, 1px `outline`. |
| Text | 44 | none | none | Inter 600 15 `accent` (destructive `cut`) | |
| Icon (glass) | 44 circle | 22 | `<Glass kind=button>` | SF Symbol 17 semibold (iOS) / line icon 20 | Native nav bar buttons are system bar items, not this. |

Minimum touch target 44 everywhere. A visually smaller control gets `hitSlop` up to 44.

### 5.4 Chips

32 high, radius 16, padding 0/12, Inter 500 13, optional leading icon 14.
- **Off:** white fill, 1px `outline`, `ink` text.
- **On or selected:** `skyTint` fill, no border, `accent` text 600.
- **Status chip** ("Review"): `accent` text on `skyTint`.
- **Pro chip:** 20 high, radius 10, `accent` fill, white 11/700 "Pro".
- **Glass chip:** only over video (hook label on export previews, "Preview" labels): clear glass, white 12/600.

### 5.5 Segmented control

- **iOS:** native (`@expo/ui` `Picker`, segmented), 32 high capsule, system styling, `selection` haptic from the system.
- **Android and web:** Kilo's `SegmentedControl`. Track `rgba(12,24,48,0.06)` (dark: `rgba(255,255,255,0.08)`), radius 18, height 36, padding 2. Thumb white (dark `#2A3346`), radius 16, `shadow.surface`. Label Inter 600 13, unselected `muted`, selected `ink`. Thumb moves with `select`.
- Up to four segments. More than four becomes a menu row.

### 5.6 Progress

- **Bar:** height 6 (cards) or 3 (rows, preview link), radius = height/2, `track` behind and `accent` fill (`cut` when failed or offline). Animate `scaleX` with `transformOrigin: left`, never `width`.
- **Ring:** sizes 20 (accessory), 28 (rows), 44 (cards and export). Stroke 3, round caps, `track` behind and `accent` arc, starting at 12 o'clock and running clockwise. Indeterminate: a 25% arc rotating once a second, linear.
- **Traced border:** Review's not-ready card only (section 4.6).
- **StepBar:** the goal's discrete steps, 8 high, 4 apart, radius 4.
- Always show a number next to a determinate indicator somewhere on screen ("64%"). Progress never runs backwards; a lower server value is ignored until the step changes.

### 5.7 Thumbnails (`Thumb`)

Always 9:16, `contentFit: cover`.

| Width | Radius | Used in |
|---|---|---|
| 44 (x78) | 8 | List rows |
| 64 (x114) | 10 | Clip strips |
| 120 (x213) | 16 | Review player, not-ready card |
| 180 (x320) | 20 | Export pager |

- **Placeholder:** `track` fill with the `shimmer` loop (section 6), static under Reduce Motion.
- **Duration label:** bottom-right, clear glass capsule 18 high, white 11/600 tabular ("0:51"), on 64 and larger only.
- **Failed:** a `cut` triangle 16 over a 50% white veil.
- Use `expo-image` with `recyclingKey` = video id, so signed-URL changes don't flash.

### 5.8 List row (`VideoRow`)

76 high (fixed, for FlashList). Padding 10/16. Thumb 44x78 on the left, gap 12. Title Inter 500 15 `ink`, one line. Subtitle 13 `muted`, one line ("0:51 kept of 2:40 · 6 cuts"). Trailing: chevron 14 `muted`, status chip, progress ring 28, or failed icon. Divider `hairline` inset 72. Pressed: background `rgba(12,24,48,0.04)` immediately, plus `press` scale 0.98 on the row content.

### 5.9 Sheet

Native form or page sheet. Grabber visible. Detents as listed in section 3. The iOS 26 sheet is glass at partial detents and goes opaque at large; do not add a background. Content padding 20. The sheet title row is a native header (Inter 600 17). Close is a glass `xmark` 44 on the trailing side. Done or Save, if any, is on the trailing side and close moves to the leading side. Footer actions sit in a `<Glass kind=bar>`. (Pattern: Detail "Talking Head Auto Edit", and "Record Together" as an inset floating sheet with a glass close.)

### 5.10 Toast

- **Shape:** `<Glass kind=toast>` capsule, 44 high, max width 340, centred, 12 above whatever floats at the bottom (tab bar, toolbar, footer). Icon 16 plus text Inter 500 14 `ink`, one line, truncating.
- **Types:** success (`checkmark.circle.fill`, `accent`); info (no icon); error (`exclamationmark.triangle.fill`, `cut`), which adds "Retry" 14/600 `accent` at the trailing edge; offline ("You're offline. Changes save when you're back.", stays until online).
- **Behaviour:** one at a time, and a new one replaces the old. Auto-dismiss after 2.4 s (errors 4 s). Swipe down or tap to dismiss. Announced with `accessibilityLiveRegion` / `AccessibilityInfo.announceForAccessibility`.

### 5.11 Empty state

Centred in the available space, max width 300. Glyph 28 `accent` in a 64 circle filled `skyTint`. Title Inter 600 20 `ink`, 8 below. Body 15 `muted`, centred, 6 below. One primary action, 52 high, 20 below, only if there isn't already an obvious one on screen. (Pattern: Denim "My Covers Empty State": one icon, one line, one glass action.)

### 5.12 Dark mode tokens (proposed; add to CONTRACTS section 6)

| Token | Light (existing) | Dark |
|---|---|---|
| `ground` | `#F5F8FC` | `#0A0F1A` |
| `skyTint` | `#D9E8FF` | `#11244D` (same 36% fade) |
| `surface` | `rgba(255,255,255,0.8)` | `rgba(28,34,48,0.85)` |
| `ink` | `#0B1220` | `#F2F5FA` |
| `muted` | `#566074` | `#9AA4B5` |
| `accent` | `#1F5EFF` | `#4C7DFF` (5.2:1 on ground) |
| `accentGloss` | `#2A66FF` to `#1A52E8` | `#3A72FF` to `#2257F0` |
| `track` | `#D5DDEA` | `#2A3346` |
| `hairline` | `rgba(12,24,48,0.08)` | `rgba(255,255,255,0.08)` |
| `outline` | `rgba(12,24,48,0.14)` | `rgba(255,255,255,0.16)` |
| `cut` | `#B4441E` | `#F0875A` (7:1 on ground) |
| `record` | `#F0442E` | `#FF5A45` |
| shadows | blue-tinted as now | none (use `hairline` borders instead) |

Kept vs cut in dark: kept is the solid `accent` bar on a `surface` row; cut is a transparent row with a 1px `cut` outline and struck `muted` text. The recorder is dark in both modes.

---

## 6. Motion spec

Springs are Reanimated `withSpring` configs. Durations use `withTiming`. Easing `standard` is `Easing.bezier(0.2, 0.8, 0.2, 1)`; `exit` is `Easing.bezier(0.4, 0, 1, 1)`. Haptics are `expo-haptics`.

| Name | What moves | Parameters | Haptic |
|---|---|---|---|
| `press` | Scale to 0.97 (buttons) / 0.98 (cards, rows) on press-in, back on release | spring mass 0.5, damping 18, stiffness 420 | none on press-in. On commit: primary CTAs `impact light`; everything else none |
| `select` | Segment thumb, chip fill, toggle knob, scrub knob, tab change | spring mass 0.8, damping 22, stiffness 320 (settles about 250 ms) | `selection` (native controls already do it; don't double it) |
| `cutToggle` | Row fill and border cross-fade; strike-through draws left to right; final length rolls; strip block fill | fill 160 ms `standard`; strike `scaleX` 0 to 1, 200 ms `standard`; number roll 240 ms | Cut: `impact light`. Put back: `impact soft` |
| `appear` | Opacity 0 to 1, translateY 8 to 0 | 240 ms `standard`; stagger 35 ms, first 8 items only | none |
| `listInsert` | New item: opacity 0 to 1, scale 0.97 to 1. Others: layout shift | spring mass 0.7, damping 20, stiffness 260 (`LinearTransition.springify()` with the same values) | none (unless the screen spec says so) |
| `listRemove` | Opacity to 0 and scale 0.97, then layout closes the gap | 160 ms `exit`, then the `listInsert` spring | `warning` only for destructive deletes, after the confirm |
| `progress` | Bar `scaleX` or ring stroke offset to the new value | 450 ms `Easing.bezier(0.25, 0.1, 0.25, 1)`; never backwards | none |
| `success` | Ring closes, check stroke draws, pop 1 to 1.06 to 1 | check 260 ms `standard`; pop spring mass 0.6, damping 12, stiffness 260 | `notification success` |
| `toast` | In: translateY 20 to 0 and fade. Out: fade and translateY 8 | in: spring mass 0.7, damping 24, stiffness 300. Out: 180 ms `exit` | Per type: success `notification success` (only for export and batch-created), error `notification error`, info none |
| `sheetIn` | Kilo's own bottom panels only (welcome): translateY 40 to 0 and fade | spring mass 0.9, damping 26, stiffness 240 | none |
| `record` | Inner circle to rounded square and back | spring mass 0.6, damping 16, stiffness 300 | Start: `impact medium`. Stop: `impact light` |
| `countdown` | Each numeral scales 1.25 to 1 and fades in, then fades out | 300 ms in `standard`, 200 ms out | `selection` per tick; `impact medium` at go (merged with `record`) |
| `shimmer` | Highlight band sweeps across skeletons | 1400 ms linear loop, band 40% width, white at 45% | none |
| `shake` | translateX 0, -6, 6, -3, 0 | 240 ms total | `notification error` |
| Page push, sheets, menus, tab switch, large-title collapse, menu morph from a glass button | Native | System | System |

### Rules

- **Never animate:** the video frame or its size; transcript text (no reflow, no per-word effects); scroll position during a scrub drag; numbers while the creator drags (they update instantly, then roll only on discrete changes); progress backwards; any blur radius; anything on the recorder while recording, except the timer, the record button and the teleprompter scroll; the status bar.
- **No custom page or sheet transitions.** Use the native ones. No hand-rolled shared-element transitions.
- **UI thread only.** All custom motion runs in Reanimated worklets (`useSharedValue`, `useAnimatedStyle`, layout animations). No `setState` per frame. Playhead and scrub position are shared values, interpolated each frame with `useFrameCallback` between the player's time events. The teleprompter auto-scroll is a `useFrameCallback` driving `scrollTo` on the UI thread. Animate only `transform` and `opacity`; layout changes go through layout animations.
- **Frame rate:** 120 fps on ProMotion for scrolling, presses, toggles and sheets (with the Info.plist key); a 60 fps floor on every device the app supports, including during review playback. The recorder must never drop capture frames: at most six glass views there, nothing blurs and animates at once, and the camera preview is never under an animated view.
- **Haptics:** only as mapped. Never on scroll, never on a press-in, never twice for one event, and never when the action failed silently.
- **Reduce Motion** (`useReducedMotion()`, plus `ReduceMotion.System` on every animation): translate and scale motions become opacity cross-fades of 150 ms or less; stagger, shimmer, pop and shake are off (shake becomes an outline flash in `cut`); progress jumps to its value; the record button changes shape instantly; auto-scroll keeps working (it's function, not decoration). Haptics stay.
- **Reduce Transparency:** every `<Glass>` uses its solid fallback (section 7) on every platform.
- **Increase Contrast:** glass gets a 1px `outline` border, and `muted` text becomes `ink` at 80%.

---

## 7. Fallbacks

`<Glass>` decides at runtime: `isLiquidGlassAvailable()` (iOS 26 and later), else blur, else solid. Same size, radius, padding and content everywhere, so layouts never shift between platforms.

| Surface | iOS 26 and later | iOS 18 to 25 | Android | Web |
|---|---|---|---|---|
| `<Glass>` light | `GlassView` regular | `BlurView` `systemThinMaterialLight` plus white 0.55 overlay, 1px `hairline` border, `shadow.surface` | Solid white 0.94, 1px `hairline`, elevation 2 | `backdrop-filter: blur(20px) saturate(180%)`, `rgba(255,255,255,0.72)`, 1px `hairline`; solid white 0.94 where unsupported |
| `<Glass>` dark (recorder) | `GlassView` regular, dark | `BlurView` `systemThinMaterialDark` plus `cameraScrim` at 0.35 | `cameraScrim` at 0.9 | `rgba(43,48,56,0.75)` plus blur |
| Teleprompter panel | Light glass, white tint 0.55 | White 0.9 plus blur (today's look) | White 0.92 | White 0.9 plus blur |
| Tab bar | Native floating glass, minimises | Native `UITabBar` (system blur) | Native Material bottom navigation, `accent` indicator | `KiloTabBar` (existing floating pill, white 0.85 plus blur) |
| Upload accessory | Native bottom accessory | A 44 glass capsule pinned above the tab bar | Same capsule, solid | Same capsule |
| Nav bar buttons | System glass bar items | System plain bar buttons (`accent` symbols) | Material top app bar icons, 48 targets | Kilo `IconButton` |
| Large titles | Native | Native | Material medium top app bar | Inter 600 28 in content |
| Segmented control | Native SwiftUI | Native SwiftUI (pre-26 look) | Kilo `SegmentedControl` | Kilo `SegmentedControl` |
| Menus | Native morphing glass menu | Native context menu | Material dropdown menu | Kilo popover card (white, radius 16, `shadow.surface`) |
| Sheets | Native glass form/page sheet | Native sheet | Bottom sheet, radius 28 top, white, scrim 0.32 | Centred card on wide screens; bottom sheet on narrow |
| Toast | Glass capsule | Blur capsule | Solid white capsule, elevation 3 | Blur capsule |
| Haptics | expo-haptics | expo-haptics | expo-haptics (Android maps it) | none |
| Symbols | SF Symbols in chrome | SF Symbols | Kilo line icons | Kilo line icons |

On Android, never imitate glass with a heavy blur, because it is costly and looks foreign there. Solid white with a hairline is Kilo's coherent Android look.

---

## 8. References (as the Appllama library names them)

| Pattern | App | Screen |
|---|---|---|
| Floating glass tab bar, icons only, with a separate circular + button; glass pill top tabs; glass search; glass chips | Glass — Photography Community | Explore; Photo Search Results |
| Glass popover menu from a top tab | Glass — Photography Community | Explore Category Menu |
| Floating glass bottom toolbar with a separate circular back button over scrolling content | Glass — Photography Community | Photo Detail |
| Glass header button cluster; tab bar plus separate + | corner: curate & share places | Home Discover |
| Floating tab bar with labels and a tinted selected pill; glass chips over hero media | TIDE: Sleep, Focus, Meditation | Sound Browse |
| Large title, glass circular button, compact two-tab bar, one-action empty state | Denim - Playlist Cover Maker | My Covers Empty State |
| Dark grouped list with plan and upgrade on top; tab bar plus separate + | SCRL: Photo Collage Maker | More |
| Large title under the glass bar with scroll-edge fade; labelled floating tab bar | Pedometer++ | Settings Appearance |
| Glass segmented control, icon tab bar plus + | StrengthLog – Workout Tracker | Squat Strength Distribution |
| Glass circular nav buttons, inline centred title, segmented range | Heartica: Heart Rate Monitor | HRV And SDNN Trends |
| + button morphing into a glass import menu; "Get Pro" header pill; Pro chips on cards | Detail: AI Video Editor | Import Media Sheet; Creation Mode Picker |
| Inset floating glass sheet with glass close | Detail: AI Video Editor | Home Update Modal; Record Together |
| Teleprompter with dimmed upcoming text; glass menus showing current values; glass tool rail | Detail: AI Video Editor | Teleprompter Recorder; Recording Tools Menu |
| Settings sheet: segmented plus toggle rows plus style tiles | Detail: AI Video Editor | Talking Head Auto Edit; Teleprompter Settings |
| Onboarding then paywall motion: selection fill, rising Continue, staggered list | Detail: AI Video Editor | Onboarding (screen recording) |
| Clip summary, mode segmented, option rows, one CTA | Captions: AI Edits Your Video | New Video Options |
| Mode menu with subtitles from a pill | Captions: AI Edits Your Video | Mode Menu Open |
| Progress traced around the preview's border | Captions: AI Edits Your Video | AI Editing Progress |
| Large vertical preview with glass close and Export over it | Captions: AI Edits Your Video | Timeline Editor |
| Brand settles, then the sign-in sheet rises | Captions: AI Edits Your Video | Welcome Screen (recording); Sign In |
| Big creation tiles on Home; header upsell pill | CapCut: Photo & Video Editor | Video Editing Home |
| Custom media picker with selected tray (what Kilo avoids) | CapCut: Photo & Video Editor | Stock Media Library |
| Settings sheet before a generation; blocking progress modal (what Kilo avoids) | CapCut: Photo & Video Editor | Auto Captions Setup; Caption Generation Progress |
| Paywall: plan tabs, demo hero, two plan cards, one CTA | CapCut: Photo & Video Editor | Standard Monthly Paywall |
| Progress ring, then "Success!" tick, then "You saved up 6.1s" toast over the player | Videoleap: AI Video Editor | Video Effects & Editing (screen recording, 0:50 to 0:55) |
| Export: preview card, settings rows, one CTA | Videoleap: AI Video Editor | Export |
| Share step: centred vertical preview with glass labels; Save draft plus Share | Instagram | New Reel Composer |
| Grouped option sheet | Instagram | Post Options Menu |
| Dark glass control panel, speed ruler with walk/run icons, glass popover with checks | Teleprompter.com | Teleprompter Recorder; Recording Options Menu |
| Dark settings sheet with segmented resolution | Teleprompter.com | Frame Size Settings |
| Bottom recorder tool row and record button | BIGVU Teleprompter Captions AI | Recorder Effects |

---

## 9. Open decisions for the owner

1. **New dependencies:** reanimated 4, worklets, gesture-handler, expo-haptics, expo-glass-effect, expo-blur, expo-symbols, @expo/ui and flash-list. The brief assumes all of them.
2. **Dark mode:** `app.json` has `userInterfaceStyle: "light"`. Shipping dark means flipping it to `automatic` and adding the dark tokens to CONTRACTS section 6 (lead-owned). Recommended, but it can follow the glass work.
3. **Native tabs replace `KiloTabBar`** on iOS and Android (it stays for web). The mock-up's 72pt tab bar goes.
4. **Home header changes:** the Settings icon goes (You is a tab), and a New (+) menu joins All videos.
5. **Review changes:** "Looks good" and the cut stepper move into a floating glass toolbar; B-roll moves from the footer to a chip and the menu.
6. **Minimum iOS version and test devices:** glass needs iOS 26; the fallbacks cover 18 to 25. Pick the oldest iPhone the 60 fps floor must hold on.
7. **Paywall timing** when the paid tier comes: after the first finished video, from locked features only (recommended), or also in onboarding as Detail does.
