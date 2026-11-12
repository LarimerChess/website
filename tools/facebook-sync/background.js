import { SOURCE, FORM_FIELDS, emptyState, validateState, validateFeed, plan, execute, validateRecipes, isGroupUrl, isEventUrl, formData, trustedExtensionSender } from './core.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settings = async () => {
  const { config = {}, state } = await chrome.storage.local.get(['config', 'state']);
  if (!isGroupUrl(config.groupUrl)) throw new Error('Open setup and enter the Facebook group URL.');
  return { config, state: state || emptyState(config.groupUrl) };
};
const save = state => chrome.storage.local.set({ state });

async function navigate(tabId, url) {
  let listener;
  let timeout;
  const loaded = new Promise((resolve, reject) => {
    listener = (id, change) => { if (id === tabId && change.status === 'complete') resolve(); };
    chrome.tabs.onUpdated.addListener(listener);
    timeout = setTimeout(() => reject(new Error('Facebook did not finish loading the saved event.')), 30000);
  });
  try {
    await chrome.tabs.update(tabId, { url });
    await loaded;
  } finally {
    clearTimeout(timeout);
    chrome.tabs.onUpdated.removeListener(listener);
  }
}

async function source() {
  const response = await fetch(`${SOURCE}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`The club event feed returned HTTP ${response.status}. Run Update calendar after deploying the feed publisher.`);
  return validateFeed(await response.json());
}

async function ready(tabId) {
  for (let count = 0; count < 60; count++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await delay(500);
  }
  throw new Error('Facebook did not finish loading. Open the sync tab.');
}

async function send(tabId, message) {
  await ready(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://www.facebook.com/')) throw new Error('Facebook navigated outside its expected address.');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['selectors.js', 'content.js'] });
  const response = await chrome.tabs.sendMessage(tabId, { ...message, scope: 'lccc-event-sync' });
  if (!response?.ok) throw new Error(response?.error || 'Facebook stopped responding. Inspect the pending submission.');
  return response.value;
}

async function browserAction(action, config, state, prepareOnly = false) {
  const target = action.kind === 'create' ? `${config.groupUrl}events/` : action.url;
  if (action.kind !== 'create' && !isEventUrl(target)) throw new Error('The saved Facebook event URL is invalid.');
  // Facebook's date widgets do not reliably commit in an inactive tab.
  const [previousTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = await chrome.tabs.create({ url: target, active: true });
  await chrome.storage.local.set({ lastTabId: tab.id });
  if (!prepareOnly) {
    state.pending.tabId = tab.id;
    await save(state);
  }
  const common = { action, ui: config.ui, groupUrl: config.groupUrl, fields: FORM_FIELDS };
  if (action.adopt) {
    // An explicit URL plus title and both timestamps identify an existing event before linking it.
    await send(tab.id, { ...common, command: 'verify', fields: ['title', 'startDate', 'startTime', 'endDate', 'endTime'] });
    await navigate(tab.id, target);
  }
  await send(tab.id, { ...common, command: 'prepare' });
  if (prepareOnly) return { tabId: tab.id };
  for (const step of config.ui[action.kind].commit) {
    await send(tab.id, { ...common, command: 'submit', selector: step.selector });
    await delay(700);
  }
  let saved;
  for (let count = 0; count < 30; count++) {
    const current = await chrome.tabs.get(tab.id);
    const address = new URL(current.url);
    const canonical = `${address.origin}${address.pathname.replace(/\/$/, '')}/`;
    if (isEventUrl(canonical)) { saved = canonical; break; }
    await delay(1000);
  }
  if (!saved) throw new Error('Facebook did not open the saved event. Review the pending submission.');
  if (action.kind !== 'create' && saved !== action.url) throw new Error('Facebook opened a different event after submission.');
  await delay(2000);
  await navigate(tab.id, saved);
  await send(tab.id, { ...common, command: 'verify' });
  if (config.auto) {
    const wasActive = (await chrome.tabs.get(tab.id)).active;
    await chrome.tabs.remove(tab.id);
    if (wasActive && previousTab) {
      try { await chrome.tabs.update(previousTab.id, { active: true }); } catch { /* The previous tab may have closed. */ }
    }
  }
  return { url: saved };
}

async function command(message) {
  if (message.command === 'status') {
    const data = await chrome.storage.local.get(['config', 'state', 'lastRun', 'lastTabId', 'lastError']);
    return { ...data, source: SOURCE };
  }
  if (message.command === 'setup') {
    const config = message.config;
    if (!isGroupUrl(config.groupUrl)) throw new Error('Use https://www.facebook.com/groups/GROUP/ including the final slash.');
    if (!Number.isInteger(config.daysAhead) || config.daysAhead < 1 || config.daysAhead > 90) throw new Error('Choose 1 to 90 days.');
    const old = await chrome.storage.local.get('state');
    if (old.state) validateState(old.state, config.groupUrl);
    if (config.auto) {
      validateRecipes(config.ui);
      if (config.ui.verified !== true || !config.pilotVerified) throw new Error('Complete a successful single-event sync before enabling automatic sync.');
    }
    const { config: previous = {} } = await chrome.storage.local.get('config');
    // A recipe edit invalidates the pilot. The service worker alone grants that receipt.
    config.pilotVerified = previous.pilotVerified === true && JSON.stringify(previous.ui) === JSON.stringify(config.ui);
    if (config.auto && !config.pilotVerified) throw new Error('Run a new single-event pilot after changing the Facebook form setup.');
    await chrome.storage.local.set({ config });
    if (config.auto) await chrome.alarms.create('sync-events', { delayInMinutes: 1, periodInMinutes: 60 });
    else await chrome.alarms.clear('sync-events');
    return { saved: true };
  }
  if (message.command === 'inspect') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://www.facebook.com/')) throw new Error('Select the Facebook event form tab, then use Inspect from the extension toolbar.');
    const controls = await send(tab.id, { command: 'inspect' });
    await chrome.storage.local.set({ controls });
    return controls;
  }
  const { config, state } = await settings();
  validateState(state, config.groupUrl);
  if (message.command === 'clear-pending') {
    if (!message.confirmedNotSubmitted) throw new Error('First check Facebook and confirm the pending event was never submitted.');
    state.pending = null;
    await save(state);
    return { cleared: true };
  }
  if (message.command === 'recover') {
    if (!state.pending || !isEventUrl(message.url)) throw new Error('Enter the saved event URL for the pending submission.');
    const action = state.pending;
    validateRecipes(config.ui, [action.kind]);
    if (action.kind !== 'create' && message.url !== action.url) throw new Error('The recovery URL must match the pending event.');
    const tab = await chrome.tabs.create({ url: message.url, active: true });
    await chrome.storage.local.set({ lastTabId: tab.id });
    const recovered = { ...state, pending: null };
    await execute([action], recovered, async () => {
      await send(tab.id, { command: 'verify', action, ui: config.ui, groupUrl: config.groupUrl, fields: FORM_FIELDS });
      return { url: message.url };
    }, save, 1);
    config.pilotVerified = true;
    await chrome.storage.local.set({ config, lastRun: new Date().toISOString() });
    await chrome.storage.local.set({ lastError: '' });
    return { recovered: true };
  }
  const feed = await source();
  const actions = plan(feed, state, config.groupUrl, new Date(), config.daysAhead || 30);
  if (message.command === 'preview') return { actions, generatedAt: feed.generatedAt };
  if (message.command === 'prepare') {
    const action = actions.find(value => !message.eventId || value.data.id === message.eventId);
    if (!action) return { message: 'No matching change is needed.' };
    validateRecipes(config.ui, [action.kind]);
    return browserAction(action, config, state, true);
  }
  if (message.command === 'apply' || message.command === 'adopt') {
    if (config.ui.verified !== true) throw new Error('Prepare an event and verify the Facebook form setup before publishing.');
    let selected = actions.filter(action => !message.eventId || action.data.id === message.eventId);
    if (message.command === 'adopt') {
      if (!isEventUrl(message.url) || !message.eventId) throw new Error('Linking an existing event needs its Google occurrence ID and Facebook event URL.');
      const row = feed.events.find(row => row.id === message.eventId && row.status === 'active');
      if (!row || new Date(row.start) <= new Date()) throw new Error('The selected club occurrence is no longer upcoming.');
      if (state.events[row.id]) throw new Error('This Google occurrence already has a Facebook receipt.');
      if (Object.values(state.events).some(receipt => receipt.url === message.url)) throw new Error('This Facebook event is already linked to a different occurrence.');
      selected = [{ kind: 'update', data: formData(row), url: message.url, adopt: true }];
    }
    validateRecipes(config.ui, selected.slice(0, message.automatic ? 3 : 1).map(action => action.kind));
    await execute(selected, state, action => browserAction(action, config, state), save, message.automatic ? 3 : 1);
    if (selected.length) {
      config.pilotVerified = true;
      await chrome.storage.local.set({ config });
    }
    await chrome.storage.local.set({ lastRun: new Date().toISOString(), lastError: '' });
    return { applied: Math.min(selected.length, message.automatic ? 3 : 1) };
  }
  throw new Error('Unknown extension command.');
}

async function run(message) {
  return navigator.locks.request('lccc-facebook-sync', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('A sync is already running.');
    return command(message);
  });
}

async function recordError(error) {
  // Browser exception text can contain page URLs. Store only messages raised by our code.
  const safe = /^(The club|The saved|The selected|This |A |An |Facebook |Open |Select |Saved |Set |Use |Choose |Complete |Run |Review |Enter |First |Linking |Updates |Cancellation |Submission|create needs|update needs)/.test(error.message);
  const message = safe ? error.message : 'Sync stopped. Open the Facebook tab and review the pending submission.';
  await chrome.storage.local.set({ lastError: message });
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#9c3e2c' });
  return message;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!trustedExtensionSender(sender, chrome.runtime.id)) return;
  run(message).then(async value => {
    if (['apply', 'adopt', 'recover', 'clear-pending'].includes(message.command)) await chrome.action.setBadgeText({ text: '' });
    respond({ ok: true, value });
  }, async error => respond({ ok: false, error: await recordError(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'sync-events') return;
  const { config } = await chrome.storage.local.get('config');
  if (!config?.auto || !config.pilotVerified || !config.ui?.verified) return;
  try { await run({ command: 'apply', automatic: true }); }
  catch (error) { await recordError(error); }
});

chrome.runtime.onStartup.addListener(async () => {
  const { config } = await chrome.storage.local.get('config');
  if (config?.auto && config.pilotVerified && config.ui?.verified) await chrome.alarms.create('sync-events', { delayInMinutes: 1, periodInMinutes: 60 });
});
