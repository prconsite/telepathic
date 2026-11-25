# Telepathic

A teleprompter that installs on iPhone and iPad from the browser. No subscription, no ads, no script limits.

## What it does

- **Prompter**: steady speed in words per minute (the same pace on every screen size), finish-on-time, follow-my-voice, scroll-while-I-talk, and manual. `[speed 120]` cues change the pace mid-script.
- **Orientation**: Mirror, Flip and Rotate buttons on the prompter's bottom bar. Mirror is left-to-right for beam-splitter glass, Flip is top-to-bottom, Rotate turns the text 90, 180 or 270 degrees for rigs that hold the device sideways or upside down. Controls stay readable; the countdown turns with the text.
- **Voice**: one-tap Voice button. Word-by-word tracking where the browser offers speech recognition, with an automatic fallback to microphone-level scrolling where it does not.
- **Reading aids**: arrow, line or focus-band guide at any height, countdown, elapsed and remaining time, sections you can jump to, timed `[pause 3]` cues, speaker colours, notes that are never read aloud, right-to-left scripts.
- **Recording**: camera or audio-only takes while you read, 720p to 4K, 30 or 60 fps, saved through the share sheet. Each take comes with an `.srt` captions file timed from the scroll. The script is never burned into the video.
- **Control**: touch, any Bluetooth keyboard, clicker or pedal, a game controller, or another device in the same library as a remote (which can also open a different script).
- **Scripts**: autosave on every keystroke, version history, Trash with 30-day restore, folders, pinning, search, import from Word, PowerPoint (speaker notes), PDF, text and RTF, full backup and restore.
- **Accounts**: sign in with an emailed 6-digit code, no password. One account, one private library, on every device. Pairing-code sync without an account is still available.
- **Billing**: Stripe subscription ("Telepathic Plus") tied to the signed-in account. The teleprompter is free on one device; Plus covers sync, the remote and cloud history. Ships switched off.

## Install

Open the site in Safari on the iPhone or iPad, tap **Share**, then **Add to Home Screen**.

## How it is built

Plain HTML, CSS and JavaScript modules. No build step: the repository root is the site.

| Path | Purpose |
| --- | --- |
| `index.html`, `css/app.css` | App shell and styles |
| `js/prompter.js` | Scrolling engine, mirroring, on-screen controls |
| `js/voice.js` | Speech follow and microphone level |
| `js/recorder.js` | Camera and recording |
| `js/store.js` | Local storage (IndexedDB) |
| `js/sync.js`, `js/remote.js` | Accounts, Supabase sync and realtime remote |
| `supabase/functions/billing/` | Stripe checkout, portal, webhook, account deletion |
| `js/importer.js`, `js/markup.js` | File import and script formatting |
| `sw.js`, `manifest.webmanifest` | Offline support and install |
| `supabase/migrations/` | Database schema and functions |
| `vendor/` | supabase-js 2.119.2 (MIT), mammoth 1.13.0 (BSD-2-Clause), pdf.js 3.11.174 (Apache-2.0) |

## Backend

Run `supabase/migrations/0001_telepathic_core.sql` on the Supabase project named in `js/config.js`.
Every table has row-level security with no policies, so nothing is readable directly. The app talks only to
five `tp_*` functions, and each one requires the library's secret key (or a single-use pairing code).

## Accounts and billing

- `supabase/migrations/0002_accounts_billing.sql` adds account libraries, subscriptions, complimentary grants and two switches in `tp_settings`:
  - `billing_enforced` (default `false`): while false every signed-in user can sync. Set to `true` to require a subscription or a grant.
  - `allow_key_libraries` (default `true`): set to `false` to close pairing-code sync.
- `supabase/functions/billing/` is the only code that talks to Stripe. It creates Checkout and Customer Portal sessions for the signed-in user, handles the Stripe webhook, and deletes accounts (cancelling subscriptions first). Access is granted only from webhook events, never from the success page.
- Free access for a person: `insert into tp_grants (email, note) values ('name@example.com', 'why');`
- To go live: custom SMTP and a code in the sign-in email (Supabase Auth settings), a Stripe product with a recurring price, a restricted Stripe key, a webhook endpoint pointing at the function, and the function's secrets (listed at the top of `index.ts`). Read Stripe's guide on collecting tax for subscriptions before charging.

## Releasing a change

Bump `VERSION` in `sw.js` on every release. Installed copies keep serving the old files until it changes.

## Script formatting

```
# Section heading          jump target, not read aloud
**bold**  *italic*  __underline__
{y}colour{/}               y g b p o r
[pause 3]                  hold for 3 seconds; [pause] waits for a tap
[speed 120]                read at 120 words a minute from here on
[[note to self]]           shown small, never counted or voice-tracked
HOST: line                 speaker label with its own colour
---                        divider
```
