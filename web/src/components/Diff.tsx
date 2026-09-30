export function Diff({ text }: { text: string }) {
  if (!text?.trim()) return <div className="empty">No changes yet.</div>;
  const files: Array<{ name: string; lines: string[] }> = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      files.push({ name: line.replace(/^diff --git a\/(.*?) b\/.*$/, '$1'), lines: [] });
    } else if (files.length && !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line)) {
      files[files.length - 1].lines.push(line);
    }
  }
  if (!files.length) files.push({ name: 'changes', lines: text.split('\n') });
  const stat = (l: string[]) => [l.filter((x) => x.startsWith('+')).length, l.filter((x) => x.startsWith('-')).length];
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {files.map((f) => {
        const [a, d] = stat(f.lines);
        return (
          <div key={f.name} className="diff">
            <div className="f">
              {f.name} <span style={{ color: 'var(--ok)', marginLeft: 8 }}>+{a}</span> <span style={{ color: 'var(--bad)' }}>−{d}</span>
            </div>
            {f.lines.map((l, i) => (
              <div key={i} className={`l ${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}`}>{l || ' '}</div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
