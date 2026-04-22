#!/usr/bin/env bash
# score-utils.sh — Quality scoring helpers and evolution DB logging
# Source this file, don't execute it directly.
#
# Provides:
#   extract_verdict     — extract verdict from Arbiter's score JSON
#   extract_overall     — extract overall score from Arbiter output
#   log_score_history   — append a score entry to history.json
#   log_evolution       — write run summary to evolution/run-summary.json
#   check_evolution     — check historical patterns for this task type
#   generate_escalation — generate escalation report from score history

# ─── Score extraction ────────────────────────────────────────

# Extract verdict string from Arbiter output
# Args: $1 = verdict JSON file
# Output: PROCEED | REVIEW | REWORK
extract_verdict() {
  local verdict_file="$1"
  python3 -c "
import json, sys
data = json.load(open(sys.argv[1]))
overall = data.get('overall', data.get('satisfaction', 0))
threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 0.8
if overall >= threshold:
    print('PROCEED')
elif overall >= 0.7:
    print('REVIEW')
else:
    print('REWORK')
" "$verdict_file" "${2:-0.8}"
}

# Extract overall score
# Args: $1 = verdict JSON file
extract_overall() {
  local verdict_file="$1"
  python3 -c "
import json, sys
data = json.load(open(sys.argv[1]))
print(data.get('overall', data.get('satisfaction', 0)))
" "$verdict_file"
}

# ─── Score history ───────────────────────────────────────────

# Append a score entry to the history file
# Args: $1 = scores dir, $2 = iteration, $3 = verdict JSON file
log_score_history() {
  local scores_dir="$1"
  local iteration="$2"
  local verdict_file="$3"
  local history_file="$scores_dir/history.json"

  python3 -c "
import json, sys, os
from datetime import datetime, timezone

scores_dir = sys.argv[1]
iteration = int(sys.argv[2])
verdict_file = sys.argv[3]
history_file = os.path.join(scores_dir, 'history.json')

verdict = json.load(open(verdict_file))

entry = {
    'iteration': iteration,
    'timestamp': datetime.now(timezone.utc).isoformat(),
    'overall': verdict.get('overall', verdict.get('satisfaction', 0)),
    'dimensions': verdict.get('dimensions', {}),
    'verdict': verdict.get('verdict', 'unknown'),
    'stage': verdict.get('stage', 'unknown')
}

if os.path.exists(history_file):
    history = json.load(open(history_file))
else:
    history = {'scores': []}

history['scores'].append(entry)

with open(history_file, 'w') as f:
    json.dump(history, f, indent=2)
" "$scores_dir" "$iteration" "$verdict_file"
}

# ─── Evolution tracking ──────────────────────────────────────

# Write run summary for cross-run learning
# Args: $1 = evolution dir, $2 = pipeline meta file, $3 = final verdict file
log_evolution() {
  local evolution_dir="$1"
  local meta_file="$2"
  local final_verdict="$3"
  local scores_history="$4"
  local summary_file="$evolution_dir/run-summary.json"

  python3 -c "
import json, sys, os
from datetime import datetime, timezone

evolution_dir = sys.argv[1]
meta_file = sys.argv[2]
final_verdict_file = sys.argv[3]
scores_file = sys.argv[4]

meta = json.load(open(meta_file)) if os.path.exists(meta_file) else {}
verdict = json.load(open(final_verdict_file)) if os.path.exists(final_verdict_file) else {}
scores_data = json.load(open(scores_file)) if os.path.exists(scores_file) else {'scores': []}

# Collect score progression
score_list = [s['overall'] for s in scores_data.get('scores', [])]

# Find weak dimensions (any below 0.7)
weak = []
dims = verdict.get('dimensions', {})
for dim, val in dims.items():
    if isinstance(val, (int, float)) and val < 0.7:
        weak.append(dim)

summary = {
    'timestamp': datetime.now(timezone.utc).isoformat(),
    'feature': meta.get('feature', 'unknown'),
    'tier': meta.get('tier', 'unknown'),
    'mode': 'holdout' if meta.get('holdout_mode') else 'informed',
    'iterations': len(score_list),
    'scores': score_list,
    'final_verdict': verdict.get('verdict', 'unknown'),
    'final_overall': verdict.get('overall', verdict.get('satisfaction', 0)),
    'call_distribution': meta.get('distribution', {}),
    'total_calls': meta.get('total_calls', 0),
    'weak_dimensions': weak,
    'dimensions_final': dims
}

# Append to existing evolution file or create new
evolution_file = os.path.join(evolution_dir, 'run-summary.json')
if os.path.exists(evolution_file):
    evolution = json.load(open(evolution_file))
else:
    evolution = {'runs': []}

evolution['runs'].append(summary)

with open(evolution_file, 'w') as f:
    json.dump(evolution, f, indent=2)
" "$evolution_dir" "$meta_file" "$final_verdict" "$scores_history"
}

