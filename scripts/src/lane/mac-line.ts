// The maintainer's one Mac line at a lane's end: the branch force-delete (hard-blocked for Claude) plus, for a branch
// admitted to the `dev` environment, the admission removal (docs/ops/CI-BOT.md → workflow changes). One `&&` chain,
// zsh-safe: every word with ? * [ < ! { } single-quoted, gh unpaged. Printed and written to a file, never run, and
// never handed to a child process (a Bash hook denies the force-delete text on a command line). The admission removal
// goes first: it is the security half, and a failed delete (the branch already gone on the Mac) would stop the chain.
// '' when there is nothing to do.

export type Admission = { kind: 'none' } | { kind: 'id'; id: number } | { kind: 'unknown' };

export function macLine(
  root: string,
  branch: string,
  hasBranch: boolean,
  adm: Admission,
  slug: string,
): string {
  const policies = `repos/${slug}/environments/dev/deployment-branch-policies`;
  const list = `GH_PAGER=cat gh api '${policies}' --jq '.branch_policies[].name'`;
  const parts: string[] = [];
  if (adm.kind === 'id') parts.push(`GH_PAGER=cat gh api -X DELETE '${policies}/${adm.id}'`, list);
  if (adm.kind === 'unknown')
    // CI-BOT.md's by-name form: a branch never admitted matches nothing, and xargs -I runs nothing on no input.
    parts.push(
      `GH_PAGER=cat gh api '${policies}' --jq '.branch_policies[] | select(.name=="${branch}") | .id' | GH_PAGER=cat xargs -I'{}' gh api -X DELETE '${policies}/{}'`,
      list,
    );
  if (hasBranch) parts.push(`git branch -D ${branch}`);
  return parts.length ? [`cd ${root}`, ...parts].join(' && ') : '';
}

// The admission, from the `dev` environment's branch policies; unknown when the read fails.
export function parseAdmission(text: string | null, branch: string): Admission {
  if (text === null) return { kind: 'unknown' };
  try {
    const r = JSON.parse(text) as {
      total_count?: unknown;
      branch_policies?: { id?: unknown; name?: unknown }[];
    };
    if (!Array.isArray(r?.branch_policies)) return { kind: 'unknown' };
    const hit = r.branch_policies.find((p) => p?.name === branch);
    if (hit)
      return Number.isInteger(hit.id) ? { kind: 'id', id: hit.id as number } : { kind: 'unknown' };
    // past the first page (100): not seen is not "not admitted"
    if (typeof r.total_count === 'number' && r.total_count > r.branch_policies.length)
      return { kind: 'unknown' };
    return { kind: 'none' };
  } catch {
    return { kind: 'unknown' };
  }
}
