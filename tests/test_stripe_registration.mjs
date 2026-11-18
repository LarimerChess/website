import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function fixture() {
  const ctx = vm.createContext({ console, Date, Set });
  vm.runInContext(readFileSync(new URL('../scripts/registration.gs', import.meta.url), 'utf8'), ctx);
  const config = { enabled: true, livemode: true, currency: 'usd', entry: { amount: 1750, paymentLinkId: 'plink_entry', url: 'https://buy.stripe.com/test_123' }, donation: { paymentLinkId: 'plink_donation' } };
  const entry = { Event: 'chess', Date: '2026-12-01', 'US Chess ID': '12345678', Name: 'Player', Token: 'private-withdraw-token', 'Payment reference': 'payment-reference', Amount: '17.50', Discount: '', 'Rating fee': '2.50', Status: 'registered', Paid: '' };
  const col = Object.fromEntries(Object.keys(entry).concat(['Paid on', 'Paid by', 'Payment review']).map((k, i) => [k, i]));
  let failRepair = false;
  const book = { rows: [] }, tabs = {};
  ctx.readEntries = () => ({ col, rows: [Object.keys(col).map(k => entry[k] || '')], sheet: { getRange: (_r, c) => { const range = { setNumberFormat: () => range, setValue: v => { if (failRepair) { failRepair = false; throw Error('interrupted'); } entry[Object.keys(col)[c-1]] = v; } }; return range; } } });
  ctx.readPayments = () => book;
  ctx.addPayment = (_book, token, party, fields) => book.rows.push({ 'No.': String(book.rows.length+1), Token: token, ...party, Recorded: 'now', ...Object.fromEntries(Object.entries(fields).map(([k,v]) => [k, typeof v === 'number' ? String(v/100) : v])) });
  ctx.readTab = (name, headers) => {
    tabs[name] ||= [];
    return { sheet: tabs[name], col: Object.fromEntries(headers.map((h,i) => [h,i])), rows: tabs[name] };
  };
  ctx.appendText = (sheet, cols, row) => sheet.push(Object.keys(cols).map(k => row[k] || ''));
  ctx.stripeConfig = () => config;
  ctx.underLimit = () => true;
  ctx.Utilities = { formatDate: (date) => date.toISOString().slice(0,10) };
  ctx.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'a'.repeat(32) }) };
  ctx.clearEntriesCache = () => {};
  const record = { created: 1700000000, sessionId: 'cs_test_123', paymentIntentId: 'pi_123', paymentLinkId: 'plink_entry', clientReferenceId: 'payment-reference', amountCents: 1750, currency: 'usd', livemode: true, kind: 'entry', refundCents: 0, disputed: false, paymentStatus: 'paid', status: 'complete' };
  return { ctx, config, entry, book, tabs, record, interrupt: () => { failRepair = true; } };
}

test('guest link targets payment reference and discloses no withdrawal token or contacts', () => {
  const f = fixture();
  const result = f.ctx.stripePaymentLink({event:'chess',date:'2026-12-01',id:'12345678'});
  assert.equal(result.url, 'https://buy.stripe.com/test_123?client_reference_id=payment-reference');
  assert.ok(!JSON.stringify(result).includes('private-withdraw-token'));
  f.entry.Discount = '1';
  assert.ok(f.ctx.stripePaymentLink({event:'chess',date:'2026-12-01',id:'12345678'}).error);
});

test('gross $17.50 credits full entry, rating first, exactly once', () => {
  const f = fixture();
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'imported');
  assert.equal(f.book.rows[0]['Entry fee'],'15');
  assert.equal(f.book.rows[0]['Rating fee'],'2.5');
  assert.equal(f.entry.Paid,'17.50');
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'duplicate');
  assert.equal(f.book.rows.length,1);
});

test('retry repairs entry after durable ledger append and interrupted summary update', () => {
  const f = fixture(); f.interrupt();
  assert.throws(() => f.ctx.stripeImport(f.record,f.config), /interrupted/);
  assert.equal(f.book.rows.length,1);
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'duplicate');
  assert.equal(f.entry.Paid,'17.50');
  assert.equal(f.book.rows.length,1);
});

test('invalid, unpaid, wrong mode/link/reference, and overpaid records never credit', () => {
  for (const patch of [{paymentStatus:'unpaid'}, {livemode:false}, {paymentLinkId:'plink_other'}, {clientReferenceId:'missing'}, {amountCents:1800}, {currency:'eur'}, {disputed:true}]) {
    const f=fixture();
    assert.equal(f.ctx.stripeImport({...f.record,...patch},f.config).status,'review');
    assert.equal(f.book.rows.length,0);
  }
  const f=fixture(); f.entry.Discount='5';
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'review');
});

