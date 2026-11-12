const $ = id => document.getElementById(id);
let current = {};
async function request(command, extra = {}) {
  const result = await chrome.runtime.sendMessage({ command, ...extra });
  if (!result?.ok) throw new Error(result?.error || 'The extension stopped responding.');
  return result.value;
}
async function task(fn) {
  try { await fn(); } catch (error) { $('status').textContent = error.message; }
}
async function refresh() {
  const { config = {}, state, lastError } = await request('status');
  current = config;
  $('group').value = config.groupUrl || '';
  $('horizon').value = config.daysAhead || 30;
  $('auto').checked = !!config.auto;
  $('auto').disabled = !config.pilotVerified;
  $('recipes').value = JSON.stringify(config.ui || { verified: false, authenticatedSelector: null, create: null, update: null, cancel: null }, null, 2);
  $('pending').textContent = state?.pending ? `${state.pending.kind}: ${state.pending.data.title} (${state.pending.data.start})` : 'No pending submission.';
  $('status').textContent = lastError || '';
  const { controls = [] } = await chrome.storage.local.get('controls');
  $('controls').value = JSON.stringify(controls, null, 2);
}
$('settings').onsubmit = event => {
  event.preventDefault();
  task(async () => {
    await request('setup', { config: { ...current, groupUrl: $('group').value.trim(), daysAhead: Number($('horizon').value),
      auto: $('auto').checked, ui: JSON.parse($('recipes').value) } });
    await refresh();
    $('status').textContent = 'Settings saved. Use the toolbar to preview and prepare one event.';
  });
};
$('adopt').onclick = () => task(async () => {
  $('status').textContent = 'Checking and linking the existing Facebook event…';
  await request('adopt', { eventId: $('event-id').value.trim(), url: $('event-url').value.trim() });
  await refresh();
  $('status').textContent = 'Linked the existing event and verified the updated details.';
});
$('recover').onclick = () => task(async () => {
  await request('recover', { url: $('recovery-url').value.trim() });
  await refresh();
  $('status').textContent = 'Verified Facebook’s saved event and recovered its receipt.';
});
$('clear').onclick = () => task(async () => {
  await request('clear-pending', { confirmedNotSubmitted: $('not-submitted').checked });
  await refresh();
  $('not-submitted').checked = false;
  $('status').textContent = 'Discarded the unsubmitted attempt. It can now be prepared again.';
});
$('backup').onclick = () => task(async () => {
  const { state } = await chrome.storage.local.get('state');
  if (!state) throw new Error('No sync receipts have been saved yet.');
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `larimer-chess-facebook-receipts-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
await task(refresh);
