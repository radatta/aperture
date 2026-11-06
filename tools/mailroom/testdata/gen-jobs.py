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

# ===================================================================================================== sim job ===
# The default tape is a happy sim: axe 1.8.0, one booted aperture-devcheck, keyboard prefs 0/0, Device Hub up, the
# web app in front with its Home Screen icon on screen, Home's capture bar at the bottom, a soft keyboard (keys,
# space bar, accessory Done) and the Settings build stamp for sha aaaaaaa. Cases put their own rules first.
U = '6FDB7DD0-EA8A-48DC-8A3D-D7CC9AF2FA1F'
PW = 'FIXTUREPW-9d41'  # run-fixtures.sh: MAILROOM_FIXTURE_PW
def el(role, label, value, x, y, w, h, **k): return {'role': role, 'AXLabel': label, 'AXValue': value, 'frame': {'x': x, 'y': y, 'width': w, 'height': h}, **k}
TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max'  # sim.sh: SIM_DEVICE_TYPE
def dev(state='Booted', n=1, type_=TYPE): return {'devices': {'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{'name': 'aperture-devcheck', 'udid': U, 'state': state, 'isAvailable': True, 'deviceTypeIdentifier': type_}] * n}}
ICON = {'role': 'AXButton', 'AXLabel': 'Aperture', 'frame': {'x': 335, 'y': 200.7, 'width': 72, 'height': 94.7}}
def tree(app='Web', icon=True, page=None):
    pill = {'role': 'AXGroup', 'AXLabel': 'Search', 'AXValue': f'Page {page or (2 if icon else 1)} of 2'}
    kids = [ICON] if icon else [{'role': 'AXGroup', 'AXLabel': 'Aperture', 'frame': {'x': 0, 'y': 0, 'width': 0, 'height': 0}}]
    return [{'role': 'AXApplication', 'AXLabel': app, 'frame': {'x': 0, 'y': 0, 'width': 440, 'height': 956}, 'children': [pill] + kids}]
def pt(x, y, out, **k): return {'m': f'--point {x},{y} ', 'out': out, **k}
CAPTURE = el('AXTextArea', 'Capture log', 'What happened?', 25, 877, 346, 36)
KEYS = {'q': (26, 688), 'w': (69, 688), 'e': (113, 688), 'r': (156, 688), 't': (199, 688), 'y': (243, 688), 'u': (286, 688), 'i': (329, 688), 'o': (373, 688), 'p': (416, 688),
        'a': (48, 744), 's': (91, 744), 'd': (134, 744), 'f': (178, 744), 'g': (221, 744), 'h': (264, 744), 'j': (308, 744), 'k': (351, 744), 'l': (394, 744),
        'z': (91, 800), 'x': (134, 800), 'c': (178, 800), 'v': (221, 800), 'b': (264, 800), 'n': (308, 800), 'm': (351, 800), 'delete': (409, 800), 'space': (221, 856)}
deftape = ([{'m': 'axe --version', 'out': '1.8.0'}, {'m': 'xcodebuild -version', 'out': 'Xcode 27.2'},
            {'m': 'xcrun simctl list devices -j', 'out': dev()}, {'m': 'defaults read com.apple.keyboard.preferences', 'out': '0'},
            {'m': 'pgrep -x DeviceHub'},
            pt(220, 895, CAPTURE), pt(395, 575, el('AXButton', 'Done', '', 375, 556, 40, 38)),
            pt(57, 935, el('AXStaticText', '', 'Build aaaaaaa', 20, 852, 71, 17)),
            pt(38, 168, el('AXLink', 'Home', 'Home', 20, 158, 37, 20)), pt(136, 168, el('AXLink', 'Tasks', 'Tasks', 118, 158, 36, 20)),
            pt(395, 168, el('AXLink', 'Settings', 'Settings', 375, 158, 40, 20))]
           + [pt(x, y, el('AXButton', k, '', x - 15, y - 20, 30, 40)) for k, (x, y) in KEYS.items()]
           + [{'m': 'describe-ui --udid', 'out': tree()}])
simbase = {'v': 1, 'id': '20261104T190000Z-ios-launch-ab12', 'job': 'sim', 'submittedAt': 'now', 'expiresInMin': 10,
           'params': {'sha': A, 'timeoutSec': 300, 'shutdown': False,
                      'steps': [{'op': 'launch'}, {'op': 'readBuild'}, {'op': 'expectBuild'}, {'op': 'shot', 'name': 'home'}]}}
L = {'op': 'launch'}
def ST(*steps): return {'params': {'steps': list(steps)}}
def F(label, x, y, as_, **k): return {'op': 'find', 'label': label, 'near': {'x': x, 'y': y}, 'radius': 10, 'as': as_, **k}
NOSIM = ['axe ', 'xcrun ']
def sc(name, steps=None, **k):
    if steps is not None: k['patch'] = {**k.get('patch', {}), **ST(*steps)}
    c(name, kind='sim', **k)
def srej(name, reason, steps=None, patch=None):
    k = {'patch': patch} if patch else {}
    sc(name, steps, expect={'status': 'rejected', 'reason': reason}, simExcludes=NOSIM, ts=reason, **k)
def serr(name, detail, steps=None, reason='SIM_UNAVAILABLE', **k):
    sc(name, steps, expect={'status': 'error', 'reason': reason, 'detail': detail}, **k)
def sfail(name, detail, steps, **k): sc(name, steps, expect={'status': 'fail', 'reason': 'ASSERT', 'detail': detail}, **k)
def spass(name, steps=None, **k):
    e = {'status': 'pass', 'reason': None, **k.pop('expect', {})}
    sc(name, steps, expect=e, **k)

# --- the plan runs ---
spass('sim: launch, read the build, screenshot (the canonical plan)', ts=None,
      expect={'buildsSeen': ['aaaaaaa'], 'shots': ['shots/01-home.png'], 'signedIn': 'already', 'booted': 'warm', 'detail': None,
              'device': {'name': 'aperture-devcheck', 'udid': U, 'runtime': 'iOS 27.0', 'axe': '1.8.0', 'xcode': 'Xcode 27.2'}},
      files=['shots/01-home.png', 'progress.json'],
      simIncludes=['axe --version', 'xcrun simctl list devices -j', 'pgrep -x DeviceHub', 'defaults read com.apple.keyboard.preferences HardwareKeyboardLastSeen',
                   'batch --step button home', 'tap -x 371 -y 247 --tap-style physical', '--point 395,168', '--point 57,935', 'screenshot --output'],
      simExcludes=['axe type', 'terminate', 'bootstatus', 'defaults write'])
EVERY = [L, {'op': 'signIn'}, {'op': 'nav', 'tab': 'Tasks'}, F('Capture log', 220, 895, 'bar'), {'op': 'tap', 'label': 'Capture', 'near': {'x': 220, 'y': 895}},
         {'op': 'expect', 'as': 'bar', 'valueIs': 'What happened?'}, {'op': 'expect', 'as': 'bar', 'labelIs': 'Capture log'}, {'op': 'expect', 'as': 'bar', 'enabled': True},
         {'op': 'keys', 'text': 'ab'}, {'op': 'erase', 'n': 2}, {'op': 'blur'}, {'op': 'scroll', 'dir': 'down', 'pt': 200}, {'op': 'readBuild'},
         {'op': 'expectBuild', 'relaunches': 0}, {'op': 'shot', 'name': 'all-ops'}, {'op': 'wait', 's': 1}, {'op': 'kill', 'method': 'terminate'}, L,
         {'op': 'expect', 'signedIn': True}, {'op': 'shutdown'}]
spass('sim: a plan using every op passes', EVERY, ts=None, expect={'booted': 'off'},
      simIncludes=['tap -x 48 -y 744', 'tap -x 264 -y 800', 'tap -x 409 -y 800', 'tap -x 395 -y 575', 'swipe --start-x 220 --start-y 650 --end-x 220 --end-y 450',
                   'simctl terminate ' + U + ' com.apple.webapp', 'simctl shutdown'], simExcludes=['axe type'])

# --- plan validation (before any simctl/axe call) ---
srej('sim: a short sha is BAD_PARAM', 'BAD_PARAM', patch={'params': {'sha': 'abc1234'}})
srej('sim: timeoutSec 601 is BAD_PARAM', 'BAD_PARAM', patch={'params': {'timeoutSec': 601}})
srej('sim: timeoutSec 59 is BAD_PARAM', 'BAD_PARAM', patch={'params': {'timeoutSec': 59}})
srej('sim: an extra param (url) is BAD_PARAM', 'BAD_PARAM', patch={'params': {'url': 'https://example.com'}})
srej('sim: a non-boolean shutdown is BAD_PARAM', 'BAD_PARAM', patch={'params': {'shutdown': 'yes'}})
srej('sim: no steps is BAD_PARAM', 'BAD_PARAM', [])
srej('sim: steps as an object is BAD_PARAM', 'BAD_PARAM', patch={'params': {'steps': {'op': 'launch'}}})
srej('sim: 81 ops is TOO_MANY_OPS', 'TOO_MANY_OPS', [{'op': 'wait', 's': 1}] * 81)
srej('sim: an unknown op (openUrl) is BAD_OP', 'BAD_OP', [L, {'op': 'openUrl', 'route': '/'}])
srej('sim: an extra key on an op is BAD_OP', 'BAD_OP', [{'op': 'launch', 'url': 'x'}])
srej('sim: keys with a digit is BAD_OP', 'BAD_OP', [L, {'op': 'keys', 'text': 'a1'}])
srej('sim: keys with a capital is BAD_OP', 'BAD_OP', [L, {'op': 'keys', 'text': 'Ab'}])
srej('sim: keys with a trailing newline is BAD_OP', 'BAD_OP', [L, {'op': 'keys', 'text': 'ab\n'}])
srej('sim: keys over 24 chars is BAD_OP', 'BAD_OP', [L, {'op': 'keys', 'text': 'a' * 25}])
srej('sim: a 61-char label is BAD_OP', 'BAD_OP', [L, F('A' * 61, 200, 200, 'x')])
srej('sim: a label with a newline is BAD_OP', 'BAD_OP', [L, F('Home\n', 200, 200, 'x')])
srej('sim: a label with a dollar is BAD_OP', 'BAD_OP', [L, F('$(id)', 200, 200, 'x')])
srej('sim: near off the screen is BAD_OP', 'BAD_OP', [L, F('Home', 441, 200, 'x')])
srej('sim: radius 81 is BAD_OP', 'BAD_OP', [L, {**F('Home', 200, 200, 'x'), 'radius': 81}])
srej('sim: near and scan together are BAD_OP', 'BAD_OP', [L, {**F('Home', 200, 200, 'x'), 'scan': {'x': 200, 'from': 100, 'to': 200}}])
srej('sim: neither near nor scan is BAD_OP', 'BAD_OP', [L, {'op': 'find', 'label': 'Home', 'as': 'x'}])
srej('sim: a scan of 22 probes is BAD_OP', 'BAD_OP', [L, {'op': 'find', 'label': 'Home', 'as': 'x', 'scan': {'x': 200, 'from': 0, 'to': 630}}])
srej('sim: radius with scan is BAD_OP', 'BAD_OP', [L, {'op': 'find', 'label': 'Home', 'as': 'x', 'radius': 20, 'scan': {'x': 200, 'from': 0, 'to': 60}}])
srej('sim: an unknown role is BAD_OP', 'BAD_OP', [L, {**F('Home', 200, 200, 'x'), 'role': 'AXWindow'}])
srej('sim: wait 31 is BAD_OP', 'BAD_OP', [{'op': 'wait', 's': 31}])
srej('sim: a capitalised shot name is BAD_OP', 'BAD_OP', [L, {'op': 'shot', 'name': 'Home'}])
srej('sim: absent with an as is BAD_OP', 'BAD_OP', [L, {**F('Capture log', 200, 480, 'x'), 'op': 'absent'}])
srej('sim: erase 0 is BAD_OP', 'BAD_OP', [L, {'op': 'erase', 'n': 0}])
srej('sim: a role given as an array is BAD_OP', 'BAD_OP', [L, F('Capture log', 220, 895, 'bar', role=['AXTextArea'])])
srej('sim: signIn before any launch is BAD_OP', 'BAD_OP', [{'op': 'signIn'}, L])
srej('sim: tapping Add to today is DENIED_TAP', 'DENIED_TAP', [L, {'op': 'tap', 'label': 'Add to today', 'near': {'x': 200, 'y': 400}}])
srej('sim: a point past the profile screen is BAD_OP', 'BAD_OP', [L, F('Capture log', 441, 895, 'bar')])
srej('sim: erase 25 is BAD_OP', 'BAD_OP', [L, {'op': 'erase', 'n': 25}])
srej('sim: an unknown nav tab is BAD_OP', 'BAD_OP', [L, {'op': 'nav', 'tab': 'Admin'}])
srej('sim: a kill method off the list is BAD_OP', 'BAD_OP', [L, {'op': 'kill', 'method': 'pkill'}])
srej('sim: expect on an unknown name is BAD_OP', 'BAD_OP', [L, {'op': 'expect', 'as': 'nope', 'enabled': True}])
srej('sim: expect with two assertions is BAD_OP', 'BAD_OP', [L, F('Home', 38, 168, 'h'), {'op': 'expect', 'as': 'h', 'enabled': True, 'valueIs': 'Home'}])
srej('sim: sameWidthAs an unknown name is BAD_OP', 'BAD_OP', [L, F('Home', 38, 168, 'h'), {'op': 'expect', 'as': 'h', 'sameWidthAs': 'nope'}])
srej('sim: a reused name is BAD_OP', 'BAD_OP', [L, F('Home', 38, 168, 'h'), F('Tasks', 136, 168, 'h')])
srej('sim: a kill not followed by launch is BAD_OP', 'BAD_OP', [L, {'op': 'kill', 'method': 'terminate'}, {'op': 'nav', 'tab': 'Home'}])
srej('sim: shutdown before the last op is BAD_OP', 'BAD_OP', [L, {'op': 'shutdown'}, {'op': 'wait', 's': 1}])
srej('sim: 21 screenshots is BAD_OP', 'BAD_OP', [L] + [{'op': 'shot', 'name': f's{i}'} for i in range(21)])
srej('sim: tapping Start timer (an entry and a space) is DENIED_TAP', 'DENIED_TAP', [L, {'op': 'tap', 'label': 'Start timer', 'near': {'x': 200, 'y': 600}}])
srej('sim: tapping Focus is DENIED_TAP', 'DENIED_TAP', [L, {'op': 'tap', 'label': 'Focus', 'near': {'x': 200, 'y': 600}}])
srej('sim: tapping Mark done is DENIED_TAP', 'DENIED_TAP', [L, {'op': 'tap', 'label': 'Mark done', 'near': {'x': 200, 'y': 600}}])
srej('sim: tapping Save log is DENIED_TAP', 'DENIED_TAP', [L, {'op': 'tap', 'label': 'Save log', 'near': {'x': 360, 'y': 810}}])
srej('sim: tapping " Save " (padded) is DENIED_TAP', 'DENIED_TAP', [L, {'op': 'tap', 'label': ' Save ', 'near': {'x': 200, 'y': 600}}])
srej('sim: an unknown job field is BAD_JSON', 'BAD_JSON', patch={'device': 'iPhone'})

# --- the sim can't run it: error, so the devcheck says "needs you" ---
serr('sim: no axe is AXE_MISSING', 'AXE_MISSING', tape=[{'m': 'axe --version', 'rc': 127}], simExcludes=['describe-ui', 'bootstatus'], ts=None)
serr('sim: another axe version is AXE_VERSION', 'AXE_VERSION(1.7.0)', tape=[{'m': 'axe --version', 'out': '1.7.0'}], simExcludes=['describe-ui'])
serr('sim: no aperture-devcheck sim is SIM_MISSING', 'SIM_MISSING', tape=[{'m': 'simctl list devices -j', 'out': {'devices': {}}}])
serr('sim: two aperture-devcheck sims is SIM_AMBIGUOUS', 'SIM_AMBIGUOUS', tape=[{'m': 'simctl list devices -j', 'out': dev(n=2)}])
serr('sim: a sim of another device type is PROFILE_MISMATCH, nothing tapped', 'PROFILE_MISMATCH',
     tape=[{'m': 'simctl list devices -j', 'out': dev(type_='com.apple.CoreSimulator.SimDeviceType.iPhone-17')}], simExcludes=['tap -x', 'describe-ui'])
serr('sim: Device Hub never starting is DEVICE_HUB', 'DEVICE_HUB', tape=[{'m': 'pgrep -x DeviceHub', 'rc': 1}], simIncludes=['open -g -b com.apple.dt.Devices'])
serr('sim: a failed boot is BOOT_FAILED', 'BOOT_FAILED', tape=[{'m': 'simctl list devices -j', 'out': dev('Shutdown')}, {'m': 'bootstatus', 'rc': 1}])
serr('sim: describe-ui timing out eight times is AX_TIMEOUT', 'AX_TIMEOUT', tape=[{'m': 'describe-ui --udid', 'rc': 1, 'n': 8}])
serr('sim: an icon frame while the pill says page 1 (a stale tree, the widget under it) is WEBCLIP_MISSING, not tapped', 'WEBCLIP_MISSING',
     tape=[{'m': 'describe-ui --udid', 'out': tree(page=1)}], simExcludes=['tap -x 371'])
serr('sim: no Aperture icon is WEBCLIP_MISSING', 'WEBCLIP_MISSING', tape=[{'m': 'describe-ui --udid', 'out': tree(icon=False)}],
     simIncludes=['gesture scroll-left --screen-width 440 --screen-height 956'], simExcludes=['tap -x'])
SIGNIN = el('AXButton', 'Sign in', '', 183, 511, 74, 37, pid=67251)
SIGNED_OUT = [pt(220, 895, {}), pt(220, 530, SIGNIN, n=2), pt(220, 530, {})]  # the launch landmark, the signIn read; gone after one tap
HOST = 'aperture-dev-618015769091.auth.us-west-1.amazoncognito.com'
COGNITO = pt(228, 85, el('AXGenericElement', 'Address', '\u200e' + HOST, 10, 70, 300, 34, AXUniqueId='URL', pid=67016))
ADDR = 'rahul3datta+devcheck@gmail.com'
FORMPID = 67300
EMAIL = [pt(220, 276, el('AXTextField', 'Email', PW, 60, 258, 320, 35, pid=FORMPID), n=1), pt(220, 276, el('AXTextField', 'Email', ADDR, 36, 278, 366, 40, pid=FORMPID))]  # zoomed once focused
def pwfield(y, fy, *vals):  # one read per value, then the password itself, which only a read after the focus check gets
    f = lambda v: el('AXSecureTextField', 'Password', v, 41, fy, 320, 40, pid=FORMPID)
    return [pt(220, y, f(v), n=1) for v in vals] + [pt(220, y, f(PW))]
PWOK = ('Password', '•', 'Password')  # found empty, the x as one bullet, deleted
FORM = [COGNITO] + EMAIL + pwfield(366, 345, *PWOK) + [
        pt(220, 454, el('AXButton', 'submit', PW, 41, 430, 320, 47))]
serr('sim: no Keychain password is PASSWORD_MISSING, nothing typed', None, [L, {'op': 'signIn'}], reason='PASSWORD_MISSING', tape=SIGNED_OUT, noSimPassword=True,
     simExcludes=['axe type', '--point 228,85'])
serr('sim: a sign-in page off dev Cognito is COGNITO_HOST, nothing typed', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [pt(228, 85, el('AXGenericElement', 'Address', 'evil.example.com', 10, 70, 300, 34, AXUniqueId='URL', pid=67016))], simExcludes=['axe type'])
serr('sim: a lookalike address bar drawn by the page (its pid) is COGNITO_HOST, nothing typed', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [pt(228, 85, el('AXGenericElement', 'Address', HOST, 10, 70, 300, 34, AXUniqueId='URL', pid=67251))], simExcludes=['axe type'])
serr('sim: page text that reads like dev Cognito (no native URL id) is COGNITO_HOST, nothing typed', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [pt(228, 85, el('AXStaticText', 'Address', HOST, 10, 70, 300, 34))], simExcludes=['axe type'])
serr('sim: another account’s Cognito is COGNITO_HOST, nothing typed', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [pt(228, 85, el('AXGenericElement', 'Address', 'aperture-dev-111111111111.auth.us-west-1.amazoncognito.com', 10, 70, 300, 34, AXUniqueId='URL', pid=67016))],
     simExcludes=['axe type'])
serr('sim: the host changing before the password is COGNITO_HOST, the password never read', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [{**COGNITO, 'n': 1}, pt(228, 85, el('AXGenericElement', 'Address', 'evil.example.com', 10, 70, 300, 34, AXUniqueId='URL', pid=67016))] + FORM[1:],
     pwTyped=0, simIncludes=['axe type rahul3datta+devcheck@gmail.com'])
serr('sim: submit probes skip the filled password field (no read inside it)', 'FORM_CHANGED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [COGNITO] + EMAIL + pwfield(386, 380, *PWOK), pwTyped=1,
     simIncludes=['--point 220,454', '--point 220,424'], simExcludes=['--point 220,414'])
serr('sim: a rejected password is AUTH_REJECTED (typed once, never read back)', 'AUTH_REJECTED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + FORM, pwTyped=1, simIncludes=['axe type rahul3datta+devcheck@gmail.com', '<<<' + PW, 'tap -x 201 -y 453 --tap-style physical --pre-delay 2'])
spass('sim: a dropped Sign in tap is tapped again', [L, {'op': 'signIn'}],
      tape=[pt(220, 895, {}, n=1)] + [pt(220, 530, SIGNIN, n=3), pt(220, 530, {})] + FORM + [pt(220, 588, {})], expect={'signedIn': 'fresh'}, pwTyped=1, simCount={'tap -x 220 -y 529': 2})
spass('sim: a Sign in tap that lands is not repeated', [L, {'op': 'signIn'}],
      tape=[pt(220, 895, {}, n=1)] + SIGNED_OUT[1:] + FORM + [pt(220, 588, {})], expect={'signedIn': 'fresh'}, pwTyped=1, simCount={'tap -x 220 -y 529': 1})
serr('sim: a Sign in under another process is not tapped again', 'AUTH_REJECTED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=[pt(220, 895, {}), pt(220, 530, SIGNIN, n=2), pt(220, 530, el('AXButton', 'Sign in', '', 183, 511, 74, 37, pid=67999))] + FORM, pwTyped=1, simCount={'tap -x 220 -y 529': 1})
serr('sim: an address bar sharing the form’s process (a full page drawn elsewhere) is COGNITO_HOST, the password never read', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [pt(228, 85, el('AXGenericElement', 'Address', HOST, 10, 70, 300, 34, AXUniqueId='URL', pid=FORMPID))] + FORM[1:], pwTyped=0,
     simIncludes=['axe type rahul3datta+devcheck@gmail.com', 'simctl terminate'])
serr('sim: an address bar that changed process before the password is COGNITO_HOST, the password never read', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [{**COGNITO, 'n': 1}, pt(228, 85, el('AXGenericElement', 'Address', HOST, 10, 70, 300, 34, AXUniqueId='URL', pid=67400))] + FORM[1:], pwTyped=0)
serr('sim: a failed sign-in closes the sheet', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED', tape=SIGNED_OUT, simIncludes=['simctl terminate'], simExcludes=['axe type'])
serr('sim: a denied Keychain read of the password is PASSWORD_MISSING, nothing submitted', None, [L, {'op': 'signIn'}], reason='PASSWORD_MISSING', tape=SIGNED_OUT + FORM,
     noSimPasswordRead=True, pwTyped=0, simExcludes=['tap -x 201 -y 453'])
sfail('sim: an empty spot read as an error is still a miss', 'MISS', [L, F('Nope', 100, 300, 'x')], tape=[{'m': '--point 100,300', 'rc': 1}])
serr('sim: a point read that times out is AX_TIMEOUT, not a miss', 'AX_TIMEOUT', [L, F('Nope', 100, 300, 'x')], tape=[{'m': '--point 100,300', 'rc': 124}])
serr('sim: absent with a timed-out read is AX_TIMEOUT, never a pass', 'AX_TIMEOUT', [L, {'op': 'absent', 'label': 'Nope', 'near': {'x': 100, 'y': 300}, 'radius': 10}], tape=[{'m': '--point 100,300', 'rc': 124}])
serr('sim: a Home Screen tree with no page pill is HOME_TREE_STALE, no scroll, no tap', 'HOME_TREE_STALE',
     tape=[{'m': 'describe-ui --udid', 'out': [{'role': 'AXApplication', 'AXLabel': 'Safari', 'frame': {'x': 0, 'y': 0, 'width': 440, 'height': 956}, 'children': []}]}], simExcludes=['gesture scroll-left', 'tap -x'])
spass('sim: page 2 in the tree does not scroll', [L], simExcludes=['gesture scroll-left'])
serr('sim: two Aperture icons on page 2 is WEBCLIP_MISSING, no tap', 'WEBCLIP_MISSING',
     tape=[{'m': 'describe-ui --udid', 'out': [{'role': 'AXApplication', 'AXLabel': 'SpringBoard', 'frame': {'x': 0, 'y': 0, 'width': 440, 'height': 956}, 'children': [{'AXValue': 'Page 2 of 2'}, ICON, {**ICON, 'frame': {**ICON['frame'], 'x': 33}}]}]}], simExcludes=['tap -x 371', 'tap -x 69'])
serr('sim: Home Screen with a third page is WEBCLIP_MISSING, no tap', 'WEBCLIP_MISSING', tape=[{'m': 'describe-ui --udid', 'out': tree(page=3)}], simExcludes=['gesture scroll-left', 'tap -x 371'])
spass('sim: a sim still shutting down boots rather than failing the profile', [L], tape=[{'m': 'list devices -j', 'n': 2, 'out': dev('Shutting Down')}], simIncludes=['bootstatus'])
serr('sim: the test key landing in Email is deleted and the password never typed', 'FORM_CHANGED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [COGNITO, EMAIL[0], {**EMAIL[1], 'n': 2}, pt(220, 276, el('AXTextField', 'Email', ADDR + 'x', 36, 278, 366, 40))] + pwfield(366, 345, *['Password'] * 9),
     pwTyped=0, simIncludes=['key 27 --duration 0.2', 'key 42 --duration 0.2'])
serr('sim: a test key that lands nowhere means no password', 'FORM_CHANGED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [COGNITO] + EMAIL + pwfield(366, 345, *['Password'] * 9), pwTyped=0, simIncludes=['key 27 --duration 0.2'], simExcludes=['key 42'])
serr('sim: an unmasked Password field (the x readable) means no password', 'FORM_CHANGED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [COGNITO] + EMAIL + pwfield(366, 345, 'Password', *['x'] * 9), pwTyped=0)
serr('sim: a Password field that won’t empty after the test key means no password', 'FORM_CHANGED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [COGNITO] + EMAIL + pwfield(366, 345, 'Password', *['•'] * 9), pwTyped=0, simIncludes=['key 42 --duration 0.2'])
serr('sim: an Email field that never takes focus (no zoom after a retap) is FORM_CHANGED, nothing typed', 'FORM_CHANGED', [L, {'op': 'signIn'}],
     reason='SIGNIN_FAILED', tape=SIGNED_OUT + [COGNITO, pt(220, 276, el('AXTextField', 'Email', PW, 60, 258, 320, 35))], simExcludes=['axe type'])
serr('sim: a missing Email field is FORM_CHANGED', 'FORM_CHANGED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED', tape=SIGNED_OUT + [COGNITO], simExcludes=['axe type'])
spass('sim: a fresh sign-in types the password once, dismisses Save Password and re-arms the keyboard', [L, {'op': 'signIn'}, {'op': 'expect', 'signedIn': True}],
      tape=[pt(220, 895, {}, n=1)] + SIGNED_OUT[1:] + FORM + [pt(220, 588, el('AXButton', 'Never for This Website', '', 76, 564, 288, 48))],
      expect={'signedIn': 'fresh', 'booted': 'rebooted'}, pwTyped=1, simCount={'--point 220,366 ': 3},
      simIncludes=['--point 228,85', 'axe type rahul3datta+devcheck@gmail.com', '<<<' + PW, 'tap -x 220 -y 588',
                   'defaults write com.apple.keyboard.preferences HardwareKeyboardLastSeen -bool false',
                   'defaults write com.apple.keyboard.preferences AutomaticMinimizationEnabled -bool false', 'simctl shutdown', 'bootstatus'])
spass('sim: signIn when already signed in does nothing', [L, {'op': 'signIn'}], simExcludes=['axe type', '--point 228,85'])
serr('sim: no soft keyboard where one is due is KEYBOARD_SETUP (needs you, not a fail)', 'KEYBOARD_SETUP',
     [L, F('Capture log', 200, 417, 'bar'), {'op': 'expect', 'as': 'bar', 'aboveKeyboard': True}],
     tape=[pt(200, 417, el('AXTextArea', 'Capture log', 'What happened?', 25, 399, 308, 36)), pt(221, 856, {})])
serr('sim: keys with no soft keyboard is KEYBOARD_SETUP', 'KEYBOARD_SETUP', [L, {'op': 'keys', 'text': 'ab'}], tape=[pt(221, 856, {})], simExcludes=['tap -x 48', 'tap -x 264'])
serr('sim: a plan without launch on a shut-down sim is NOT_LAUNCHED (readiness still runs)', 'NOT_LAUNCHED', [F('Capture log', 220, 895, 'bar')],
     tape=[{'m': 'simctl list devices -j', 'out': dev('Shutdown')}], simIncludes=['axe --version', 'bootstatus'], simExcludes=['--point'])
serr('sim: an unreadable tree mid-plan is AX_TIMEOUT (needs you), not NOT_IN_APP', 'AX_TIMEOUT', [F('Capture log', 220, 895, 'bar')],
     tape=[{'m': 'describe-ui --udid', 'n': 1, 'out': tree()}, {'m': 'describe-ui --udid', 'rc': 1}])
SCAN = {'x': 200, 'from': 100, 'to': 670}  # 20 points; the label answers only at the last
serr('sim: over 400 point reads is TIMEOUT/PROBES', 'PROBES', [L] + [{'op': 'find', 'label': 'Far', 'scan': SCAN, 'as': f'f{i}'} for i in range(21)],
     reason='TIMEOUT', tape=[pt(200, 670, el('AXButton', 'Far', '', 180, 660, 40, 20))])
spass('sim: a whole number written 2.0 still counts (erase taps delete twice)', [L, {'op': 'erase', 'n': 2.0}],
      simIncludes=['tap -x 409 -y 800', 'tap -x 409 -y 800'])

# --- the row's assertion didn't hold: fail ---
spass('sim: absent passes when nothing matches', [L, {'op': 'absent', 'label': 'Capture log', 'near': {'x': 200, 'y': 480}, 'radius': 10, 'role': 'AXTextArea'}])
sfail('sim: absent fails PRESENT when the element is there', 'PRESENT', [L, {'op': 'absent', 'label': 'Capture log', 'near': {'x': 200, 'y': 480}, 'radius': 10}],
      tape=[pt(200, 480, el('AXTextArea', 'Capture log', 'What happened?', 25, 462, 346, 36))])
sfail('sim: a label nowhere near is MISS', 'MISS', [L, F('Nonexistent', 100, 100, 'x')])
sfail('sim: an off-screen match is OFF_SCREEN, not tapped', 'OFF_SCREEN', [L, {'op': 'tap', 'label': 'Far', 'near': {'x': 200, 'y': 300}, 'radius': 10}],
      tape=[pt(200, 300, el('AXButton', 'Far', '', 741, 200, 40, 40))], simExcludes=['tap -x 761'])
sfail('sim: another app in front is NOT_IN_APP', 'NOT_IN_APP', [F('Capture log', 220, 895, 'bar')], tape=[{'m': 'describe-ui --udid', 'out': tree('SpringBoard')}])
sfail('sim: a field under the keyboard is BELOW_KEYBOARD', 'BELOW_KEYBOARD', [L, F('Capture log', 220, 895, 'bar'), {'op': 'expect', 'as': 'bar', 'aboveKeyboard': True}])
spass('sim: a field above the keyboard passes', [L, F('Capture log', 200, 417, 'bar'), {'op': 'expect', 'as': 'bar', 'aboveKeyboard': True}],
      tape=[pt(200, 417, el('AXTextArea', 'Capture log', 'What happened?', 25, 399, 308, 36))])
sfail('sim: another value is VALUE, and the note says what it saw', 'VALUE', [L, F('Capture log', 220, 895, 'bar'), {'op': 'expect', 'as': 'bar', 'valueIs': 'zzqx'}],
      notes={'2': 'bar value is "What happened?", want "zzqx"'}, simIncludes=['screenshot --output'])
sfail('sim: a failed step takes one screenshot, recorded with the job', 'VALUE', [L, F('Capture log', 220, 895, 'bar'), {'op': 'expect', 'as': 'bar', 'valueIs': 'zzqx'}], simCount={'screenshot --output': 1}, files=['shots/01-fail.png'])
sfail('sim: a failure screenshot that fails leaves the row at VALUE', 'VALUE', [L, F('Capture log', 220, 895, 'bar'), {'op': 'expect', 'as': 'bar', 'valueIs': 'zzqx'}],
      tape=[{'m': 'axe screenshot', 'rc': 1}], notes={'2': 'bar value is'})
sfail('sim: a plan already at 20 shots takes no 21st on failure', 'VALUE', [L, F('Capture log', 220, 895, 'bar')] + [{'op': 'shot', 'name': f's{i}'} for i in range(20)] + [{'op': 'expect', 'as': 'bar', 'valueIs': 'zzqx'}],
      simCount={'screenshot --output': 20})
serr('sim: hung reads while launching are AX_TIMEOUT, not a landmark failure', 'AX_TIMEOUT', tape=[{'m': '--point 220,895', 'rc': 124}, {'m': '--point 220,530', 'rc': 124}])
sc('sim: a hung read after the reboot is AX_TIMEOUT, not signed out', [L, {'op': 'signIn'}],
   tape=[pt(220, 895, {}, n=1), pt(220, 895, CAPTURE, n=1), pt(220, 895, {}, n=1), pt(220, 530, SIGNIN, n=2), pt(220, 530, {}, n=1), pt(220, 530, SIGNIN, n=1), pt(220, 530, {}), {'m': '--point 220,895', 'rc': 124}] + FORM + [pt(220, 588, {})],
   expect={'status': 'error', 'reason': 'SIM_UNAVAILABLE', 'detail': 'AX_TIMEOUT'}, pwTyped=1)
sfail('sim: a value is filtered in the note (no tags, no newlines)', 'VALUE', [L, F('Capture log', 220, 895, 'bar'), {'op': 'expect', 'as': 'bar', 'valueIs': 'zzqx'}],
      tape=[pt(220, 895, CAPTURE, n=2), pt(220, 895, el('AXTextArea', 'Capture log', '<b>Z</b>' + 'y' * 60, 25, 877, 346, 36))], notes={'2': 'bar value is "bZ/b' + 'y' * 36 + '", want'})
sc('sim: signed out after the reboot is LANDMARK, a row failure, with no screenshot of the sign-in', [L, {'op': 'signIn'}],
      tape=[pt(220, 895, {}, n=1), pt(220, 895, CAPTURE, n=1), pt(220, 895, {}), pt(220, 530, SIGNIN, n=2), pt(220, 530, {}, n=1), pt(220, 530, SIGNIN)] + FORM + [pt(220, 588, {})],
      expect={'status': 'fail', 'reason': 'ASSERT', 'detail': 'LANDMARK', 'signedIn': 'false', 'booted': 'rebooted'}, pwTyped=1, simExcludes=['screenshot'])
spass('sim: the Sign in card showing a moment after the reboot still signs in', [L, {'op': 'signIn'}],
      tape=[pt(220, 895, {}, n=1), pt(220, 530, SIGNIN, n=2), pt(220, 530, {}, n=1)] + [pt(220, 895, CAPTURE, n=1), pt(220, 895, {}, n=2), pt(220, 530, SIGNIN, n=1), pt(220, 895, CAPTURE)] + FORM + [pt(220, 588, {})],
      expect={'signedIn': 'fresh'}, pwTyped=1)
sfail('sim: an enabled control expected disabled is ENABLED', 'ENABLED', [L, F('Capture log', 220, 895, 'bar'), {'op': 'expect', 'as': 'bar', 'enabled': False}])
sfail('sim: a zoomed field is WIDTH', 'WIDTH', [L, F('Capture log', 220, 895, 'bar0'), F('Capture log', 200, 417, 'bar'), {'op': 'expect', 'as': 'bar', 'sameWidthAs': 'bar0'}],
      tape=[pt(200, 417, el('AXTextArea', 'Capture log', '', 18, 399, 366, 40))])
sfail('sim: a build stale after a relaunch is STALE_BUILD', 'STALE_BUILD', [L, {'op': 'readBuild'}, {'op': 'expectBuild'}],
      tape=[pt(57, 935, el('AXStaticText', '', 'Build bbbbbbb', 20, 852, 71, 17))], simIncludes=['simctl terminate ' + U + ' com.apple.webapp'])
spass('sim: the two-launch refresh (old build, then the new one) passes', [L, {'op': 'readBuild'}, {'op': 'expectBuild'}],
      tape=[pt(57, 935, el('AXStaticText', '', 'Build bbbbbbb', 20, 852, 71, 17), n=1)], expect={'buildsSeen': ['bbbbbbb', 'aaaaaaa']})
sfail('sim: no landmark after launch is LANDMARK', 'LANDMARK', [L], tape=[pt(220, 895, {}), pt(220, 530, {})],
      simIncludes=['swipe --start-x 220 --start-y 450 --end-x 220 --end-y 250'])
sfail('sim: a prefix landing on Delete task (an entry and a space) is DENIED, not tapped', 'DENIED', [L, {'op': 'tap', 'label': 'Del', 'near': {'x': 200, 'y': 600}, 'radius': 10}],
      tape=[pt(200, 600, el('AXButton', 'Delete task', '', 150, 590, 100, 30))], simExcludes=['tap -x 200 -y 605'])
spass('sim: a label that only starts like an entry is tapped', [L, {'op': 'tap', 'label': 'Saved', 'near': {'x': 200, 'y': 600}, 'radius': 10}],
      tape=[pt(200, 600, el('AXButton', 'Saved', '', 150, 590, 100, 30))], simIncludes=['tap -x 200 -y 605'])
sfail('sim: a prefix that lands on a write button is DENIED, not tapped', 'DENIED', [L, {'op': 'tap', 'label': 'Sav', 'near': {'x': 200, 'y': 300}, 'radius': 10}],
      tape=[pt(200, 300, el('AXButton', 'Save', '', 180, 280, 80, 40))], simExcludes=['tap -x 220 -y 300'], ts=None)
sfail('sim: a key not where the layout puts it is MISS', 'MISS', [L, {'op': 'keys', 'text': 'z'}], tape=[pt(91, 800, el('AXButton', 'x', '', 76, 780, 30, 40))],
      simExcludes=['tap -x 91 -y 800'])

# --- recipes ---
spass('sim: keyboard prefs at 1 are re-armed with a reboot', [L], tape=[{'m': 'defaults read com.apple.keyboard.preferences', 'out': '1', 'n': 1}],
      expect={'booted': 'rebooted'}, simIncludes=['defaults write com.apple.keyboard.preferences HardwareKeyboardLastSeen -bool false',
                                                  'defaults write com.apple.keyboard.preferences AutomaticMinimizationEnabled -bool false', 'simctl shutdown', 'bootstatus'])
spass('sim: a shut-down sim is booted cold', [L], tape=[{'m': 'simctl list devices -j', 'out': dev('Shutdown')}], expect={'booted': 'cold'}, simIncludes=['bootstatus'])
spass('sim: an icon on the other Home Screen page is reached with scroll-left', [L], tape=[{'m': 'describe-ui --udid', 'out': tree(icon=False), 'n': 2}],
      simIncludes=['gesture scroll-left --screen-width 440 --screen-height 956', 'tap -x 371 -y 247'])
spass('sim: a stale first landmark read is read again', [L], tape=[pt(220, 895, el('AXRadioButton', 'Capture log', '1', 25, 877, 346, 36), n=1)],
      expect={'signedIn': 'already'})
spass('sim: kill by app switcher', [L, {'op': 'kill', 'method': 'switcher'}, L, {'op': 'expect', 'signedIn': True}],
      simIncludes=['batch --step button home --step sleep 0.15 --step button home --step sleep 1.5', 'swipe --start-x 340 --start-y 560 --end-x 340 --end-y 40',
                   'tap -x 400 -y 880 --tap-style physical'])
spass('sim: kill by reboot', [L, {'op': 'kill', 'method': 'reboot'}, L], expect={'booted': 'rebooted'}, simIncludes=['simctl shutdown', 'bootstatus'])
spass('sim: keys are tapped on the soft keyboard, never typed', [L, {'op': 'keys', 'text': 'zq x'}],
      simIncludes=['tap -x 91 -y 800', 'tap -x 26 -y 688', 'tap -x 221 -y 856', 'tap -x 134 -y 800'], simExcludes=['axe type'])
spass('sim: a nav tab off the row is found after a swipe', [L, {'op': 'nav', 'tab': 'Settings'}], tape=[pt(395, 168, {}, n=1)],
      simIncludes=['swipe --start-x 398 --start-y 168 --end-x 40 --end-y 168', 'tap -x 395 -y 168'])
spass('sim: shutdown: true shuts the sim down after a pass', patch={'params': {'shutdown': True}}, expect={'booted': 'off'}, simIncludes=['simctl shutdown'])
spass('sim: a bare shutdown of a sim already off does nothing more', [{'op': 'shutdown'}], expect={'booted': 'off'}, tape=[{'m': 'list devices -j', 'out': dev('Shutdown')}], ts=None)
spass('sim: a bare shutdown resolves the device first', [{'op': 'shutdown'}], expect={'booted': 'off'},
      simIncludes=['simctl list devices -j', 'simctl shutdown ' + U], simExcludes=['describe-ui', 'bootstatus'])
sc('sim: an existing result dir is a DUPLICATE, nothing runs', setup='duplicate', noResult=True, simExcludes=NOSIM)

with open(out, 'w') as f:
    f.write(json.dumps({'base': base, 'simBase': simbase}) + '\n')
    f.write(json.dumps({'defaultApi': default, 'defaultTape': deftape}) + '\n')
    for x in C:
        f.write(json.dumps(x, ensure_ascii=True) + '\n')
print(len(C), 'cases')