test('test payments and refunds stay isolated from real ledger', () => {
  const f=fixture(); f.config.livemode=false; f.record.livemode=false;
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'test');
  f.ctx.stripeImport(f.record,f.config);
  assert.equal(f.tabs['Stripe test payments'].length,1);
  assert.equal(f.ctx.stripeImport({...f.record,refundCents:100},f.config).status,'review');
  assert.equal(f.book.rows.length,0);
  assert.equal(f.entry.Paid,'');
});

test('refund after import preserves financial facts and flags reconciliation', () => {
  const f=fixture(); f.ctx.stripeImport(f.record,f.config);
  const refunded={...f.record,refundCents:100};
  f.ctx.stripeImport(refunded,f.config); f.ctx.stripeImport(refunded,f.config);
  assert.equal(f.book.rows.length,1);
  assert.equal(f.entry.Paid,'17.50');
  assert.match(f.entry['Payment review'], /reconciliation/);
  assert.equal(f.tabs['Stripe review'].length,1);
});

test('donations do not create named contacts or player credit', () => {
  const f=fixture();
  f.ctx.stripeImport({...f.record,kind:'donation',paymentLinkId:'plink_donation',clientReferenceId:''},f.config);
  assert.equal(f.book.rows[0].Name,'Anonymous');
  assert.equal(f.book.rows[0].Token,'');
  assert.equal(f.book.rows[0].Donation,'17.5');
  assert.equal(f.entry.Paid,'');
});

test('dedicated authentication is required before config or ledger access', () => {
  const f=fixture(); f.ctx.stripeConfig=()=>{throw Error('must not fetch');};
  assert.ok(f.ctx.stripeSync({syncSecret:'wrong',records:'[]'}).error);
  assert.equal(f.book.rows.length,0);
});

test('test mode exercises reference and amount validation without accepting bad fixtures', () => {
  for (const patch of [{clientReferenceId:'unknown'}, {amountCents:2000}]) {
    const f=fixture(); f.config.livemode=false;
    assert.equal(f.ctx.stripeImport({...f.record,livemode:false,...patch},f.config).status,'review');
    assert.equal(f.book.rows.length,0);
    assert.equal(f.tabs['Stripe test payments'],undefined);
  }
});

test('a second payer cannot overcredit the same entry', () => {
  const f=fixture(); f.ctx.stripeImport(f.record,f.config);
  assert.equal(f.ctx.stripeImport({...f.record,sessionId:'cs_second',paymentIntentId:'pi_second'},f.config).status,'review');
  assert.equal(f.book.rows.length,1);
});

test('resolved refund snapshots stay resolved and changed refunds or disputes reopen review', () => {
  const f=fixture(); f.ctx.stripeImport(f.record,f.config);
  const refunded={...f.record,refundCents:100};
  f.ctx.stripeImport(refunded,f.config);
  f.tabs['Stripe review'][0][4]='resolved';
  f.entry['Payment review']='';
  assert.equal(f.ctx.stripeImport(refunded,f.config).status,'duplicate');
  assert.equal(f.entry['Payment review'],'');
  assert.equal(f.ctx.stripeImport({...refunded,refundCents:200},f.config).status,'review');
  assert.equal(f.tabs['Stripe review'].length,2);
  f.tabs['Stripe review'][1][4]='resolved';
  assert.equal(f.ctx.stripeImport({...refunded,refundCents:200,disputed:true},f.config).status,'review');
  assert.equal(f.tabs['Stripe review'].length,3);
  assert.equal(f.book.rows.length,1);
});

test('a closed dispute needs its own review even after the open dispute was resolved', () => {
  const f=fixture(); f.ctx.stripeImport(f.record,f.config);
  f.ctx.stripeImport({...f.record,disputed:true},f.config);
  f.tabs['Stripe review'][0][4]='resolved'; f.entry['Payment review']='';
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'review');
  assert.equal(f.tabs['Stripe review'].length,2);
});

test('refunded entries cannot be paid again and delayed donations retain payment date', () => {
  const f=fixture();
  f.book.rows.push({'No.':'1',Token:f.entry.Token,Type:'refund',Received:'-17.50','Entry fee':'0','Rating fee':'0'});
  assert.ok(f.ctx.stripePaymentLink({event:'chess',date:'2026-12-01',id:'12345678'}).error);
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'review');
  const donation=fixture();
  donation.ctx.stripeImport({...donation.record,kind:'donation',paymentLinkId:'plink_donation'},donation.config);
  assert.equal(donation.book.rows[0].Date,'2023-11-14');
  assert.equal(donation.ctx.stripeImport({...donation.record,created:0},donation.config).status,'review');
});

