# Facebook event sync

Chrome/Edge extension for syncing public Larimer County Chess Club events to a Facebook group. GitHub Actions publishes the calendar data; your signed-in browser handles Facebook. No Facebook password, session cookie, or Google token is copied into the extension.

The publisher is deployed. The extension is installed for the club's [Facebook group](https://www.facebook.com/groups/1525867882699030/). English desktop form recipes in `facebook-ui.js` were captured and tested in the signed-in browser on November 12, 2026. Creates and saved-value readback were exercised on real calendar events; an existing tournament was corrected through the edit flow. The cancellation dialog and its Cancel selection were checked without cancelling a scheduled club event. Cancellation requires a visible saved cancellation status; an unrecognized result leaves the journal pending for review.

## Install and connect

1. Deploy the website changes and run **Update calendar**. It writes `https://larimerchess.org/facebook-events.json`, which the extension needs for previews.
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, choose **Load unpacked**, and select this `tools/facebook-sync` folder.
3. Pin **Larimer Chess event sync** to the toolbar. Open **Setup**, enter the canonical group URL with its final slash, and leave hourly sync off.
4. Sign in to Facebook normally in this browser profile. Set the computer/browser time zone to Mountain Time.
5. Setup includes the captured club form recipes. Use **Prepare without publishing** for one event and inspect every field, including the host group, time zone, dates, venue, and full description. Inspect and update the recipes if Facebook changes its forms.
6. Set the form recipe's `verified` value to `true` after preparation succeeds. Use **Sync this event** for one event. The extension reopens the saved event and checks every field before recording its URL.
7. For events that already exist, use **Link an existing Facebook event** in Setup instead of creating duplicates. Linking verifies the existing title and dates before updating it, preserving its URL and responses. Expand **Event description and reference** in the preview to copy the Google occurrence ID.
8. Enable hourly sync after the pilot succeeds. It applies up to three changes each hour while this browser profile is running. Facebook's date controls require an active tab, so sync briefly selects its Facebook tab, verifies the saved event, then closes it and returns to your previous tab. Sleep, a closed browser, or an expired Facebook session delays syncing.

Use one browser profile as the sync owner. Another installation with an empty receipt history can create duplicates. Download receipts before removing the extension. No browser store publication is needed for the unpacked club installation.

## Facebook form setup

Open each Facebook form in a tab, then use **Inspect this Facebook form** in the toolbar popup. Setup displays visible control labels and IDs locally. Use DevTools for more specific selectors. Each selector must match exactly one visible control; ambiguous controls stop the run. The time-zone check intentionally checks every visible time-zone input.

Recipes default to `verified: false`. The complete captured defaults live in `facebook-ui.js`; saved settings are preserved across extension reloads. A minimal unconfigured installation looks like:

```json
{
  "verified": false,
  "authenticatedSelector": null,
  "create": null,
  "update": null,
  "cancel": null
}
```

`authenticatedSelector` identifies a signed-in control present on the group and event pages. A login page, checkpoint, missing signed-in control, or CAPTCHA stops automation for manual attention.

Each create/update/cancel recipe contains:

| Key | Purpose |
|---|---|
| `open` | Steps to open the form, including optional end-time controls |
| `afterFill` | Optional steps after a field changes, such as selecting the exact custom venue |
| `fields` | Create/edit selectors for `title`, `startDate`, `startTime`, `endDate`, `endTime`, `location`, and `body` |
| `timeZoneSelector`, `timeZoneText` | Mountain Time control and its exact text, checked before filling create/edit forms |
| `commit` | Final submission and confirmation button clicks; never run in preparation mode |
| `groupSelector` | Visible link to the configured group on the saved event page |
| `formGroupSelector`, `formGroupText` | Check the form's host group before submitting |
| `identify` | Optional steps to expand the existing description before checking its marker |
| `identitySelector` | Existing description containing the calendar reference; required for edits and cancellations |
| `read` | Optional steps to reveal saved event details |
| `verify` | Saved-value selectors for all seven fields, checked after a fresh navigation |
| `cancelledSelector`, `cancelledText` | Cancellation confirmation and its exact text |
| `cancelChoiceSelector` | Radio input that must select cancellation before submitting |

`open`, `identify`, `read`, and `afterFill` contain steps with `action` (`click`, `fill`, `press`, or `wait`) and `selector`. A step with `ifPresent: true` is skipped when its control is absent. `fill` and `press` also take `value`. Templates may reference event fields such as `{title}`, `{body}`, or `{marker}`. `commit` contains only explicit clicks. Form dates are `Nov 16, 2026`; times are `h:mm AM/PM`, in America/Denver. Date widgets receive an input render before blur commits their value. Verification reads persisted inputs after a fresh navigation, so a form that merely displays the requested date cannot count as success.

Selectors accept CSS, `label=exact accessible label`, `text=exact button/link/menu text`, `option=exact autocomplete choice`, and `contains=description reference`. Native label matching tolerates Facebook's title character counter. Nested autocomplete options count as one choice. `cancelled-status` recognizes a visible English Canceled/Cancelled status. The time-zone template `{timeZone}` is derived from the occurrence's Mountain Time date.

Changing a recipe invalidates the successful pilot. Run a new pilot before enabling hourly syncing. Recipes and diagnostics stay in extension-local storage; the calendar feed cannot supply scripts.

## Interrupted submissions

A pending journal is saved before operating each form. If Facebook stops responding, the tab closes, or saved-value verification fails, the extension stops further writes instead of retrying and risking duplicates. The toolbar shows `!`; open **Facebook sync tab** to inspect it.

If Facebook saved the event, enter its URL under **Recover an interrupted sync**. The extension verifies the saved details and records the receipt. If nothing was submitted, check Facebook first, then explicitly discard the unsubmitted attempt. Failed preparation can also leave a journal; discard it only after confirming no submission occurred.

## Calendar publisher

`scripts/publish_facebook_feed.py` uses the existing read-only Calendar token in **Update calendar**. It exports public events with organizer metadata exactly matching Larimer County Chess Club. Attendees, creator details, private properties, and private event contents are excluded. Making an existing public event private exports only a cancellation ID and its previously public dates.

Occurrence IDs match renamed and rescheduled events. The publisher re-reads an upcoming occurrence by ID when it leaves the normal 90-day window, distinguishing a move from cancellation. Google errors stop feed replacement. Feed failures are reported after normal website publication, so the integration does not prevent event cards from updating.

The feed timestamp refreshes at least every 12 hours on successful runs. The extension rejects a feed more than 24 hours old. Past events expire. Only explicit retractions cancel future Facebook events. Restoring a cancelled occurrence creates a new Facebook event and retains the old URL in its receipt.

## Verification

From the website repository:

```sh
python -m unittest discover -s tests
node --test tests/test_facebook_extension.mjs
for f in tools/facebook-sync/*.js; do node --check "$f"; done
npx --no-install html-validate tools/facebook-sync/*.html
```

CI runs these tests and checks. Offline checks do not establish compatibility with live Facebook forms; the single-event pilot supplies that evidence.
