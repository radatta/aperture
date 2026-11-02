# Generates testdata/jobs.jsonl, the mailroom's shared fixture cases (run-fixtures.sh + job.test.ts).
# Edit the cases here, then: python3 tools/mailroom/testdata/gen-jobs.py tools/mailroom/testdata/jobs.jsonl
# runner-fixtures.test.ts fails if the committed jsonl drifts from this generator's output.
import json, sys

out = sys.argv[1]
A = 'a' * 40
R = '/repos/radatta/aperture'
REF = f'GET {R}/git/ref/heads/mac-mailroom'
LIST = f'GET {R}/pulls?head=radatta:mac-mailroom&state=open'
POST = f'POST {R}/pulls'
MD = 'POST /markdown'
MENTION_HTML = '<p><a class="user-mention notranslate" href="https://github.com/octocat">@octocat</a></p>'
PR = {'number': 90, 'html_url': 'https://github.com/radatta/aperture/pull/90', 'head': {'sha': A}, 'user': {'login': 'radatta'}}
PRR = {'number': 90, 'url': 'https://github.com/radatta/aperture/pull/90', 'headSha': A, 'author': 'radatta'}
body = 'Opens PRs from the Mac. BODYMARK\n\nCode is fine: `@types/node` and `#12`.\n\n```sh\n@someone #3\n```\n'
base = {'v': 1, 'id': '20261101T204512Z-mac-mailroom-3kx9', 'job': 'open-pr', 'submittedAt': 'now', 'expiresInMin': 20,
        'params': {'branch': 'mac-mailroom', 'sha': A, 'title': 'Mac mailroom opens PRs as the user', 'body': body, 'bodySha256': 'auto'}}
default = {'GET /user': {'status': 200, 'body': {'login': 'radatta'}, 'headers': {'github-authentication-token-expiration': '2099-01-01 00:00:00 UTC'}},
           REF: {'status': 200, 'body': {'object': {'sha': A}}},
           LIST: {'status': 200, 'body': []},
           MD: {'status': 200, 'body': '<p>ok</p>'},
           POST: {'status': 201, 'body': PR}}
ALL = ['GET /user', REF, LIST, MD, POST]
post = {'title': base['params']['title'], 'head': 'mac-mailroom', 'base': 'main', 'body': body, 'draft': False, 'maintainer_can_modify': False}


def B(b): return {'params': {'body': b}}
def T(t): return {'params': {'title': t}}


C = []
def c(name, **k): C.append({'name': name, **k})


def rej(name, reason, ts=True, status='rejected', **k):
    if ts:
        k['ts'] = reason
    c(name, expect={'status': status, 'reason': reason}, calls=[], **k)


def opened(name, **k):
    k.setdefault('ts', None)
    c(name, expect={'status': 'opened', 'reason': None, 'pr': PRR}, calls=ALL, **k)


# --- the job runs ---
opened('opens a ready PR with the exact body', post=post, md={'text': base['params']['title'] + '\n\n' + body, 'mode': 'gfm', 'context': 'radatta/aperture'})
c('existing open PR returns its URL, no write', api={LIST: {'status': 200, 'body': [PR]}}, expect={'status': 'exists', 'pr': PRR}, calls=ALL[:3])
c('probe: zero sha stops at HEAD_MISMATCH with the token expiry', patch={'params': {'sha': '0' * 40}}, ts=None,
  expect={'status': 'rejected', 'reason': 'HEAD_MISMATCH', 'tokenExpiresAt': '2099-01-01T00:00:00Z'}, calls=ALL[:2])