test('resolved reversals before import and in test mode skip without credit', () => {
  for (const live of [true,false]) {
    const f=fixture(); f.config.livemode=live;
    const reversed={...f.record,livemode:live,refundCents:1750};
    assert.equal(f.ctx.stripeImport(reversed,f.config).status,'review');
    f.tabs[live ? 'Stripe review' : 'Stripe test review'][0][4]='resolved';
    assert.equal(f.ctx.stripeImport(reversed,f.config).status,'duplicate');
    assert.equal(f.book.rows.length,0);
    assert.equal(f.ctx.stripeImport({...reversed,disputed:true},f.config).status,'review');
  }
});

test('public balance lookup includes all active dates, credits, refunds, unknown fees and only safe fields', () => {
  const f=fixture();
  const people=[
    {...f.entry,Event:'old-event',Date:'2024-01-01',Token:'old',Amount:'20',Discount:'2',Email:'secret@example.com'},
    {...f.entry,Token:'paid'},
    {...f.entry,Event:'month',Date:'2027-01',Token:'month'},
    {...f.entry,Event:'month',Date:'2027-01-04',Token:'moved',Status:'moved to month'},
    {...f.entry,Token:'withdrawn',Status:'withdrawn'},
    {...f.entry,Event:'unknown',Token:'unknown',Amount:''},
    {...f.entry,Event:'refund',Token:'refund','Payment review':'private reason'},
    {...f.entry,Token:'other','US Chess ID':'87654321'},
  ];
  const keys=[...new Set(people.flatMap(Object.keys))];
  f.ctx.readEntries=()=>({col:Object.fromEntries(keys.map((k,i)=>[k,i])),rows:people.map(p=>keys.map(k=>p[k]||''))});
  f.ctx.clubEvents=()=>({'month/2027-01':{name:'January Club Nights'}});
  f.ctx.stripeConfig=()=>{throw Error('disabled configuration must not affect lookup');};
  f.book.rows.push(
    {Token:'old',Type:'payment','Entry fee':'3','Rating fee':'2.5'},
    {Token:'paid',Type:'payment','Entry fee':'15','Rating fee':'2.5'},
    {Token:'month',Type:'credit','Entry fee':'5','Rating fee':'2.5'},
    {Token:'refund',Type:'payment','Entry fee':'15','Rating fee':'2.5'},
    {Token:'refund',Type:'refund',Received:'-17.5','Entry fee':'-15','Rating fee':'-2.5'},
  );
  const result=f.ctx.paymentBalances({id:'12345678'});
  assert.equal(result.entries.length,5);
  const amounts=Object.fromEntries(result.entries.map(e=>[e.event,e.balanceCents]));
  assert.deepEqual(amounts,{'old-event':1250,chess:0,month:1000,unknown:null,refund:0});
  assert.equal(result.totalCents,2250);
  assert.equal(result.unknownCount,1);
  assert.equal(result.entries.find(e=>e.event==='refund').review,true);
  assert.equal(result.entries.find(e=>e.event==='month').name,'January Club Nights');
  assert.equal(result.entries[0].name,'Old Event');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!JSON.stringify(result).includes('secret@example.com'));
  for(const entry of result.entries) assert.deepEqual(Object.keys(entry).sort(),['balanceCents','date','event','name','review']);
});

test('balance lookup rejects malformed IDs and rate limits before reading private sheets', () => {
  const f=fixture();f.ctx.readEntries=()=>{throw Error('must not read');};
  for(const id of ['123','1234567x','123456789','']) assert.ok(f.ctx.paymentBalances({id}).error);
  f.ctx.underLimit=()=>false;
  assert.ok(f.ctx.paymentBalances({id:'12345678'}).error);
});

