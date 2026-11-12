(() => {
  if (globalThis.lcccEventSyncInstalled) return;
  globalThis.lcccEventSyncInstalled = true;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { clean, query } = globalThis.LCCCSelectors;
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';

  async function element(selector) {
    const deadline = Date.now() + 12000;
    do {
      const matches = query(document, selector).filter(visible);
      if (matches.length > 1) throw new Error('A Facebook control is ambiguous. Open setup to inspect it.');
      if (matches.length === 1) return matches[0];
      await pause(150);
    } while (Date.now() < deadline);
    throw new Error('A Facebook control has changed or is missing. Open this tab and inspect the form.');
  }

  async function guard(ui) {
    if (location.origin !== 'https://www.facebook.com' || /\/checkpoint|\/login|\/recover|\/two_step_verification/.test(location.pathname)
        || [...document.querySelectorAll('input[name="email"],input[name="pass"],iframe[src*="captcha"]')].some(visible)) {
      throw new Error('Facebook needs your login or verification. Open the sync tab and complete it manually.');
    }
    if (!ui?.authenticatedSelector) throw new Error('Facebook form setup is incomplete.');
    await element(ui.authenticatedSelector);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!['America/Denver', 'US/Mountain'].includes(timezone)) {
      throw new Error('Set this browser/computer to Mountain Time before syncing club events.');
    }
  }

  const text = el => 'value' in el ? el.value : el.innerText;
  async function fill(selector, value) {
    const el = await element(selector);
    el.focus();
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, value)) throw new Error('Facebook did not accept the event description.');
    } else {
      let prototype = Object.getPrototypeOf(el);
      while (prototype && !Object.getOwnPropertyDescriptor(prototype, 'value')?.set) prototype = Object.getPrototypeOf(prototype);
      const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value').set;
      if (!setter) throw new Error('The Facebook input type has changed.');
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Date/time widgets commit their React state on blur, after the input render.
    await pause(150);
    el.blur();
    await pause(250);
  }

  const expand = (template, data) => template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in data)) throw new Error('An event form template field is invalid.');
    return data[key];
  });

  async function steps(list, data, ui) {
    for (const step of list || []) {
      await guard(ui);
      const selector = expand(step.selector, data);
      if (step.ifPresent && !query(document, selector).some(visible)) continue;
      const el = await element(selector);
      if (step.action === 'click') el.click();
      else if (step.action === 'fill') await fill(selector, expand(step.value, data));
      else if (step.action === 'press') {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: step.value, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: step.value, bubbles: true }));
      }
      await pause(300);
    }
  }

  async function group(selector, groupUrl) {
    const link = await element(selector);
    const href = new URL(link.href, location.href);
    if (`${href.origin}${href.pathname.replace(/\/$/, '')}/` !== groupUrl) throw new Error('This Facebook event belongs to a different group.');
  }

  async function handle(message) {
    const { ui, action, groupUrl, fields } = message;
    if (message.command === 'inspect') {
      return [...document.querySelectorAll('input,textarea,button,[role],[contenteditable="true"]')].filter(visible).map(el => ({
        tag: el.tagName, id: el.id, role: el.getAttribute('role'), label: el.getAttribute('aria-label'),
        labels: [...(el.labels || [])].map(label => clean(label.innerText)),
        placeholder: el.getAttribute('placeholder'), text: el.matches('input,textarea,[contenteditable]') ? '' : el.innerText?.slice(0, 120),
      })).slice(0, 300);
    }
    await guard(ui);
    const recipe = ui[action.kind];
    if (message.command === 'prepare') {
      if (action.kind !== 'create') {
        await group(recipe.groupSelector, groupUrl);
        await steps(recipe.identify, action.data, ui);
        if (!action.adopt && !text(await element(expand(recipe.identitySelector, action.data))).includes(action.data.marker)) {
          throw new Error('This Facebook event has a different calendar reference.');
        }
      }
      await steps(recipe.open, action.data, ui);
      if (action.kind !== 'cancel') {
        if (recipe.formGroupSelector && !clean(text(await element(recipe.formGroupSelector))).includes(recipe.formGroupText)) {
          throw new Error('This Facebook form belongs to a different group.');
        }
        for (const field of fields) {
          if (clean(text(await element(recipe.fields[field]))) === clean(action.data[field])) continue;
          await fill(recipe.fields[field], action.data[field]);
          await steps(recipe.afterFill?.[field], action.data, ui);
        }
        const zones = query(document, recipe.timeZoneSelector).filter(visible);
        if (!zones.length || zones.some(el => clean(text(el)) !== clean(expand(recipe.timeZoneText, action.data)))) {
          throw new Error('Facebook is not showing the configured Mountain Time zone.');
        }
        for (const field of fields) {
          if (clean(text(await element(recipe.fields[field]))) !== clean(action.data[field])) {
            throw new Error(`Facebook rejected ${field}; the event was not submitted.`);
          }
        }
      } else if (recipe.cancelChoiceSelector && !(await element(recipe.cancelChoiceSelector)).checked) {
        throw new Error('Facebook has not selected cancellation. The event was not submitted.');
      }
      return { prepared: true };
    }
    if (message.command === 'submit') {
      const el = await element(message.selector);
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Facebook has disabled the submit button.');
      // Reply before a navigation destroys the content script. Never retry an uncertain click.
      setTimeout(() => el.click(), 100);
      return { queued: true };
    }
    if (message.command === 'verify') {
      await group(recipe.groupSelector, groupUrl);
      await steps(recipe.read, action.data, ui);
      if (action.kind === 'cancel') {
        const status = clean(text(await element(recipe.cancelledSelector)));
        if (recipe.cancelledText === 'cancelled-status' ? !/^(?:event )?cancel(?:ed|led)$/i.test(status) : status !== clean(recipe.cancelledText)) throw new Error('Facebook did not confirm cancellation.');
      } else {
        for (const field of fields) {
          if (clean(text(await element(recipe.verify[field]))) !== clean(action.data[field])) throw new Error(`Saved Facebook ${field} differs from the calendar.`);
        }
      }
      return { verified: true };
    }
    throw new Error('Unknown sync command.');
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.scope !== 'lccc-event-sync') return;
    handle(message).then(value => respond({ ok: true, value }), error => {
      const safe = /^(A Facebook|Facebook |Set this|This Facebook|An event|The Facebook|Saved Facebook)/.test(error.message);
      respond({ ok: false, error: safe ? error.message : 'The Facebook form changed. Open the sync tab and inspect it.' });
    });
    return true;
  });
})();
