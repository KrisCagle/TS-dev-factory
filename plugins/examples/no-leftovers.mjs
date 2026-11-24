/** Flags debugging leftovers before you sign off. */
const LEFTOVER = /\b(TODO|FIXME|XXX)\b|console\.log\(|\bdebugger;?/;

export default {
  name: 'no-leftovers',
  description: 'Flags added TODO/FIXME comments, console.log calls and debugger statements.',
  setup(api) {
    const mode = api.config.sendBack ? 'sendback' : 'flag';
    api.addGate({
      id: 'no-leftovers',
      name: 'No leftovers',
      onFail: mode,
      check: (t) => {
        const hits = (t.diff ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++') && LEFTOVER.test(l));
        return hits.length
          ? { ok: false, message: `${hits.length} leftover${hits.length === 1 ? '' : 's'}: ${hits.slice(0, 3).map((h) => h.slice(1).trim().slice(0, 60)).join(' · ')}` }
          : { ok: true };
      },
    });
  },
};