# Check historical patterns before a run
# Args: $1 = evolution dir
# Output: advisory text (may be empty)
check_evolution() {
  local evolution_dir="$1"
  local summary_file="$evolution_dir/run-summary.json"

  if [[ ! -f "$summary_file" ]]; then
    return 0
  fi

  python3 -c "
import json, sys

data = json.load(open(sys.argv[1]))
runs = data.get('runs', [])
if not runs:
    sys.exit(0)

# Check for consistently weak dimensions
from collections import Counter
weak_counts = Counter()
for r in runs:
    for dim in r.get('weak_dimensions', []):
        weak_counts[dim] += 1

total = len(runs)
advisories = []

for dim, count in weak_counts.most_common():
    if count >= 2 and count / total >= 0.5:
        advisories.append(f'⚠️  Historically weak on \"{dim}\" ({count}/{total} runs)')

# Check holdout vs informed score comparison
holdout_scores = [r['final_overall'] for r in runs if r.get('mode') == 'holdout' and isinstance(r.get('final_overall'), (int, float))]
informed_scores = [r['final_overall'] for r in runs if r.get('mode') == 'informed' and isinstance(r.get('final_overall'), (int, float))]

if holdout_scores and informed_scores:
    h_avg = sum(holdout_scores) / len(holdout_scores)
    i_avg = sum(informed_scores) / len(informed_scores)
    diff = h_avg - i_avg
    if abs(diff) >= 0.05:
        better = 'holdout' if diff > 0 else 'informed'
        advisories.append(f'📊 {better} mode scores {abs(diff):.2f} higher on average')

# Check if FIX consistently eats the budget
fix_heavy = sum(1 for r in runs if r.get('call_distribution', {}).get('FIX', 0) > r.get('total_calls', 10) * 0.4)
if fix_heavy >= 2:
    advisories.append(f'🔧 FIX phase consumed >40% of budget in {fix_heavy}/{total} runs — consider improving BUILD step')

for a in advisories:
    print(a)
" "$summary_file" 2>/dev/null || true
}

# ─── Escalation report ──────────────────────────────────────

# Generate escalation report when max iterations reached
# Args: $1 = convergence dir, $2 = output file
generate_escalation() {
  local conv_dir="$1"
  local output_file="$2"

  python3 -c "
import json, sys, os, glob

conv_dir = sys.argv[1]
output_file = sys.argv[2]

# Collect all verdict files
verdict_files = sorted(glob.glob(os.path.join(conv_dir, 'verdicts', 'verdict-*.json')))

report = '# Pipeline Escalation Report\n\n'
report += '## Score History\n\n'
report += '| Iteration | Overall | Spec | Quality | Tests | Edges | Security |\n'
report += '|-----------|---------|------|---------|-------|-------|----------|\n'

for vf in verdict_files:
    v = json.load(open(vf))
    iteration = os.path.basename(vf).replace('verdict-', '').replace('.json', '')
    overall = v.get('overall', v.get('satisfaction', 0))
    dims = v.get('dimensions', {})
    spec = dims.get('spec_compliance', '-')
    qual = dims.get('code_quality', '-')
    tests = dims.get('test_coverage', '-')
    edges = dims.get('edge_cases', '-')
    sec = dims.get('security', '-')
    report += f'| {iteration} | {overall} | {spec} | {qual} | {tests} | {edges} | {sec} |\n'

# Call distribution
meta_file = os.path.join(conv_dir, 'pipeline-meta.json')
if os.path.exists(meta_file):
    meta = json.load(open(meta_file))
    report += '\n## Call Distribution\n\n'
    report += '| Phase | Calls | % of Budget |\n'
    report += '|-------|-------|-------------|\n'
    total = meta.get('total_calls', 1)
    for phase, calls in meta.get('distribution', {}).items():
        pct = int(calls / max(total, 1) * 100)
        report += f'| {phase} | {calls} | {pct}% |\n'

# Persistent issues from last verdict
if verdict_files:
    last = json.load(open(verdict_files[-1]))
    feedback = last.get('structured_feedback', last.get('holdout_safe_summary', ''))
    report += '\n## Persistent Issues\n\n'
    if isinstance(feedback, dict):
        for item in feedback.get('items', []):
            report += f'- **{item.get(\"dimension\", \"unknown\")}** ({item.get(\"severity\", \"medium\")}): {item.get(\"behavior_gap\", \"\")}\n'
    elif isinstance(feedback, str):
        report += f'{feedback}\n'
    else:
        report += 'See verdict files for details.\n'

    report += '\n## Recommendation\n\n'
    report += 'Review the score history and persistent issues. Likely causes:\n'
    report += '- Design spec may be ambiguous in the failing areas\n'
    report += '- Task granularity may be too coarse for the coder\n'
    report += '- Problem may require human judgment to resolve\n'

with open(output_file, 'w') as f:
    f.write(report)

print(f'Escalation report written to {output_file}')
" "$conv_dir" "$output_file"
}
