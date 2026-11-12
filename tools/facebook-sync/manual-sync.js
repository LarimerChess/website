export async function syncNow(request, progress = () => {}) {
  let applied = 0;
  while (true) {
    const { actions } = await request('preview');
    progress({ applied, remaining: actions.length });
    if (!actions.length) return { applied };
    const result = await request('apply', { batch: true });
    if (!Number.isInteger(result.applied) || result.applied < 1 || result.applied > 3) {
      throw new Error('Sync made no progress. Check for changes and try again.');
    }
    applied += result.applied;
  }
}