c('unpushed branch is HEAD_MISSING', api={REF: {'status': 404, 'body': {'message': 'Not Found'}}}, expect={'status': 'rejected', 'reason': 'HEAD_MISSING'}, calls=ALL[:2])
c('no Keychain token is TOKEN_MISSING, no call', noToken=True, expect={'status': 'error', 'reason': 'TOKEN_MISSING'}, calls=[])
c('401 is TOKEN_REJECTED', api={'GET /user': {'status': 401, 'body': {}}}, expect={'status': 'error', 'reason': 'TOKEN_REJECTED'}, calls=ALL[:1])
c('403 on create is TOKEN_FORBIDDEN', api={POST: {'status': 403, 'body': {}}}, expect={'status': 'error', 'reason': 'TOKEN_FORBIDDEN'}, calls=ALL)
c('403 with no rate left is RATE_LIMITED', api={'GET /user': {'status': 403, 'body': {}, 'headers': {'x-ratelimit-remaining': '0'}}}, expect={'status': 'error', 'reason': 'RATE_LIMITED'}, calls=ALL[:1])
c('curl timeout is TIMEOUT', api={'GET /user': {'exit': 28}}, expect={'status': 'error', 'reason': 'TIMEOUT'}, calls=ALL[:1])
c('curl failure is API_FAILED', api={'GET /user': {'exit': 6}}, expect={'status': 'error', 'reason': 'API_FAILED'}, calls=ALL[:1])
c('422 on create is API_FAILED', api={POST: {'status': 422, 'body': {'message': 'Validation Failed'}}}, expect={'status': 'error', 'reason': 'API_FAILED'}, calls=ALL)
c('another login is WRONG_AUTHOR before any write', api={'GET /user': {'status': 200, 'body': {'login': 'someone-else'}}}, expect={'status': 'error', 'reason': 'WRONG_AUTHOR'}, calls=ALL[:1])
c('a created PR on another repo is API_FAILED', api={POST: {'status': 201, 'body': {**PR, 'html_url': 'https://github.com/evil/repo/pull/1'}}}, expect={'status': 'error', 'reason': 'API_FAILED'}, calls=ALL)
c('404 on /user is TOKEN_FORBIDDEN', api={'GET /user': {'status': 404, 'body': {}}}, expect={'status': 'error', 'reason': 'TOKEN_FORBIDDEN'}, calls=ALL[:1])
c('429 with retry-after is RATE_LIMITED', api={POST: {'status': 429, 'body': {}, 'headers': {'retry-after': '60'}}}, expect={'status': 'error', 'reason': 'RATE_LIMITED'}, calls=ALL)
c('a created PR by another author is WRONG_AUTHOR', api={POST: {'status': 201, 'body': {**PR, 'user': {'login': 'someone-else'}}}}, expect={'status': 'error', 'reason': 'WRONG_AUTHOR'}, calls=ALL)
c('a markdown render failure stops before the write', api={MD: {'status': 500, 'body': {}}}, expect={'status': 'error', 'reason': 'API_FAILED'}, calls=ALL[:4])
c('a mention in the rendered body is MENTION, no write', api={MD: {'status': 200, 'body': MENTION_HTML}}, expect={'status': 'rejected', 'reason': 'MENTION'}, calls=ALL[:4])
c('a team mention in the rendered body is MENTION', api={MD: {'status': 200, 'body': '<a class="team-mention js-team-mention" href="https://github.com/orgs/x/teams/y">@x/y</a>'}}, expect={'status': 'rejected', 'reason': 'MENTION'}, calls=ALL[:4])
c('a rendered issue link to another repo is XREF', api={MD: {'status': 200, 'body': '<a class="issue-link js-issue-link" data-id="1" href="https://github.com/cli/cli/pull/1">cli/cli#1</a>'}}, expect={'status': 'rejected', 'reason': 'XREF'}, calls=ALL[:4])
c('a rendered issue link to this repo is fine', api={MD: {'status': 200, 'body': '<a class="issue-link js-issue-link" data-id="1" href="https://github.com/radatta/aperture/pull/5">#5</a>'}}, expect={'status': 'opened'}, calls=ALL)
OWN = '<a class="issue-link js-issue-link" data-id="1" href="https://github.com/radatta/aperture/pull/5">#5</a>'
FOREIGN = '<a class="issue-link js-issue-link" data-id="1" href="https://github.com/cli/cli/pull/1">cli/cli#1</a>'
def rendered(name, html, reason, **k):
    exp = {'status': 'rejected', 'reason': reason} if reason else {'status': 'opened'}
    c(name, api={MD: {'status': 200, 'body': html}}, expect=exp, calls=ALL[:4] if reason else ALL, **k)
