# Phase 05 — Upcoming meetings and weather cards

**Depends on:** 01, 02 · **Enables:** 07 (Open and Ask about this on events),
08 (fetched results visible to the web client)

## Goal
Add the two fetched cards. They call their source on an interval with no
model and no job, cache the last result in `home_cards.last_result`, and show
it at once on launch. Upcoming meetings uses the existing calendar command;
Weather uses Open-Meteo through the network proxy. The Refresh button is the
CardFrame slot from phase 02.

## Files touched
- `src/routes/+layout.svelte` — start the refresher after `startScheduler()`.
- `src/lib/home/fetchedCards.svelte.ts` (new) — refresher: one 60-second
  ticker that refreshes each fetched card whose `updated_at` is older than its
  interval; Refresh button calls it directly.
- `src-tauri/src/db/home_cards.rs` / `commands.rs` — new
  `db_home_cards_set_result(id, last_result, updated_at)`; phase 01's update
  command covers size, config and notify only.
- `src/lib/ipc/gen/*` — regenerated.
- `src/lib/home/cardTypes.ts` — `upcoming_meetings`, `weather` (kind
  `fetched`, each with `fetch(config): Promise<unknown>` and
  `intervalMinutes(config)`).
- `src/lib/home/meetings.ts` (new) — query and join-link extraction.
- `src/lib/home/weather.ts` (new) — geocode and forecast.
- `src/lib/components/home/cards/MeetingsCard.svelte` (new).
- `src/lib/components/home/cards/WeatherCard.svelte` (new).
- `src/lib/components/home/forms/MeetingsForm.svelte`,
  `forms/WeatherForm.svelte` (new).
- `docs/guide/home.md`, `docs/guide/search-and-network.md`.

## Steps
1. Refresher: started from `+layout.svelte` next to `startScheduler()`, only
   outside lean mode. It runs fetches one at a time, skips a card already
   fetching, and writes `{ last_result, updated_at }` on success. A failure
   keeps the old result and stores `{ error }` in memory for the card to
   show under it.
2. Meetings: config `{ hours: number (default 12), accountIds: string[]
   (default `[]`) }`, interval 10 minutes. An empty `accountIds` means every
   enabled calendar account at fetch time, so an account added later is
   included; a non-empty list is used as given. Call `dav_list_events` with
   those accounts from `enabledDavAccounts()` (CalDAV, Google Calendar and
   ICS feeds all go through it), now → now + hours, `Intl` time zone,
   `getSettings().proxy`. Store `{ events: [{ uid, accountId, summary,
   start, end, allDay, location, organizer, attendees, joinUrl }] }`.
   `joinUrl`: the first `https://` URL in `location`, then `description`,
   whose host matches `meet.google.com`, `*.zoom.us`, `teams.microsoft.com`,
   `teams.live.com`, `*.webex.com`, `whereby.com` or `meet.jit.si`.
3. Meetings card: next events grouped Now / Later today / Tomorrow, each with
   time, title and a Join button when `joinUrl` is set (opens with the
   system opener). "Nothing in the next N hours." (N from config) when empty. `addable` when
   `hasEnabledCalendarAccount()`.
4. Weather: config `{ place: string; lat: number; lon: number; units:
   'metric' | 'imperial' }`. The Add card form geocodes `place` with
   `https://geocoding-api.open-meteo.com/v1/search?name=…&count=5` and lets
   the user pick one match; lat/lon are stored, so later fetches never
   geocode. Interval 30 minutes. Forecast:
   `https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…&current=
   temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,
   temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto
   &forecast_days=2`; imperial adds `&temperature_unit=fahrenheit&wind_speed_unit=mph`,
   metric adds nothing (Open-Meteo defaults to °C and km/h). Both go through `invoke('proxy_fetch',
   { url, caller: 'home-weather', proxy: getSettings().proxy })`; parse the
   JSON text.
5. Weather card: now (temperature, WMO code label and icon, wind), today's
   high/low and rain chance, tomorrow's in one line. WMO codes map to labels
   in `weather.ts`.
6. Docs: `home.md` sections for both; `search-and-network.md` lists
   `open-meteo.com` as a host the Weather card calls through the network
   proxy, only when the card exists.

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs` passes

## Test plan
- Unit: refresher — refreshes only stale cards; failure keeps the old result;
  no overlap for one card.
- Unit: join-link extraction for each listed host, a non-https link, and a
  plain location.
- Unit: weather parsing with a recorded Open-Meteo response; WMO mapping.
- Hand: add both cards; restart the app offline; both show the cached result
  with an "updated" time and an error line; go online and Refresh.

## Commit
`feat(home): upcoming meetings and weather cards`

## Rollback
Revert the commit. Rows of these types show "Unknown card" from the phase-01
guard; `last_result` stays unused. No outbound calls happen once reverted.
