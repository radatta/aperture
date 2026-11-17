// One word of a line the maintainer pastes into zsh on the Mac: bare when it is only [A-Za-z0-9_./-], else
// single-quoted with each ' as '\'' — zsh single quotes stop substitution, globbing and `!` history expansion, so no
// character in the word can act. Every variable word in a Mac line goes through this, whatever validated it upstream.
export const shq = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
