import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { facebookUI } from '../tools/facebook-sync/facebook-ui.js';
import { syncNow } from '../tools/facebook-sync/manual-sync.js';
import { CALENDAR, FORM_FIELDS, emptyState, validateFeed, validateState, formData, plan, execute, validateRecipes, trustedExtensionSender } from '../tools/facebook-sync/core.js';

const now = new Date('2026-11-12T20:00:00Z');
const group = 'https://www.facebook.com/groups/123456/';
const row = (extra = {}) => ({ id: 'series_20261116', status: 'active', title: 'Club night', description: 'Welcome.',
  location: 'Peak Community Church', start: '2026-11-16T18:30:00-07:00', end: '2026-11-16T21:30:00-07:00',
  marker: `LCCC-${'a'.repeat(24)}`, fingerprint: 'a'.repeat(64), ...extra });
const feed = (rows = [row()]) => ({ schema: 1, calendarId: CALENDAR, generatedAt: now.toISOString(), events: rows });
const receipt = (data = row()) => ({ data: formData(data), status: 'active', url: 'https://www.facebook.com/events/123456/' });
const state = () => ({ ...emptyState(group), events: { [row().id]: receipt() } });

test('one manual sync drains every pending batch and finishes without scheduling another run', async () => {
  let remaining=7;
  const progress=[];
  const commands=[];
  const result=await syncNow(async (command, options) => {
    commands.push(command);
    if(command==='preview') return {actions:Array.from({length:remaining},()=>({kind:'create'}))};
    assert.equal(command,'apply');
    assert.deepEqual(options,{batch:true});
    const applied=Math.min(3,remaining);
    remaining-=applied;
    return {applied};
  }, update=>progress.push(update));
  assert.deepEqual(result,{applied:7});
  assert.deepEqual(commands,['preview','apply','preview','apply','preview','apply','preview']);
  assert.deepEqual(progress.at(-1),{applied:7,remaining:0});
});

test('manual sync leaves matched calendars alone and stops immediately after a failed batch', async () => {
  assert.deepEqual(await syncNow(async command=>{assert.equal(command,'preview');return {actions:[]};}),{applied:0});
  let calls=0;
  await assert.rejects(syncNow(async command=>{
    calls++;
    if(command==='preview')return {actions:[{}]};
    throw new Error('Saved Facebook startDate differs from the calendar.');
  }),/Saved Facebook/);
  assert.equal(calls,2);
  await assert.rejects(syncNow(async command=>command==='preview'?{actions:[{}]}:{applied:0}),/no progress/);
});

test('fresh public feeds are accepted; stale, future, or incomplete feeds stop syncing', () => {
  validateFeed(feed(), now);
  for (const generatedAt of ['invalid', '2026-11-10T20:00:00Z', '2026-11-13T20:00:00Z']) {
    assert.throws(() => validateFeed({ ...feed(), generatedAt }, now), /feed/);
  }
  assert.throws(() => validateFeed(feed([row(), row()]), now), /duplicate/);
  assert.throws(() => validateFeed(feed([row({ marker: '' })]), now), /incomplete/);
  assert.throws(() => validateFeed(feed([row({ end: 'nonsense' })]), now), /invalid/);
  assert.throws(() => validateFeed({ ...feed(), calendarId: 'other' }, now), /feed/);
});

test('dates use Mountain Time on both sides of daylight saving', () => {
  assert.equal(formData(row()).startDate, 'Nov 16, 2026');
  assert.equal(formData(row()).startTime, '6:30 PM');
  assert.equal(formData(row()).timeZone, 'MST');
  assert.equal(formData(row({ start: '2027-07-12T18:30:00-06:00' })).timeZone, 'MDT');
  assert.equal(formData(row({ start: '2027-07-12T18:30:00-06:00', end: '2027-07-12T21:30:00-06:00' })).startTime, '6:30 PM');
  assert.ok(formData(row()).body.endsWith(row().marker));
});

test('settings tabs and popups can message the worker, while content scripts cannot', () => {
  const id = 'testextension';
  assert.equal(trustedExtensionSender({ id, url: `chrome-extension://${id}/options.html`, tab: { id: 123 } }, id), true);
  assert.equal(trustedExtensionSender({ id, url: `chrome-extension://${id}/popup.html` }, id), true);
  assert.equal(trustedExtensionSender({ id, url: 'https://www.facebook.com/', tab: { id: 123 } }, id), false);
  assert.equal(trustedExtensionSender({ id: 'other', url: `chrome-extension://${id}/options.html` }, id), false);
  assert.equal(trustedExtensionSender({ id, url: `chrome-extension://${id}.evil/options.html` }, id), false);
  assert.equal(trustedExtensionSender({ id }, id), false);
});