test('legacy paid totals without ledger and nonfinite amounts cannot become fresh debt', () => {
  for (const patch of [{Paid:'17.50'}, {Paid:'nonsense'}, {Amount:'Infinity'}, {Discount:'invalid'}]) {
    const f=fixture();Object.assign(f.entry,patch);f.ctx.clubEvents=()=>({});
    const result=f.ctx.paymentBalances({id:'12345678'});
    assert.equal(result.entries[0].balanceCents,null);
    assert.equal(result.entries[0].review,true);
    assert.equal(result.totalCents,0);
    assert.ok(f.ctx.stripePaymentLink({event:'chess',date:'2026-12-01',id:'12345678'}).error);
    assert.equal(f.ctx.stripeImport(f.record,f.config).status,'review');
    assert.equal(f.book.rows.length,0);
  }
  const f=fixture();f.ctx.clubEvents=()=>({});
  f.book.rows.push({Token:f.entry.Token,'Entry fee':'NaN'});
  assert.equal(f.ctx.paymentBalances({id:'12345678'}).entries[0].balanceCents,null);
});
function basketFixture(testMode = false) {
  const f = fixture();
  f.config.dynamicCheckout = { enabled: true };
  f.config.livemode = !testMode;
  const second = { ...f.entry, Token: 'second-token', Name: 'Second', 'US Chess ID': '87654321', Amount: '12.50', 'Rating fee': '0' };
  const entries = [f.entry, second];
  const keys = Object.keys(f.ctx.readEntries().col), col = Object.fromEntries(keys.map((k,i) => [k,i]));
  f.ctx.readEntries = () => ({ col, rows: entries.map(e => keys.map(k => e[k] || '')), sheet: { getRange: (r,c) => { const range = { setNumberFormat: () => range, setValue: v => { entries[r-2][keys[c-1]] = v; } }; return range; } } });
  const allocations = entries.map(e => ({ token: e.Token, party: Object.fromEntries(['Event','Date','US Chess ID','Name'].map(k => [k,e[k]])), amount: Math.round(Number(e.Amount)*100), rating: Math.round(Number(e['Rating fee'])*100) }));
  f.tabs['Stripe checkout baskets'] = [['basket-ref',String(!testMode),'3000',JSON.stringify(allocations),'cs_test_123','']];
  f.record = { ...f.record, checkoutType: 'basket_v1', paymentLinkId: '', clientReferenceId: 'basket-ref', amountCents: 3000, livemode: !testMode };
  return { ...f, second, allocations };
}

test('one basket payment credits exact separate player allocations once', () => {
  const f = basketFixture();
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'imported');
  assert.deepEqual(f.book.rows.map(r => r.Received),['17.5','12.5']);
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'duplicate');
  assert.equal(f.book.rows.length,2);
  assert.equal(f.second.Paid,'12.50');
});

test('basket validates every balance before any credit and rejects wrong amounts or sessions', () => {
  for (const patch of [{amountCents:2999}, {sessionId:'cs_other'}, {clientReferenceId:'unknown'}, {livemode:false}, {refundCents:100}]) {
    const f=basketFixture(); assert.equal(f.ctx.stripeImport({...f.record,...patch},f.config).status,'review'); assert.equal(f.book.rows.length,0);
  }
  const f=basketFixture(); f.second.Discount='1';
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'review'); assert.equal(f.book.rows.length,0);
});

test('basket resumes after first durable allocation without duplicating it', () => {
  const f=basketFixture(), append=f.ctx.addPayment; let count=0;
  f.ctx.addPayment=(...args) => { if (++count===2) throw Error('interrupted append'); return append(...args); };
  assert.throws(() => f.ctx.stripeImport(f.record,f.config),/interrupted append/);
  assert.equal(f.book.rows.length,1);
  f.ctx.addPayment=append;
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'imported');
  assert.equal(f.book.rows.length,2);
  assert.equal(f.entry.Paid,'17.50'); assert.equal(f.second.Paid,'12.50');
});

test('sandbox combined payment is isolated and repeated sync is idempotent', () => {
  const f=basketFixture(true);
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'test');
  assert.equal(f.ctx.stripeImport(f.record,f.config).status,'test');
  assert.equal(f.tabs['Stripe test payments'].length,1);
  assert.equal(f.book.rows.length,0); assert.equal(f.entry.Paid,''); assert.equal(f.second.Paid,'');
});

test('basket refund flags every affected player without changing ledger credit', () => {
  const f=basketFixture(); f.ctx.stripeImport(f.record,f.config);
  assert.equal(f.ctx.stripeImport({...f.record,refundCents:100},f.config).status,'review');
  assert.match(f.entry['Payment review'],/reconciliation/); assert.match(f.second['Payment review'],/reconciliation/);
  assert.equal(f.book.rows.length,2);
});

