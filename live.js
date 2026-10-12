// Follows a path in the club's live database (LIVE_DB in register.js) with the Realtime Database's
// streaming REST API, so the Pairings, Standings, and TD desk pages update without polling. See
// docs/plans/firebase-tournaments.md in the club's docs for what the database holds.

/** Calls show with the whole value at path (null when there is none) on connecting and after every
 *  change. Calls down(final) when the stream drops: final when it has stopped for good (the server
 *  refused it, or cancelled it), otherwise EventSource is reconnecting by itself. Returns a
 *  function that stops listening. */
function listenLive(path, show, down) {
  const source = new EventSource(`${LIVE_DB}${path}.json`);
  let value = null;
  const stop = () => source.close();
  const end = () => {
    stop();
    down(true);
  };

  /** value with data at the path below it, or the path removed when data is null. */
  const placed = (whole, at, data) => {
    const keys = at.split("/").filter(Boolean);
    if (!keys.length) return data;
    const root = whole && typeof whole === "object" ? { ...whole } : {};
    let node = root;
    for (const key of keys.slice(0, -1)) {
      node[key] = node[key] && typeof node[key] === "object" ? { ...node[key] } : {};
      node = node[key];
    }
    if (data === null) delete node[keys.at(-1)];
    else node[keys.at(-1)] = data;
    return Object.keys(root).length ? root : null;
  };

  const read = (event) => {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  };
  source.addEventListener("put", (event) => {
    const change = read(event);
    if (!change) return;
    value = placed(value, change.path, change.data);
    show(value);
  });
  source.addEventListener("patch", (event) => {
    const change = read(event);
    if (!change) return;
    for (const [key, data] of Object.entries(change.data || {})) value = placed(value, `${change.path}/${key}`, data);
    show(value);
  });
  source.addEventListener("cancel", end);
  source.addEventListener("auth_revoked", end);
  source.addEventListener("error", () => (source.readyState === EventSource.CLOSED ? end() : down(false)));
  return stop;
}