rendered('a foreign link before 1000 own-repo links (over the pipe buffer) is still XREF', FOREIGN + OWN * 1000, 'XREF')
rendered('an own-repo link after many is fine', OWN * 100, None)
rendered('an unlinked mention in rendered text is MENTION (token cannot see the team)', '<p>cc @secret-org/team</p>', 'MENTION')
rendered('an unlinked cross-repo ref in rendered text is HASH_REF', '<p>see other/private#1</p>', 'HASH_REF')
rendered('a custom-text link to another repo issue is XREF', '<p><a href="https://github.com/o/private/issues/1">click</a></p>', 'XREF')
rendered('a literal < inside a tag (HTML the scan cannot read) is BAD_TEXT', '<p><span title="<code>`"><a class="issue-link js-issue-link" href="https://github.com/cli/cli/pull/1">cli/cli#1</a></span><span title="`</code>">x</span></p>', 'BAD_TEXT')
rendered("GitHub's real escaped render of the attribute trick is still XREF", '<p dir="auto"><span title="&lt;code&gt;`"><a class="issue-link js-issue-link" data-error-text="Failed to load title" data-id="502407912" data-url="https://github.com/cli/cli/issues/1" data-hovercard-type="pull_request" href="https://github.com/cli/cli/pull/1">cli/cli#1</a></span><span title="`&lt;/code&gt;">x</span></p>', 'XREF')
rendered('an own-repo href that walks out with ../ is XREF', '<a class="issue-link js-issue-link" href="https://github.com/radatta/aperture/../../cli/cli/issues/1">x</a>', 'XREF')
rendered('a mention GitHub kept as code is fine', '<p><code class="notranslate">@octocat</code></p><pre><code>@x #4</code></pre>', None)
# The round-1 reviewer's GFM bypasses: the fast jq pass lets them through, GitHub's render catches them.
NL = chr(10)
for nm, b in [('an indented fence closer', NL.join(['```', 'code', '  ```', '@octocat', '```', ''])),
              ('a tilde fence', NL.join(['~~~', '```', '~~~', '@octocat', '```', ''])),
              ('an HTML block', NL.join(['<div>', '```', '</div>', '', '@octocat', '', '<div>', '```', '</div>', ''])),
              ('an inline HTML attribute', '<span title="`">@octocat</span><span title="`">x</span>'),
              ('link titles', '[x](/u "`") @octocat [y](/v "`")')]:
    c(f'{nm} that hides a mention from the fast pass is caught by the render', patch=B(b), ts=None,
      api={MD: {'status': 200, 'body': MENTION_HTML}}, expect={'status': 'rejected', 'reason': 'MENTION'}, calls=ALL[:4])
c('token under 14 days warns on success', expiresInDays=3, expect={'status': 'opened', 'tokenWarning': 'TOKEN_EXPIRING'}, calls=ALL)

# --- envelope ---
rej('not JSON is BAD_JSON', 'BAD_JSON', ts=False, raw='{not json')
rej('two JSON values in one file is BAD_JSON', 'BAD_JSON', ts=False, raw='{"a":1}{"b":2}')
rej('a JSON array is BAD_JSON', 'BAD_JSON', ts=False, raw='[1]')
rej('v 2 is BAD_JSON', 'BAD_JSON', patch={'v': 2})
rej('an extra top-level key is BAD_JSON', 'BAD_JSON', patch={'repo': 'evil/repo'})
rej('id differs from the file name is BAD_ID', 'BAD_ID', patch={'id': '20261101T204512Z-other'}, file='20261101T204512Z-mac-mailroom-3kx9.json')
rej('an unlisted job is UNKNOWN_JOB', 'UNKNOWN_JOB', patch={'job': 'merge-pr'})
rej('past its expiry is EXPIRED', 'EXPIRED', status='expired', submittedAgoMin=30)
rej('submitted in the future is EXPIRED', 'EXPIRED', status='expired', submittedAgoMin=-10)
rej('expiresInMin over 60 is BAD_PARAM', 'BAD_PARAM', patch={'expiresInMin': 61})
rej('a fractional expiresInMin is BAD_PARAM', 'BAD_PARAM', patch={'expiresInMin': 2.5})
rej('submittedAt not ISO Z is BAD_PARAM', 'BAD_PARAM', patch={'submittedAt': '2026-11-01 20:45:12'})
rej('an impossible submittedAt date is BAD_PARAM', 'BAD_PARAM', patch={'submittedAt': '2026-13-45T25:61:61Z'})