test('basket creation recalculates fees, sends only opaque reference and reuses network retry', () => {
  const f=basketFixture(true), rows=[]; let calls=0, sent;
  const headers=['Reference','Mode','Amount','Allocations','Session','URL','Checkout request'], col=Object.fromEntries(headers.map((h,i)=>[h,i]));
  const sheet={getRange:(r,c)=>{const range={setNumberFormat:()=>range,setValue:v=>{rows[r-2][c-1]=v;}};return range;}};
  f.ctx.stripeBaskets=()=>({sheet,col,rows:rows.map(r=>[...r])});
  const append=f.ctx.appendText;
  f.ctx.appendText=(target,cols,row)=>target===sheet?rows.push(headers.map(h=>row[h]||'')):append(target,cols,row);
  f.ctx.PropertiesService={getScriptProperties:()=>({getProperty:()=> 'sk_test_fixture'})};
  f.ctx.UrlFetchApp={fetch:(url,options)=>{calls++;sent=options;return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({id:'cs_test_123',url:'https://checkout.stripe.com/c/pay/cs_test_123',livemode:false,amount_total:3000,client_reference_id:'request_abcdefghijklmnop'})};}};
  const p={requestId:'request_abcdefghijklmnop',entries:JSON.stringify([{id:'12345678',event:'chess',date:'2026-12-01',amount:1},{id:'87654321',event:'chess',date:'2026-12-01',amount:1}])};
  assert.equal(f.ctx.createPaymentCheckout(p).amount,3000);
  assert.equal(sent.payload['line_items[0][price_data][unit_amount]'],'3000');
  assert.equal(sent.payload['allowed_payment_method_types[0]'],'card');
  assert.ok(!('payment_method_types[0]' in sent.payload));
  assert.ok(!JSON.stringify(sent.payload).includes('12345678'));
  assert.ok(!JSON.stringify(sent.payload).includes('private-withdraw-token'));
  assert.equal(f.ctx.createPaymentCheckout(p).amount,3000);assert.equal(calls,1);assert.equal(rows.length,1);
  f.second.Discount='1';assert.match(f.ctx.createPaymentCheckout(p).error,/Balances changed/);
});

test('basket creation refuses mode mismatch and duplicate selections before creating checkout', () => {
  const f=basketFixture(true);
  f.ctx.PropertiesService={getScriptProperties:()=>({getProperty:()=> 'sk_live_fixture'})};
  assert.match(f.ctx.createPaymentCheckout({}).error,/payment mode/);
  f.ctx.PropertiesService={getScriptProperties:()=>({getProperty:()=> 'sk_test_fixture'})};
  const e={id:'12345678',event:'chess',date:'2026-12-01'};
  assert.match(f.ctx.createPaymentCheckout({entries:JSON.stringify([e,e])}).error,/duplicate/);
});

function paymentSearchFixture(people) {
  const f = fixture();
  const keys = [...new Set(people.flatMap(Object.keys))];
  f.ctx.readEntries = () => ({ col: Object.fromEntries(keys.map((key, i) => [key, i])),
    rows: people.map(person => keys.map(key => person[key] || '')) });
  for (const helper of ['search', 'lookup', 'contactFor', 'knownPlayer', 'readPayments']) {
    f.ctx[helper] = () => { throw Error('public player search must not call ' + helper); };
  }
  f.ctx.UrlFetchApp = { fetch() { throw Error('public player search must not call US Chess'); },
    fetchAll() { throw Error('public player search must not call US Chess'); } };
  return f;
}

const plain = value => JSON.parse(JSON.stringify(value));

test('payment player search uses latest registration names and discloses only club name and ID', () => {
  const f = paymentSearchFixture([
    { 'US Chess ID': '12345678', Name: 'Obsolete Name', Token: 'private-token', Email: 'secret@example.com' },
    { 'US Chess ID': '12345678', Name: 'Alice Example', Status: 'withdrawn', Phone: '5551234567' },
    { 'US Chess ID': '23456789', Name: 'Alice Other Example', Event: 'private-event' },
    { 'US Chess ID': 'invalid', Name: 'Alice Example' },
    { 'US Chess ID': '1234567', Name: 'Alice Example' },
  ]);
  assert.deepEqual(plain(f.ctx.paymentPlayers({ q: '  aLiCe   EXAMPLE  ' })), {
    ok: true, players: [{ id: '12345678', name: 'Alice Example' }, { id: '23456789', name: 'Alice Other Example' }],
  });
  assert.deepEqual(plain(f.ctx.paymentPlayers({ q: 'obsolete' })), { ok: true, players: [] });
  assert.deepEqual(plain(f.ctx.paymentPlayers({ q: 'alice absent' })), { ok: true, players: [] });
});