test('first sync creates occurrences and repeats do not duplicate them', () => {
  assert.deepEqual(plan(feed(), emptyState(group), group, now).map(a => a.kind), ['create']);
  assert.deepEqual(plan(feed(), state(), group, now), []);
  const outside = row({ start: '2027-07-12T18:30:00-06:00', end: '2027-07-12T21:30:00-06:00' });
  assert.deepEqual(plan(feed([outside]), emptyState(group), group, now), []);
});

test('renamed and rescheduled occurrences update the same Facebook event outside the creation horizon', () => {
  const moved = row({ title: 'New title', fingerprint: 'b'.repeat(64), start: '2027-07-12T18:30:00-06:00', end: '2027-07-12T21:30:00-06:00' });
  const actions = plan(feed([moved]), state(), group, now);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'update');
  assert.equal(actions[0].url, receipt().url);
  assert.equal(actions[0].data.id, row().id);
});

test('only explicit cancellation retracts a future event; absence stops publishing', () => {
  const cancelled = { id: row().id, status: 'cancelled', start: row().start, end: row().end };
  assert.deepEqual(plan(feed([cancelled]), state(), group, now).map(a => a.kind), ['cancel']);
  assert.throws(() => plan(feed([]), state(), group, now), /absence is not cancellation/);
  const saved = state();
  saved.events[row().id].status = 'cancelled';
  assert.deepEqual(plan(feed([cancelled]), saved, group, now), []);
  assert.deepEqual(plan(feed(), saved, group, now).map(a => a.kind), ['create']);
});

test('past occurrences are left alone and receipts cannot switch groups', () => {
  const previous = state();
  previous.events[row().id].data.start = '2026-11-01T18:30:00-07:00';
  assert.deepEqual(plan(feed([]), previous, group, now), []);
  assert.throws(() => validateState(state(), 'https://www.facebook.com/groups/other/'), /different group/);
  const invalid = state();
  invalid.events[row().id].url = 'https://example.com/events/123/';
  assert.throws(() => validateState(invalid, group), /receipt/);
});

test('an interrupted click keeps its journal and blocks the next sync', async () => {
  const previous = emptyState(group);
  const saved = [];
  await assert.rejects(execute(plan(feed(), previous, group, now), previous, async () => {
    assert.ok(saved.at(-1).pending);
    throw new Error('Tab disconnected');
  }, async value => saved.push(structuredClone(value))), /disconnected/);
  assert.equal(saved.at(-1).pending.kind, 'create');
  assert.throws(() => plan(feed(), previous, group, now), /needs review/);
});

test('verified writes save receipts individually and obey the run limit', async () => {
  const previous = emptyState(group);
  const many = feed([row(), row({ id: 'second' })]);
  let calls = 0;
  await execute(plan(many, previous, group, now), previous, async () => {
    calls++;
    return { url: 'https://www.facebook.com/events/123456/' };
  }, async () => {}, 1);
  assert.equal(calls, 1);
  assert.equal(previous.pending, null);
  assert.equal(plan(many, previous, group, now).length, 1);
});

test('unverified results cannot clear the pending journal', async () => {
  const previous = emptyState(group);
  await assert.rejects(execute(plan(feed(), previous, group, now), previous,
    async () => ({ url: 'https://example.com/events/1/' }), async () => {}), /confirm an event URL/);
  assert.ok(previous.pending);
});

test('browser recipes require every form field and a separate saved-value verification', () => {
  validateRecipes(facebookUI);
  assert.equal(facebookUI.verified, false);
  const fields = Object.fromEntries(FORM_FIELDS.map(field => [field, `#${field}`]));
  const recipe = () => ({ open: [], commit: [{ action: 'click', selector: '#submit' }],
    fields: { ...fields }, verify: { ...fields }, groupSelector: '#group', identitySelector: '#identity',
    timeZoneSelector: '#time-zone', timeZoneText: 'Mountain Time' });
  const ui = { authenticatedSelector: '#account', create: recipe(), update: recipe(),
    cancel: { ...recipe(), cancelledSelector: '#status', cancelledText: 'Cancelled' } };
  validateRecipes(ui);
  validateRecipes({authenticatedSelector:'#account', create:recipe()}, ['create']);
  assert.throws(() => validateRecipes({authenticatedSelector:'#account', create:recipe()}), /update/);
  delete ui.create.verify.endTime;
  assert.throws(() => validateRecipes(ui), /endTime/);
  assert.throws(() => validateRecipes({}), /setup is incomplete/);
});