# --- params ---
rej('an extra param (base) is BAD_PARAM', 'BAD_PARAM', patch={'params': {'base': 'dev'}})
rej('a missing body is BAD_PARAM', 'BAD_PARAM', unset=[['params', 'body']])
for b in ['main', 'master', 'dev']:
    rej(f'branch {b} is BAD_PARAM', 'BAD_PARAM', patch={'params': {'branch': b}})
rej('branch with a slash is BAD_PARAM', 'BAD_PARAM', patch={'params': {'branch': 'feature/x'}})
rej('branch with a dot-dot is BAD_PARAM', 'BAD_PARAM', patch={'params': {'branch': 'a..b'}})
rej('a branch with a trailing newline is BAD_PARAM', 'BAD_PARAM', patch={'params': {'branch': 'mac-mailroom\n'}})
rej('a sha with a trailing newline is BAD_PARAM', 'BAD_PARAM', patch={'params': {'sha': A + '\n'}})
rej('a title with a trailing newline is BAD_PARAM', 'BAD_PARAM', patch=T('Mac mailroom opens PRs\n'))
rej('a submittedAt with a trailing newline is BAD_PARAM', 'BAD_PARAM', patch={'submittedAt': '2026-11-01T20:45:12Z\n'})
rej('a short sha is BAD_PARAM', 'BAD_PARAM', patch={'params': {'sha': 'abc1234'}})
rej('a title with a double quote is BAD_PARAM', 'BAD_PARAM', patch=T('Fix "quoted" thing'))
rej('a title with a dollar is BAD_PARAM', 'BAD_PARAM', patch=T('Fix $(id) thing'))
rej('a title with a mention is BAD_PARAM', 'BAD_PARAM', patch=T('Thanks @octocat'))
rej('a title with a hash ref is BAD_PARAM', 'BAD_PARAM', patch=T('Fixes #12 again'))
rej('a three-char title is BAD_PARAM', 'BAD_PARAM', patch=T('Fix'))
rej('a 101-char title is BAD_PARAM', 'BAD_PARAM', patch=T('A' * 101))
rej('an empty body is BAD_PARAM', 'BAD_PARAM', patch=B(''))
rej('a body over 64 KiB is BAD_PARAM', 'BAD_PARAM', bodyRepeat={'s': 'a', 'n': 65537})
rej('a wrong bodySha256 is BAD_PARAM', 'BAD_PARAM', ts=False, patch={'params': {'bodySha256': '0' * 64}})
rej('a bidi override in the body is BAD_TEXT', 'BAD_TEXT', patch=B('looks fine ‮ evil'))
rej('a zero-width space in the body is BAD_TEXT', 'BAD_TEXT', patch=B('a​b'))
rej('a carriage return in the body is BAD_TEXT', 'BAD_TEXT', patch=B('line\r\nline'))
rej('a NUL in the body is BAD_TEXT', 'BAD_TEXT', patch=B('a\u0000b'))
rej('a soft hyphen is BAD_TEXT', 'BAD_TEXT', patch=B('a­b'))
rej('a line separator is BAD_TEXT', 'BAD_TEXT', patch=B('a b'))
rej('a word joiner is BAD_TEXT', 'BAD_TEXT', patch=B('a⁠b'))
rej('a tag character is BAD_TEXT', 'BAD_TEXT', patch=B('a\U000e0041b'))
rej('an Arabic letter mark is BAD_TEXT', 'BAD_TEXT', patch=B('a؜b'))
rej('a variation selector is BAD_TEXT', 'BAD_TEXT', patch=B('a️b'))
rej('a supplementary variation selector is BAD_TEXT', 'BAD_TEXT', patch=B('a\U000e0100b'))
rej('a Mongolian variation selector is BAD_TEXT', 'BAD_TEXT', patch=B('a᠋b'))
rej('a Hangul filler is BAD_TEXT', 'BAD_TEXT', patch=B('aㅤb'))
rej('a cross-repo issue link in the title is XREF', 'XREF', patch=T('See https://github.com/cli/cli/issues/1'))
rej('a hex entity is BAD_TEXT', 'BAD_TEXT', patch=B('&#x40;octocat'))
rej('a named entity is BAD_TEXT', 'BAD_TEXT', patch=B('&commat;octocat'))
rej('a mention outside code is MENTION', 'MENTION', patch=B('thanks @octocat for this'))
rej('a mention at the start is MENTION', 'MENTION', patch=B('@octocat hi'))
rej('a team mention is MENTION', 'MENTION', patch=B('cc (@org/team)'))
rej('a mention after an escaped backtick is MENTION', 'MENTION', patch=B('see \\`@octocat` here'))
rej('a mention in mismatched backticks is MENTION', 'MENTION', patch=B('see `@octocat`` here'))
rej('a mention in a code span broken by a blank line is MENTION', 'MENTION', patch=B('`a\n\n@octocat\n\nb`'))
rej('a mention after an unclosed fence is MENTION', 'MENTION', patch=B('```\nopen\n@octocat'))
rej('a mention in a fence with a backtick info string is MENTION', 'MENTION', patch=B('```a`b\n@octocat\n```'))
rej('a hash ref outside code is HASH_REF', 'HASH_REF', patch=B('fixes #12'))
rej('a GH- ref is HASH_REF', 'HASH_REF', patch=B('fixes GH-12'))
rej('a cross-repo issue link is XREF', 'XREF', patch=B('see https://github.com/other/repo/issues/4'))
rej('a cross-repo PR link in caps is XREF', 'XREF', patch=B('see https://GitHub.com/other/repo/pull/4'))
opened('an email address is not a mention', patch=B('mail someone+x@example.com'))
opened('lc#day is not a hash ref', patch=B('the lc#day prefix'))
opened('a link to this repo is fine', patch=B('after https://github.com/radatta/aperture/pull/5'))
opened('a fenced block with a longer closer hides its mention', patch=B('```\n@octocat #4\n````\nafter'))