test('payment player search uses literal name words and numeric ID prefixes', () => {
  const f = paymentSearchFixture([
    { 'US Chess ID': '12345678', Name: 'Ann [Test]' },
    { 'US Chess ID': '99123456', Name: 'Ann Else' },
    { 'US Chess ID': '87654321', Name: 'Anna Example' },
  ]);
  assert.deepEqual(plain(f.ctx.paymentPlayers({ q: '123' }).players), [{ id: '12345678', name: 'Ann [Test]' }]);
  assert.deepEqual(plain(f.ctx.paymentPlayers({ q: '99123456' }).players), [{ id: '99123456', name: 'Ann Else' }]);
  assert.deepEqual(plain(f.ctx.paymentPlayers({ q: '[test]' }).players), [{ id: '12345678', name: 'Ann [Test]' }]);
  assert.deepEqual(plain(f.ctx.paymentPlayers({ q: '.*' }).players), []);
});

test('payment player search validates query and rate limit before reading registration rows', () => {
  const f = fixture();
  f.ctx.readEntries = () => { throw Error('must reject before reading'); };
  for (const q of ['', 'a', '  a  ']) assert.deepEqual(plain(f.ctx.paymentPlayers({ q })), { ok: true, players: [] });
  assert.ok(f.ctx.paymentPlayers({ q: 'a'.repeat(81) }).error);
  f.ctx.underLimit = () => false;
  assert.ok(f.ctx.paymentPlayers({ q: 'Alice' }).error);
});

test('payment player search caps results at twelve unique players after deduplication', () => {
  const people = Array.from({ length: 15 }, (_, i) => ({ 'US Chess ID': String(12345000 + i), Name: `Club Player ${String(i).padStart(2, '0')}` }));
  const f = paymentSearchFixture(people.flatMap(person => [person, { ...person }]));
  const result = plain(f.ctx.paymentPlayers({ q: 'club' }));
  assert.equal(result.ok, true);
  assert.equal(result.players.length, 12);
  assert.equal(new Set(result.players.map(person => person.id)).size, 12);
  assert.ok(result.players.every(person => Object.keys(person).sort().join(',') === 'id,name'));
  assert.deepEqual(plain(f.ctx.paymentPlayers({ q: 'club' })), result);
});

test('checkout returns safe diagnostics for Stripe permission, HTTP and transport failures without logs or bodies', () => {
  for (const failure of [401, 403, 429, 500, 'transport', 'json', 'configuration', 'storage']) {
    const f = basketFixture(true), logs = [];
    f.ctx.console = { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) };
    f.ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'sk_test_PRIVATEKEY' }) };
    const headers = ['Reference','Mode','Amount','Allocations','Session','URL','Checkout request'];
    f.ctx.stripeBaskets = () => {
      if (failure === 'storage') throw Error('private storage player name');
      return { sheet: [], col: Object.fromEntries(headers.map((h,i) => [h,i])), rows: [] };
    };
    if (failure === 'configuration') f.ctx.stripeConfig = () => { throw Error('private config details'); };
    let bodies = 0;
    f.ctx.UrlFetchApp = { fetch: () => {
      if (failure === 'transport') throw Error('Bearer sk_test_PRIVATEKEY private player name');
      return { getResponseCode: () => failure === 'json' ? 200 : failure,
        getContentText: () => { bodies++; return 'private Stripe response sk_test_PRIVATEKEY'; } };
    } };
    const result = f.ctx.createPaymentCheckout({ requestId: 'request_abcdefghijklmnop',
      entries: JSON.stringify([{id:'12345678',event:'chess',date:'2026-12-01'}]) });
    const expected = { transport: 'STRIPE_REQUEST', json: 'STRIPE_RESPONSE', configuration: 'CONFIGURATION', storage: 'BASKET_STORAGE' }[failure] || 'HTTP_' + failure;
    assert.ok(result.error.includes('(CHECKOUT_' + expected + ')'), result.error);
    if (failure === 401 || failure === 403) assert.match(result.error, /permission/);
    assert.ok(!/private|PRIVATEKEY|12345678/i.test(result.error));
    assert.deepEqual(logs, []);
    assert.equal(bodies, typeof failure === 'number' || failure === 'json' ? 1 : 0);
  }
});

test('checkout returns expected validation errors and malformed selection never reaches Stripe', () => {
  const f = basketFixture(true);
  f.ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'sk_test_fixture' }) };
  f.ctx.UrlFetchApp = { fetch() { throw Error('must not request Stripe'); } };
  assert.match(f.ctx.createPaymentCheckout({ entries: '{' }).error, /valid entries/);
  const entry = {id:'12345678',event:'chess',date:'2026-12-01'};
  f.entry['Rating fee'] = '';
  assert.match(f.ctx.createPaymentCheckout({ entries: JSON.stringify([entry]) }).error, /balance needs review/);
  f.entry['Rating fee'] = '2.50';
  f.entry.Status = 'withdrawn';
  assert.match(f.ctx.createPaymentCheckout({ entries: JSON.stringify([entry]) }).error, /registration changed/);
});

