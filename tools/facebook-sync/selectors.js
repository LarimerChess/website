(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  function query(root, selector) {
    if (selector.startsWith('contains=') || selector === 'cancelled-status') {
      const matches = [...root.querySelectorAll('div,span,h1,h2')].filter(el => selector === 'cancelled-status'
        ? /^(?:event )?cancel(?:ed|led)$/i.test(clean(el.innerText))
        : clean(el.innerText).includes(selector.slice(9)));
      return matches.filter(el => !matches.some(child => child !== el && el.contains(child)));
    }
    if (selector.startsWith('label=')) {
      const wanted = selector.slice(6);
      return [...root.querySelectorAll('input,textarea,select,[contenteditable="true"],[role="combobox"]')].filter(el => {
        const labels = [...(el.labels || [])].map(label => clean(label.innerText).replace(/\s+\d+\/\d+$/, ''));
        labels.push(clean(el.getAttribute('aria-label')));
        const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/);
        labels.push(clean(ids.map(id => root.getElementById(id)?.innerText || '').join(' ')));
        return labels.includes(wanted);
      });
    }
    if (selector.startsWith('text=') || selector.startsWith('option=')) {
      const option = selector.startsWith('option=');
      const wanted = selector.slice(option ? 7 : 5);
      const matches = [...root.querySelectorAll(option ? '[role="option"]' : 'button,a,[role="button"],[role="menuitem"],[role="option"]')]
        .filter(el => clean(el.innerText) === wanted);
      return matches.filter(el => !matches.some(parent => parent !== el && parent.contains(el)));
    }
    return [...root.querySelectorAll(selector)];
  }
  globalThis.LCCCSelectors = { query, clean };
})();
