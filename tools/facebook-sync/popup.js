import { syncNow } from './manual-sync.js';
const $ = id => document.getElementById(id);
let actions = [];
const syncRequested = new URLSearchParams(location.search).get('sync') === '1';
if (syncRequested) {
  document.body.classList.add('sync-page');
  history.replaceState(null, '', location.pathname);
}
async function send(command, extra = {}) {
  const response = await chrome.runtime.sendMessage({ command, ...extra });
  if (!response?.ok) throw new Error(response?.error || 'The extension stopped responding. Open its service worker log.');
  return response.value;
}
async function task(fn) {
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try { await fn(); } catch (error) { $('status').textContent = error.message; }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
function show() {
  const action = actions.find(value => value.data.id === $('occurrence').value);
  if (!action) return;
  $('title').textContent = action.data.title;
  $('when').textContent = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Denver' }).format(new Date(action.data.start));
  $('where').textContent = action.data.location;
  $('description').textContent = action.data.description;
  $('google-id').textContent = action.data.id;
  $('apply').textContent = action.kind === 'cancel' ? 'Cancel this Facebook event' : 'Sync this event';
}
async function preview() {
  $('status').textContent = 'Reading the club calendar…';
  const data = await send('preview');
  actions = data.actions;
  $('occurrence').replaceChildren(...actions.map(action => {
    const option = document.createElement('option');
    option.value = action.data.id;
    option.textContent = `${action.kind[0].toUpperCase()}${action.kind.slice(1)} · ${action.data.title} · ${action.data.start.slice(0, 10)}`;
    return option;
  }));
  $('changes').hidden = !actions.length;
  $('status').textContent = actions.length ? `${actions.length} calendar change(s) to sync. Review one below.` : 'Facebook receipts match the upcoming club calendar.';
  show();
}
$('preview').onclick = () => task(preview);
$('sync-now').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?sync=1') });
$('occurrence').onchange = show;
$('setup').onclick = () => chrome.runtime.openOptionsPage();
$('prepare').onclick = () => task(async () => {
  await send('prepare', { eventId: $('occurrence').value });
  $('status').textContent = 'Prepared the form without publishing. Check its dates, venue, and description.';
});
$('apply').onclick = () => task(async () => {
  $('status').textContent = 'Syncing and checking Facebook’s saved event…';
  const result = await send('apply', { eventId: $('occurrence').value });
  if (result.applied) await preview();
});
$('open-tab').onclick = () => task(async () => {
  const { lastTabId, config } = await send('status');
  if (lastTabId) {
    try { await chrome.tabs.update(lastTabId, { active: true }); return; } catch { /* The operator may have closed it. */ }
  }
  if (config?.groupUrl) await chrome.tabs.create({ url: `${config.groupUrl}events/` });
  else await chrome.runtime.openOptionsPage();
});
$('inspect').onclick = () => task(async () => {
  await send('inspect');
  $('status').textContent = 'Saved visible form controls locally. Open setup to review them.';
});
await task(async () => {
  const { config, state, lastError, lastRun } = await send('status');
  $('status').textContent = state?.pending ? 'A submission needs review. Open the sync tab, then use recovery in Setup.'
    : lastError || (!config?.groupUrl ? 'Open setup to connect the club’s Facebook group.'
      : lastRun ? `Last successful sync: ${new Date(lastRun).toLocaleString()}` : 'Ready to preview the club calendar.');
});
if (syncRequested) {
  await task(async () => {
    const { applied } = await syncNow(send, ({ applied, remaining }) => {
      $('status').textContent = `Synced ${applied} change(s). ${remaining} remaining. Keep this tab open until syncing finishes.`;
    });
    $('status').textContent = applied ? `Sync complete. ${applied} change(s) saved and verified.` : 'Already in sync. No changes needed.';
  });
}