test('unknown rating allocation flags authoritative balances and refuses checkout while explicit zero stays payable', () => {
  for (const rating of ['', undefined, '   ']) {
    const f = fixture();
    f.entry['Rating fee'] = rating;
    f.ctx.clubEvents = () => ({});
    const balance = f.ctx.paymentBalances({id:'12345678'}).entries[0];
    assert.equal(balance.balanceCents, 1750);
    assert.equal(balance.review, true);
    f.config.dynamicCheckout = { enabled: true };
    f.ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'sk_live_fixture' }) };
    f.ctx.UrlFetchApp = { fetch() { throw Error('unknown allocation must not request Stripe'); } };
    const result = f.ctx.createPaymentCheckout({requestId:'request_abcdefghijklmnop', entries:JSON.stringify([{id:'12345678',event:'chess',date:'2026-12-01'}])});
    assert.match(result.error, /balance needs review/);
  }
  const f = fixture();
  f.entry['Rating fee'] = '0';
  f.ctx.clubEvents = () => ({});
  const balance = f.ctx.paymentBalances({id:'12345678'}).entries[0];
  assert.equal(balance.balanceCents, 1750);
  assert.equal(balance.review, false);
  f.config.dynamicCheckout = { enabled: true };
  f.ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'sk_live_fixture' }) };
  const headers = ['Reference','Mode','Amount','Allocations','Session','URL','Checkout request'];
  const sheet = { getRange: () => { const range = { setNumberFormat: () => range, setValue() {} }; return range; } };
  f.ctx.stripeBaskets = () => ({ sheet, rows: [], col: Object.fromEntries(headers.map((h,i) => [h,i])) });
  f.ctx.appendText = () => {};
  let requests = 0;
  f.ctx.UrlFetchApp = { fetch: () => { requests++; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({id:'cs_live_fixture',url:'https://checkout.stripe.com/c/pay/cs_live_fixture',livemode:true,amount_total:1750,client_reference_id:'request_abcdefghijklmnop'}) }; } };
  assert.equal(f.ctx.createPaymentCheckout({requestId:'request_abcdefghijklmnop',entries:JSON.stringify([{id:'12345678',event:'chess',date:'2026-12-01'}])}).ok, true);
  assert.equal(requests, 1);
});


test('Stripe checkout diagnostics expose only allowlisted fields and a provider request ID', () => {
  const f=fixture();
  const response={getContentText:()=>JSON.stringify({error:{type:'invalid_request_error',code:'parameter_unknown',param:'allowed_payment_method_types',message:'Bearer sk_test_SECRET payer@example.com'}}),getHeaders:()=>({'Request-Id':'req_safe123'})};
  const result=f.ctx.stripeCheckoutHttpError(response,400);
  assert.deepEqual(plain(result.checkoutDiagnostic),{type:'invalid_request_error',code:'parameter_unknown',param:'allowed_payment_method_types',requestId:'req_safe123'});
  assert.ok(!/SECRET|payer@example|Bearer/.test(JSON.stringify(result)));
  for(const field of ['type','code','param']) {
    const bad={getContentText:()=>JSON.stringify({error:{[field]:'sk_test_SECRET'}}),getHeaders:()=>({'request-id':'payer@example.com'})};
    assert.deepEqual(plain(f.ctx.stripeCheckoutHttpError(bad,400).checkoutDiagnostic),{});
  }
  assert.deepEqual(plain(f.ctx.stripeCheckoutHttpError({getContentText:()=>'{',getHeaders:()=>({})},400).checkoutDiagnostic),{});
});


