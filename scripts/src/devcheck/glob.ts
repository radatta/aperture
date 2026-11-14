// No imports: the bot (plain node, builtins only) loads this too — bot/ios-routing.ts.
// A repo-relative glob: `**` crosses folders, `*` stays inside one.
export function globMatch(glob: string, path: string): boolean {
  const re = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${re}$`).test(path);
}
