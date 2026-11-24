/** A Security reviewer that looks at every change after the Reviewer approves it. */
const RISKY = /(password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{6,}|eval\(|innerHTML\s*=|child_process|exec\(`/i;

export default {
  name: 'security-reviewer',
  description: 'Adds a Security reviewer agent after the Reviewer, and a security desk in the Office.',
  setup(api) {
    api.addRole({
      id: 'security',
      name: 'Security reviewer',
      icon: '🛡',
      after: 'reviewer',
      tools: ['Read', 'Glob', 'Grep'],
      prompt: (t) => `# Ticket ${t.key}: ${t.title}

Review this change for security problems only: hard-coded secrets, injection (SQL, shell, HTML), missing authorization checks, unsafe deserialization, and sensitive data in logs.
Ignore style. Report passed=false only for real, exploitable problems, each as a finding with file, line and how to fix it.

\`\`\`diff
${(t.diff ?? '').slice(0, 50_000)}
\`\`\``,
      // with simulated agents: flag added lines that look like secrets or injection
      mock: (t) => {
        const bad = (t.diff ?? '').split('\n').filter((l) => l.startsWith('+') && RISKY.test(l));
        return bad.length
          ? { passed: false, summary: `${bad.length} risky line${bad.length === 1 ? '' : 's'} added`, findings: bad.map((l) => ({ severity: 'major', comment: `Looks like a secret or injection risk: ${l.slice(1, 120).trim()}` })) }
          : { passed: true, summary: 'No security issues found.' };
      },
    });
    api.addRoom({ id: 'security-desk', label: 'Security desk', icon: '🛡' });
  },
};