function checkoutAttemptFixture() {
  const f=basketFixture(true), rows=[], calls=[], cache=new Map();
  const headers=['Reference','Mode','Amount','Allocations','Session','URL','Checkout request'];
  const col=Object.fromEntries(headers.map((h,i)=>[h,i]));
  let failUrl=false, sessions=0;
  const sheet={getRange:(r,c)=>{const range={setNumberFormat:()=>range,setValue:value=>{
    if(failUrl && c===col.URL+1){failUrl=false;throw Error('interrupted save');}
    rows[r-2][c-1]=value;
  }};return range;}};
  f.ctx.stripeBaskets=()=>({sheet,col,rows:rows.map(r=>[...r])});
  const append=f.ctx.appendText;
  f.ctx.appendText=(target,cols,row)=>target===sheet?rows.push(headers.map(h=>row[h]||'')):append(target,cols,row);
  f.ctx.PropertiesService={getScriptProperties:()=>({getProperty:()=> 'sk_test_fixture'})};
  f.ctx.UrlFetchApp={fetch:(url,options)=>{
    const key=options.headers['Idempotency-Key'], payload=JSON.stringify(options.payload);
    calls.push(plain(options));
    if(cache.has(key) && cache.get(key).payload!==payload) return {getResponseCode:()=>400,getContentText:()=>JSON.stringify({error:{type:'idempotency_error'}}),getHeaders:()=>({})};
    if(!cache.has(key)) cache.set(key,{payload,id:'cs_test_created'+(++sessions)});
    const session=cache.get(key);
    return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({id:session.id,url:'https://checkout.stripe.com/c/pay/'+session.id,livemode:false,amount_total:3000,client_reference_id:options.payload.client_reference_id})};
  }};
  const params={requestId:'request_abcdefghijklmnop',entries:JSON.stringify([{id:'12345678',event:'chess',date:'2026-12-01'},{id:'87654321',event:'chess',date:'2026-12-01'}])};
  return {...f,rows,col,calls,cache,params,failSave:()=>{failUrl=true;},sessions:()=>sessions};
}

test('checkout persists its versioned immutable request and retries a post-Stripe interruption without another session',()=>{
  const f=checkoutAttemptFixture();f.failSave();
  assert.match(f.ctx.createPaymentCheckout(f.params).error,/CHECKOUT_BASKET_SAVE/);
  const descriptor=JSON.parse(f.rows[0][f.col['Checkout request']]);
  assert.equal(descriptor.contract,'entry-usd-card-v2');
  assert.equal(descriptor.apiVersion,'2026-10-28.endive');
  assert.equal(descriptor.key,'lccc-entry-usd-card-v2-'+f.params.requestId);
  assert.ok(!JSON.stringify(descriptor).includes('sk_test'));
  assert.equal(f.ctx.createPaymentCheckout(f.params).ok,true);
  assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(f.sessions(),1);
  assert.equal(f.calls[0].headers['Stripe-Version'],'2026-10-28.endive');
  assert.equal(f.ctx.createPaymentCheckout(f.params).ok,true);assert.equal(f.calls.length,2);
});

test('legacy pending attempts fail closed with reload guidance while saved legacy sessions remain reusable',()=>{
  const f=checkoutAttemptFixture();
  f.rows.push([f.params.requestId,'false','3000',JSON.stringify(f.allocations),'','']);
  assert.match(f.ctx.createPaymentCheckout(f.params).error,/Reload this page/);assert.equal(f.calls.length,0);
  f.rows[0][f.col.URL]='https://checkout.stripe.com/c/pay/cs_test_legacy';
  assert.equal(f.ctx.createPaymentCheckout(f.params).checkoutUrl,f.rows[0][f.col.URL]);assert.equal(f.calls.length,0);
  const next={...f.params,requestId:'fresh_abcdefghijklmnop'};
  assert.equal(f.ctx.createPaymentCheckout(next).ok,true);
  assert.equal(f.calls[0].headers['Idempotency-Key'],'lccc-entry-usd-card-v2-'+next.requestId);
});

test('corrupt durable request bindings cannot issue another Stripe request',()=>{
  for(const patch of [{mode:'subscription'},{client_reference_id:'another-reference'},{'line_items[0][price_data][unit_amount]':'1'},{'line_items[0][price_data][currency]':'eur'},{success_url:'https://evil.example/pay'}]){
    const f=checkoutAttemptFixture();assert.equal(f.ctx.createPaymentCheckout(f.params).ok,true);
    f.rows[0][f.col.URL]='';const descriptor=JSON.parse(f.rows[0][f.col['Checkout request']]);Object.assign(descriptor.payload,patch);f.rows[0][f.col['Checkout request']]=JSON.stringify(descriptor);
    assert.match(f.ctx.createPaymentCheckout(f.params).error,/Stored checkout could not be verified/);assert.equal(f.calls.length,1);
  }
});

test('idempotency errors give explicit reload guidance with safe diagnostic fields',()=>{
  const f=fixture(), result=f.ctx.stripeCheckoutHttpError({getContentText:()=>JSON.stringify({error:{type:'idempotency_error',message:'private old payload'}}),getHeaders:()=>({'Request-Id':'req_safe123'})},400);
  assert.match(result.error,/Reload this page and try again/);assert.equal(result.checkoutDiagnostic.type,'idempotency_error');assert.ok(!result.error.includes('private'));
});
