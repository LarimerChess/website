export const SOURCE = 'https://larimerchess.org/facebook-events.json';
export const CALENDAR = 'c_69fbe5a4899819d06515e28a5d5161b3508e9cabad74961ce27e36cc94d66f67@group.calendar.google.com';
export const isEventUrl = value => /^https:\/\/www\.facebook\.com\/events\/\d+\/$/.test(value);
export const isGroupUrl = value => /^https:\/\/www\.facebook\.com\/groups\/[a-zA-Z0-9._-]+\/$/.test(value);
export const FORM_FIELDS = ['title', 'startDate', 'startTime', 'endDate', 'endTime', 'location', 'body'];
export const trustedExtensionSender = (sender, id) => sender.id === id
  && typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${id}/`);

export function validateFeed(feed, now = new Date()) {
  const age = +now - Date.parse(feed?.generatedAt);
  if (feed?.schema !== 1 || feed.calendarId !== CALENDAR || !Array.isArray(feed.events)
      || !Number.isFinite(age) || age < -300000 || age > 24 * 3600000) {
    throw new Error('The club event feed is missing, invalid, or more than 24 hours old. Check Update calendar on GitHub.');
  }
  const ids = new Set();
  for (const row of feed.events) {
    if (!row.id || ids.has(row.id) || !['active', 'cancelled'].includes(row.status)
        || !Number.isFinite(Date.parse(row.start)) || Date.parse(row.end) <= Date.parse(row.start)
        || !Number.isFinite(Date.parse(row.end))) throw new Error('The club feed contains an invalid or duplicate occurrence.');
    ids.add(row.id);
    if (row.status === 'active' && ['title', 'location', 'marker', 'fingerprint'].some(key => typeof row[key] !== 'string' || !row[key].trim())) {
      throw new Error('A public club event is incomplete.');
    }
    if (row.status === 'active' && (typeof row.description !== 'string' || !/^LCCC-[a-f0-9]{24}$/.test(row.marker))) {
      throw new Error('A public club event has an invalid description or identity marker.');
    }
  }
  return feed;
}

export function formData(row) {
  const date = value => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', year: 'numeric', month: 'short', day: 'numeric',
  }).format(new Date(value));
  const time = value => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(value));
  const timeZone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', timeZoneName: 'short' })
    .formatToParts(new Date(row.start)).find(part => part.type === 'timeZoneName').value;
  return { ...row, timeZone, startDate: date(row.start), startTime: time(row.start), endDate: date(row.end), endTime: time(row.end),
    body: `${row.description}\n\nCalendar reference: ${row.marker}` };
}

export function emptyState(groupUrl) {
  return { version: 1, groupUrl, events: {}, pending: null };
}

export function validateState(state, groupUrl) {
  if (state?.version !== 1 || !isGroupUrl(groupUrl) || state.groupUrl !== groupUrl || !state.events || Array.isArray(state.events)) {
    throw new Error('Saved receipts belong to a different group or have an invalid format.');
  }
  const urls = new Set();
  for (const [id, receipt] of Object.entries(state.events)) {
    if (receipt.data?.id !== id || !isEventUrl(receipt.url) || !['active', 'cancelled'].includes(receipt.status)
        || !Number.isFinite(Date.parse(receipt.data.start)) || urls.has(receipt.url)) throw new Error('A saved Facebook receipt is invalid or duplicated.');
    urls.add(receipt.url);
  }
}

export function plan(feed, state, groupUrl, now = new Date(), daysAhead = 30) {
  validateFeed(feed, now);
  validateState(state, groupUrl);
  if (state.pending) throw new Error('A Facebook submission needs review. Open its tab before retrying.');
  if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > 90) throw new Error('Choose a horizon of 1 to 90 days.');
  const current = new Map(feed.events.map(row => [row.id, row]));
  for (const [id, receipt] of Object.entries(state.events)) {
    if (new Date(receipt.data.start) > now && !current.has(id)) {
      throw new Error('A tracked occurrence is absent from the feed. Publishing has stopped; absence is not cancellation.');
    }
  }
  const actions = [];
  for (const row of current.values()) {
    const previous = state.events[row.id];
    if (row.status === 'cancelled') {
      if (previous?.status === 'active' && new Date(previous.data.start) > now) {
        actions.push({ kind: 'cancel', data: previous.data, url: previous.url });
      }
      continue;
    }
    if (new Date(row.start) <= now) continue;
    if (!previous || previous.status === 'cancelled') {
      if (Date.parse(row.start) < +now + daysAhead * 86400000) actions.push({ kind: 'create', data: formData(row) });
    } else if (previous.data.fingerprint !== row.fingerprint) {
      actions.push({ kind: 'update', data: formData(row), url: previous.url });
    }
  }
  return actions.sort((a, b) => (a.kind === 'cancel' ? -1 : 0) - (b.kind === 'cancel' ? -1 : 0)
    || a.data.start.localeCompare(b.data.start) || a.data.id.localeCompare(b.data.id));
}

export function validateRecipes(ui, kinds = ['create', 'update', 'cancel']) {
  if (!ui?.authenticatedSelector) throw new Error('Facebook form setup is incomplete. Inspect the signed-in group first.');
  for (const kind of new Set(kinds)) {
    const recipe = ui[kind];
    if (!recipe || !Array.isArray(recipe.open) || !Array.isArray(recipe.commit) || !recipe.commit.length || !recipe.groupSelector) {
      throw new Error(`The Facebook ${kind} form has not been configured.`);
    }
    for (const step of [...recipe.open, ...recipe.commit, ...(recipe.read || []), ...(recipe.identify || []), ...Object.values(recipe.afterFill || {}).flat()]) {
      if (!['click', 'fill', 'press', 'wait'].includes(step.action) || !step.selector
          || (['fill', 'press'].includes(step.action) && typeof step.value !== 'string')) throw new Error('A Facebook form step is invalid.');
    }
    if (recipe.commit.some(step => step.action !== 'click')) throw new Error('Submission steps must be explicit clicks.');
    if (kind === 'cancel') {
      if (!recipe.cancelledSelector || !recipe.cancelledText || !recipe.identitySelector) throw new Error('Cancellation needs identity and confirmation selectors.');
    } else {
      if (!recipe.timeZoneSelector || !recipe.timeZoneText) throw new Error(`${kind} needs a visible Mountain Time check.`);
      for (const field of FORM_FIELDS) {
        if (!recipe.fields?.[field] || !recipe.verify?.[field]) throw new Error(`${kind} needs form and verification selectors for ${field}.`);
      }
      if (kind === 'update' && !recipe.identitySelector) throw new Error('Updates need a calendar identity selector.');
    }
  }
}

export async function execute(actions, state, driver, save, limit = 1) {
  if (state.pending) throw new Error('Review the pending submission before syncing.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('A run can apply 1 to 3 changes.');
  for (const action of actions.slice(0, limit)) {
    state.pending = action;
    await save(state);
    const result = await driver(action);
    if (!isEventUrl(result?.url)) throw new Error('Facebook did not confirm an event URL.');
    const previous = state.events[action.data.id];
    state.events[action.data.id] = { data: action.data, url: result.url,
      status: action.kind === 'cancel' ? 'cancelled' : 'active',
      ...(previous?.url && previous.url !== result.url ? { previousUrl: previous.url } : {}) };
    state.pending = null;
    await save(state);
  }
}