# --- files and the drain ---
c('a bad file name is parked, no result', file='notes.txt', noResult=True, calls=[])
c('a dotfile is parked, no result', file='.DS_Store', noResult=True, calls=[])
c('a symlinked entry is BAD_FILE and its target untouched', setup='symlink', expect={'status': 'rejected', 'reason': 'BAD_FILE'}, calls=[])
c('a hard link to a container file is BAD_FILE, original untouched', setup='hardlink', expect={'status': 'rejected', 'reason': 'BAD_FILE'}, calls=[])
c('a FIFO is BAD_FILE', setup='fifo', expect={'status': 'rejected', 'reason': 'BAD_FILE'}, calls=[])
c('a directory is BAD_FILE', setup='dir', expect={'status': 'rejected', 'reason': 'BAD_FILE'}, calls=[])
c('a file over 72 KiB is TOO_LARGE', setup='oversize', expect={'status': 'rejected', 'reason': 'TOO_LARGE'}, calls=[])
c('an existing result dir is a DUPLICATE, nothing runs', setup='duplicate', noResult=True, calls=[])
c('a held lock leaves the inbox alone', setup='lock', noResult=True, inboxLeft=1, calls=[])
c('a stale lock is taken', setup='stale-lock', expect={'status': 'opened'}, calls=ALL)
c('at most 5 jobs per drain', setup='many', inboxLeft=1, calls='skip')
c('a symlinked inbox is refused', setup='inbox-symlink', exit=1, noResult=True, inboxLeft=1, calls=[])
c('a .hostjobs under a symlinked parent is refused (real-path pin)', setup='parent-symlink', exit=1, noResult=True, inboxLeft=1, calls=[])
c('a symlinked .hostjobs is refused', setup='hj-symlink', exit=1, noResult=True, inboxLeft=1, calls=[])
c('a symlinked results dir is refused', setup='results-symlink', exit=1, noResult=True, inboxLeft=1, calls=[])

with open(out, 'w') as f:
    f.write(json.dumps({'base': base}) + '\n')
    f.write(json.dumps({'defaultApi': default}) + '\n')
    for x in C:
        f.write(json.dumps(x, ensure_ascii=True) + '\n')
print(len(C), 'cases')