test('Facebook labels survive character counters and nested autocomplete options remain unique', async () => {
  const context = {};
  runInNewContext(await readFile(new URL('../tools/facebook-sync/selectors.js', import.meta.url), 'utf8'), context);
  const input = { labels:[{innerText:'Event name\n27/100'}],getAttribute:()=>null };
  const other = { labels:[{innerText:'Start date'}],getAttribute:()=>null };
  const root = {querySelectorAll:()=>[input,other],getElementById:()=>null};
  assert.deepEqual(Array.from(context.LCCCSelectors.query(root,'label=Event name')), [input]);
  const inner = {innerText:'Just use "Peak"',contains:()=>false};
  const outer = {innerText:'Just use "Peak"',contains:el=>el===inner};
  root.querySelectorAll = ()=>[outer,inner];
  assert.deepEqual(Array.from(context.LCCCSelectors.query(root,'option=Just use "Peak"')), [outer]);
  root.querySelectorAll = () => [{innerText:'Event canceled',contains:()=>false},{innerText:'Delete event',contains:()=>false}];
  assert.equal(context.LCCCSelectors.query(root,'cancelled-status').length, 1);
});

test('date widgets receive their input render before blur commits the saved value', async () => {
  class Input {
    constructor() { this.current='Nov 12, 2026'; this.buffer=this.current; this.persisted=this.current; }
    get value() { return this.current; }
    set value(value) { this.current=value; }
    getClientRects() { return [1]; }
    focus() {}
    dispatchEvent(event) { if(event.type==='input') { const value=this.value; setTimeout(()=>{this.buffer=value;},10); } }
    blur() { this.persisted=this.buffer; }
  }
  const date=new Input();
  const account={getClientRects:()=>[1]};
  const zone={value:'MST',getClientRects:()=>[1]};
  let receive;
  const context={setTimeout,Date,Event:class {constructor(type){this.type=type;}},
    Intl:{DateTimeFormat:()=>({resolvedOptions:()=>({timeZone:'America/Denver'})})},
    location:{origin:'https://www.facebook.com',pathname:'/events/create/'},getComputedStyle:()=>({visibility:'visible'}),
    document:{querySelectorAll:selector=>({'#date':[date],'#account':[account],'#zone':[zone]})[selector]||[]},
    chrome:{runtime:{id:'extension',onMessage:{addListener:listener=>{receive=listener;}}}}};
  runInNewContext(await readFile(new URL('../tools/facebook-sync/selectors.js',import.meta.url),'utf8'),context);
  runInNewContext(await readFile(new URL('../tools/facebook-sync/content.js',import.meta.url),'utf8'),context);
  const response=await new Promise(resolve=>receive({scope:'lccc-event-sync',command:'prepare',fields:['startDate'],
    ui:{authenticatedSelector:'#account',create:{open:[],fields:{startDate:'#date'},timeZoneSelector:'#zone',timeZoneText:'MST'}},
    action:{kind:'create',data:{startDate:'Nov 21, 2026'}}},{id:'extension'},resolve));
  assert.equal(response.ok,true);
  assert.equal(date.persisted,'Nov 21, 2026');
  const wrongZone=await new Promise(resolve=>receive({scope:'lccc-event-sync',command:'prepare',fields:['startDate'],
    ui:{authenticatedSelector:'#account',create:{open:[],fields:{startDate:'#date'},timeZoneSelector:'#zone',timeZoneText:'MDT'}},
    action:{kind:'create',data:{startDate:'Nov 21, 2026'}}},{id:'extension'},resolve));
  assert.equal(wrongZone.ok,false);
  assert.match(wrongZone.error,/Mountain Time/);
  date.blur=()=>{date.current='Nov 12, 2026';};
  const rejected=await new Promise(resolve=>receive({scope:'lccc-event-sync',command:'prepare',fields:['startDate'],
    ui:{authenticatedSelector:'#account',create:{open:[],fields:{startDate:'#date'},timeZoneSelector:'#zone',timeZoneText:'MST'}},
    action:{kind:'create',data:{startDate:'Nov 22, 2026'}}},{id:'extension'},resolve));
  assert.equal(rejected.ok,false);
  assert.match(rejected.error,/rejected startDate/);
});

test('extension permissions do not include cookies, passwords, remote code, or broad web access', async () => {
  const manifest = JSON.parse(await readFile(new URL('../tools/facebook-sync/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['https://www.facebook.com/*', 'https://larimerchess.org/*']);
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.equal(manifest.externally_connectable, undefined);
  for (const file of ['popup.html', 'options.html']) {
    const html = await readFile(new URL(`../tools/facebook-sync/${file}`, import.meta.url), 'utf8');
    assert.ok(!/<script[^>]*src="https?:/i.test(html));
  }
});
