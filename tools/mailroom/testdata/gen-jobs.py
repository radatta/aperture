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
# sim.sh's pinned keyboard prefs (SIM_KB_OFF / SIM_KB_ON) as `defaults export` prints them, on one line (the tape is a line).
KB_OFF = ['KeyboardAutocorrection', 'KeyboardAutocapitalization', 'KeyboardCheckSpelling', 'KeyboardPrediction', 'KeyboardShowPredictionBar',
          'KeyboardInlineCompletion', 'KeyboardPeriodShortcut', 'SmartQuotesEnabled', 'SmartDashesEnabled', 'KeyboardContinuousPathEnabled',
          'HWKeyboardAutocorrection', 'HWKeyboardAutocapitalization', 'HWKeyboardPeriodShortcut']
KB_ON = ['DidShowContinuousPathIntroduction', 'DidShowGestureKeyboardIntroduction', 'DidShowInlineCompletionEducationTip']
def kbx(over=None, drop=()):
    v = {**{k: '<false/>' for k in KB_OFF}, **{k: '<true/>' for k in KB_ON}, 'HardwareKeyboardLastSeen': '<integer>0</integer>', **(over or {})}
    return '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' + ''.join(f'<key>{k}</key>{x}' for k, x in v.items() if k not in drop) + '</dict></plist>'
deftape = ([{'m': 'axe --version', 'out': '1.8.0'}, {'m': 'xcodebuild -version', 'out': 'Xcode 27.2'},
            {'m': 'xcrun simctl list devices -j', 'out': dev()}, {'m': 'defaults read com.apple.keyboard.preferences', 'out': '0'},
            {'m': 'defaults export com.apple.keyboard.preferences', 'out': kbx()},
            {'m': 'pgrep -x DeviceHub'}, {'m': 'Web.app/Web', 'rc': 1},  # the web app: not running unless a case says so
            pt(220, 895, CAPTURE), pt(395, 575, el('AXButton', 'Done', '', 375, 556, 40, 38)),
            pt(57, 935, el('AXStaticText', '', 'Build aaaaaaa', 20, 852, 71, 17)),
            pt(38, 168, el('AXLink', 'Home', 'Home', 20, 158, 37, 20)), pt(136, 168, el('AXLink', 'Tasks', 'Tasks', 118, 158, 36, 20)),
            pt(395, 168, el('AXLink', 'Settings', 'Settings', 375, 158, 40, 20)),
            pt(340, 560, el('AXGenericElement', 'Aperture', 'Active', 239, 136, 306, 664))]  # the switcher's card (round A)
           + [pt(x, y, el('AXButton', k, '', x - 15, y - 20, 30, 40)) for k, (x, y) in KEYS.items()]
           + [{'m': 'describe-ui --udid', 'out': tree()}])
simbase = {'v': 1, 'id': '20261104T190000Z-ios-launch-ab12', 'job': 'sim', 'submittedAt': 'now', 'expiresInMin': 10,
           'params': {'sha': A, 'timeoutSec': 300, 'shutdown': False,
                      'steps': [{'op': 'launch'}, {'op': 'readBuild'}, {'op': 'expectBuild'}, {'op': 'shot', 'name': 'home'}]}}
L = {'op': 'launch'}
def ST(*steps): return {'params': {'steps': list(steps)}}
def F(label, x, y, as_, **k): return {'op': 'find', 'label': label, 'near': {'x': x, 'y': y}, 'radius': 10, 'as': as_, **k}
NOSIM = ['axe ', 'xcrun ']
# Trees for the read-backs (home presses, the switcher, the icon tap).
def dtree(out, n=0): return {'m': 'describe-ui --udid', 'out': out, 'n': n}
FULL = {'x': 0, 'y': 0, 'width': 440, 'height': 956}
APPFRONT = [{'role': 'AXApplication', 'AXLabel': 'Web', 'frame': FULL, 'children': []}]  # the incident: the app, no pill
SWITCHER = [{'role': 'AXApplication', 'AXLabel': 'SpringBoard', 'frame': FULL, 'children': [{**ICON, 'frame': {'x': 120, 'y': 200, 'width': 200, 'height': 430}}]}]
KS = [L, {'op': 'kill', 'method': 'switcher'}, L, {'op': 'expect', 'signedIn': True}]
DOUBLE, SWIPE, LEAVE, PRESS = 'button home --step sleep 0.15', 'swipe --start-x 340 --start-y 560 --end-x 340 --end-y 40', 'tap -x 400 -y 880', 'home --step sleep 1 --udid'
WEB = 'pgrep -f RuntimeRoot/Applications/Web.app/Web'
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
      files=['shots/01-home.png', 'progress.json', 'plan.json'],
      simIncludes=['axe --version', 'xcrun simctl list devices -j', 'pgrep -x DeviceHub', 'defaults read com.apple.keyboard.preferences HardwareKeyboardLastSeen',
                   'batch --step button home', 'tap -x 371 -y 247 --tap-style physical', '--point 395,168', '--point 57,935', 'screenshot --output'],
      simExcludes=['axe type', 'terminate', 'bootstatus', 'defaults write'])
EVERY = [L, {'op': 'signIn'}, {'op': 'nav', 'tab': 'Tasks'}, F('Capture log', 220, 895, 'bar'), {'op': 'tap', 'label': 'Capture', 'near': {'x': 220, 'y': 895}},
         {'op': 'expect', 'as': 'bar', 'valueIs': 'What happened?'}, {'op': 'expect', 'as': 'bar', 'labelIs': 'Capture log'}, {'op': 'expect', 'as': 'bar', 'enabled': True},
         {'op': 'keys', 'text': 'ab'}, {'op': 'erase', 'n': 2}, {'op': 'blur'}, {'op': 'scroll', 'dir': 'down', 'pt': 200}, {'op': 'readBuild'},
         {'op': 'expectBuild', 'relaunches': 0}, {'op': 'shot', 'name': 'all-ops'}, {'op': 'wait', 's': 1}, {'op': 'kill', 'method': 'terminate'}, L,
         {'op': 'expect', 'signedIn': True}, {'op': 'shutdown'}]
SPACE = el('AXButton', 'space', '', 206, 836, 30, 40)
KB_GOES = [pt(221, 856, SPACE, n=3), pt(221, 856, {})]  # the field tap, keys and erase see the keyboard; after blur's Done it's gone
spass('sim: a plan using every op passes', EVERY, ts=None, expect={'booted': 'off'}, tape=KB_GOES,
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
srej('sim: tapping send (the capture bar\'s return key) is DENIED_TAP', 'DENIED_TAP', [L, {'op': 'tap', 'label': 'send', 'near': {'x': 400, 'y': 856}}])
srej('sim: keys in an unknown name is BAD_OP', 'BAD_OP', [L, {'op': 'keys', 'text': 'ab', 'in': 'nope'}])
srej('sim: keys in a name defined after it is BAD_OP', 'BAD_OP', [L, {'op': 'keys', 'text': 'ab', 'in': 'bar'}, F('Capture log', 220, 895, 'bar')])
srej('sim: keys in a capitalised name is BAD_OP', 'BAD_OP', [L, F('Capture log', 220, 895, 'Bar'), {'op': 'keys', 'text': 'ab', 'in': 'Bar'}])
srej('sim: keys in a number is BAD_OP', 'BAD_OP', [L, F('Capture log', 220, 895, 'bar'), {'op': 'keys', 'text': 'ab', 'in': 1}])
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
# The dev account id stays out of tracked files (docs/ops/IDENTIFIERS.md): run-fixtures.sh fills @DEV_ACCOUNT@ from
# sim.sh's own pin, so this host always matches the runner under test.
HOST = 'aperture-dev-@DEV_ACCOUNT@.auth.us-west-1.amazoncognito.com'
COGNITO = pt(228, 85, el('AXGenericElement', 'Address', '\u200e' + HOST, 10, 70, 300, 34, AXUniqueId='URL', pid=67016))
ADDR = 'devcheck@dev.aperture.rahuldatta.dev'
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
     pwTyped=0, simIncludes=['axe type devcheck@dev.aperture.rahuldatta.dev'])
serr('sim: submit probes skip the filled password field (no read inside it)', 'FORM_CHANGED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [COGNITO] + EMAIL + pwfield(386, 380, *PWOK), pwTyped=1,
     simIncludes=['--point 220,454', '--point 220,424'], simExcludes=['--point 220,414'])
serr('sim: a rejected password is AUTH_REJECTED (typed once, never read back)', 'AUTH_REJECTED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + FORM, pwTyped=1, simIncludes=['axe type devcheck@dev.aperture.rahuldatta.dev', '<<<' + PW, 'tap -x 201 -y 453 --tap-style physical --pre-delay 2'])
spass('sim: a dropped Sign in tap is tapped again', [L, {'op': 'signIn'}],
      tape=[pt(220, 895, {}, n=1)] + [pt(220, 530, SIGNIN, n=3), pt(220, 530, {})] + FORM + [pt(220, 588, {})], expect={'signedIn': 'fresh'}, pwTyped=1, simCount={'tap -x 220 -y 529': 2})
spass('sim: a Sign in tap that lands is not repeated', [L, {'op': 'signIn'}],
      tape=[pt(220, 895, {}, n=1)] + SIGNED_OUT[1:] + FORM + [pt(220, 588, {})], expect={'signedIn': 'fresh'}, pwTyped=1, simCount={'tap -x 220 -y 529': 1})
serr('sim: a Sign in under another process is not tapped again', 'AUTH_REJECTED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=[pt(220, 895, {}), pt(220, 530, SIGNIN, n=2), pt(220, 530, el('AXButton', 'Sign in', '', 183, 511, 74, 37, pid=67999))] + FORM, pwTyped=1, simCount={'tap -x 220 -y 529': 1})
serr('sim: an address bar sharing the form’s process (a full page drawn elsewhere) is COGNITO_HOST, the password never read', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [pt(228, 85, el('AXGenericElement', 'Address', HOST, 10, 70, 300, 34, AXUniqueId='URL', pid=FORMPID))] + FORM[1:], pwTyped=0,
     simIncludes=['axe type devcheck@dev.aperture.rahuldatta.dev', 'simctl terminate'])
serr('sim: an address bar that changed process before the password is COGNITO_HOST, the password never read', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + [{**COGNITO, 'n': 1}, pt(228, 85, el('AXGenericElement', 'Address', HOST, 10, 70, 300, 34, AXUniqueId='URL', pid=67400))] + FORM[1:], pwTyped=0)
serr('sim: a failed sign-in closes the sheet', 'COGNITO_HOST', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED', tape=SIGNED_OUT, simIncludes=['simctl terminate'], simExcludes=['axe type'])
serr('sim: a denied Keychain read of the password is PASSWORD_MISSING, nothing submitted', None, [L, {'op': 'signIn'}], reason='PASSWORD_MISSING', tape=SIGNED_OUT + FORM,
     noSimPasswordRead=True, pwTyped=0, simExcludes=['tap -x 201 -y 453'])
sfail('sim: an empty spot read as an error is still a miss', 'MISS', [L, F('Nope', 100, 300, 'x')], tape=[{'m': '--point 100,300', 'rc': 1}])
serr('sim: a point read that times out is AX_TIMEOUT, not a miss', 'AX_TIMEOUT', [L, F('Nope', 100, 300, 'x')], tape=[{'m': '--point 100,300', 'rc': 124}])
serr('sim: absent with a timed-out read is AX_TIMEOUT, never a pass', 'AX_TIMEOUT', [L, {'op': 'absent', 'label': 'Nope', 'near': {'x': 100, 'y': 300}, 'radius': 10}], tape=[{'m': '--point 100,300', 'rc': 124}])
serr('sim: a Home Screen tree with no page pill is HOME_TREE_STALE, no scroll, no tap', 'HOME_TREE_STALE',
     tape=[{'m': 'describe-ui --udid', 'out': [{'role': 'AXApplication', 'AXLabel': 'Safari', 'frame': {'x': 0, 'y': 0, 'width': 440, 'height': 956}, 'children': []}]}], simExcludes=['gesture scroll-left', 'tap -x'],
     simCount={'home --step sleep 1 --udid': 3})
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
      simIncludes=['--point 228,85', 'axe type devcheck@dev.aperture.rahuldatta.dev', '<<<' + PW, 'tap -x 220 -y 588',
                   'defaults write com.apple.keyboard.preferences HardwareKeyboardLastSeen -bool false',
                   'defaults write com.apple.keyboard.preferences AutomaticMinimizationEnabled -bool false', 'simctl shutdown', 'bootstatus'])
spass('sim: signIn when already signed in does nothing', [L, {'op': 'signIn'}], simExcludes=['axe type', '--point 228,85'])
serr('sim: no soft keyboard where one is due is KEYBOARD_SETUP (needs you, not a fail)', 'KEYBOARD_SETUP',
     [L, F('Capture log', 200, 417, 'bar'), {'op': 'expect', 'as': 'bar', 'aboveKeyboard': True}],
     tape=[pt(200, 417, el('AXTextArea', 'Capture log', 'What happened?', 25, 399, 308, 36)), pt(221, 856, {})], files=['shots/01-fail.png'])
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
sfail('sim: one hung read while launching, the rest answering and seeing neither landmark, is LANDMARK', 'LANDMARK', [L],
      tape=[{'m': '--point 220,895', 'rc': 124, 'n': 1}, pt(220, 895, {}), pt(220, 530, {})])
sc('sim: one hung read after the reboot, the rest seeing the Sign in card, is LANDMARK', [L, {'op': 'signIn'}],
   tape=[pt(220, 895, {}, n=1), pt(220, 895, CAPTURE, n=1), pt(220, 895, {}, n=2), {'m': '--point 220,895', 'rc': 124, 'n': 1}, pt(220, 895, {}), pt(220, 530, SIGNIN, n=2), pt(220, 530, {}, n=1), pt(220, 530, SIGNIN)] + FORM + [pt(220, 588, {})],
   expect={'status': 'fail', 'reason': 'ASSERT', 'detail': 'LANDMARK', 'signedIn': 'false'}, pwTyped=1)
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

# --- a hung read is the sim's, never a miss or a wrong runbook row ---
HANG = lambda m: {'m': m, 'rc': 124}
serr('sim: a hung read in the nav row is AX_TIMEOUT, not a missing tab', 'AX_TIMEOUT', [L, {'op': 'nav', 'tab': 'Home'}], tape=[HANG('--point 38,168')])
serr('sim: a hung read of a key is AX_TIMEOUT, not a moved layout', 'AX_TIMEOUT', [L, {'op': 'keys', 'text': 'z'}], tape=[HANG('--point 91,800')], simExcludes=['tap -x 91 -y 800'])
serr('sim: a hung re-read in expect is AX_TIMEOUT, not VALUE', 'AX_TIMEOUT', [L, F('Capture log', 220, 895, 'bar'), {'op': 'expect', 'as': 'bar', 'valueIs': 'What happened?'}],
     tape=[pt(220, 895, CAPTURE, n=2), HANG('--point 220,895')])
spass('sim: a build stamp unread on the first visit gets a second visit (the stand-in for a dropped Settings tap)', [L, {'op': 'readBuild'}],
      tape=[{'m': '--point 57,', 'out': {}, 'n': 21}], notes={'1': 'running aaaaaaa; went to Settings again'}, simCount={'tap -x 395 -y 168': 2},
      expect={'buildsSeen': ['aaaaaaa']})
sfail('sim: no build stamp after two visits is MISS', 'MISS', [L, {'op': 'readBuild'}], tape=[{'m': '--point 57,', 'out': {}}],
      notes={'1': 'after two Settings visits'}, simCount={'tap -x 395 -y 168': 2})
serr('sim: a hung stamp read on the second visit is AX_TIMEOUT, not MISS', 'AX_TIMEOUT', [L, {'op': 'readBuild'}],
     tape=[{'m': '--point 57,', 'out': {}, 'n': 21}, HANG('--point 57,')], simCount={'tap -x 395 -y 168': 2})
spass('sim: the relaunch\'s second visit stays in expectBuild\'s note', [L, {'op': 'readBuild'}, {'op': 'expectBuild'}],
      tape=[pt(57, 935, el('AXStaticText', '', 'Build bbbbbbb', 20, 852, 71, 17), n=1), {'m': '--point 57,', 'out': {}, 'n': 21}],
      notes={'2': 'second aaaaaaa; went to Settings again'}, expect={'buildsSeen': ['bbbbbbb', 'aaaaaaa']})
spass('sim: a build stamp found on the first visit is read once', [L, {'op': 'readBuild'}], notes={'1': 'running aaaaaaa'}, simCount={'tap -x 395 -y 168': 1})
serr('sim: hung reads of the build stamp are AX_TIMEOUT, not a missing stamp', 'AX_TIMEOUT', [L, {'op': 'readBuild'}], tape=[HANG('--point 57,')])
serr('sim: a hung read of the space bar is AX_TIMEOUT, not KEYBOARD_SETUP', 'AX_TIMEOUT', [L, {'op': 'keys', 'text': 'ab'}], tape=[HANG('--point 221,856')], simExcludes=['tap -x 48'])
serr('sim: hung reads of the accessory bar in blur are AX_TIMEOUT, never "no keyboard"', 'AX_TIMEOUT', [L, {'op': 'blur'}], tape=[HANG('--point 395,')])
serr('sim: hung reads after submit are AX_TIMEOUT, not AUTH_REJECTED', 'AX_TIMEOUT', [L, {'op': 'signIn'}],
     tape=[pt(220, 895, {}, n=1), HANG('--point 220,895'), pt(220, 530, SIGNIN, n=2), pt(220, 530, {})] + FORM, pwTyped=1)

# --- keys read the field back ---
BAR = F('Capture log', 220, 895, 'bar')
def typed(v, x=220, **k): return pt(x, 895, el('AXStaticText', '', v, 33, 469, 10 * len(v), 22), **k)  # x 198: the bar's frame centre, the second look
spass('sim: keys in a field read it back once', [L, BAR, {'op': 'keys', 'text': 'ab', 'in': 'bar'}],
      tape=[pt(220, 895, CAPTURE, n=2), typed('Ab')], notes={'2': 'typed 2 keys'}, simCount={'tap -x 48 -y 744': 1}, simExcludes=['tap -x 409 -y 800'])
spass('sim: a slow key gets a second look, not a retype', [L, BAR, {'op': 'keys', 'text': 'ab', 'in': 'bar'}],
      tape=[pt(220, 895, CAPTURE, n=2), typed('A'), typed('Ab', 198)], notes={'2': 'typed 2 keys'}, simCount={'tap -x 48 -y 744': 1, '--point 198,895': 1},
      simExcludes=['tap -x 409 -y 800'])
spass('sim: a dropped key is erased and retyped once, and the note says so', [L, BAR, {'op': 'keys', 'text': 'ab', 'in': 'bar'}],
      tape=[pt(220, 895, CAPTURE, n=2), typed('A', n=1), typed('A', 198, n=1), typed('Ab')],
      notes={'2': 'typed 2 keys; retyped once (first read AXStaticText "A")'}, simCount={'tap -x 48 -y 744': 2, 'tap -x 264 -y 800': 2, 'tap -x 409 -y 800': 4})
spass('sim: a second drop is retyped twice', [L, BAR, {'op': 'keys', 'text': 'ab', 'in': 'bar'}],
      tape=[pt(220, 895, CAPTURE, n=2), typed('A', n=2), typed('A', 198, n=2), typed('Ab')], notes={'2': 'retyped twice'}, simCount={'tap -x 48 -y 744': 3, 'tap -x 409 -y 800': 8})
sfail('sim: a field that never holds the text is TYPED, with what it read and a screenshot', 'TYPED', [L, BAR, {'op': 'keys', 'text': 'ab', 'in': 'bar'}],
      tape=[pt(220, 895, CAPTURE, n=2), typed('A'), typed('A', 198)], notes={'2': 'typed "ab" 3 times; the field reads AXStaticText "A" at 220,895'},
      simCount={'tap -x 48 -y 744': 3, 'tap -x 409 -y 800': 8}, files=['shots/01-fail.png'])
serr('sim: a hung read-back is AX_TIMEOUT, not TYPED', 'AX_TIMEOUT', [L, BAR, {'op': 'keys', 'text': 'ab', 'in': 'bar'}],
     tape=[pt(220, 895, CAPTURE, n=2), HANG('--point 220,895')], simExcludes=['tap -x 409 -y 800'])
# erase … in reads the field back (job …230610Z…-done-form-4385: six deletes left a Z): empty is "" or the placeholder.
def left(v, x=220, **k): return pt(x, 895, el('AXTextArea', 'Capture log', v, 25, 877, 346, 36), **k)
ER = [L, BAR, {'op': 'erase', 'n': 2, 'in': 'bar'}]
DEL = 'tap -x 409 -y 800'
spass('sim: erase in a field reads it back once; the placeholder is empty', ER, tape=[pt(220, 895, CAPTURE, n=2)], notes={'2': 'erased 2'},
      simCount={DEL: 2, '--point 198,895': 0})
spass('sim: erase: an empty value is empty', ER, tape=[pt(220, 895, CAPTURE, n=2), left('')], notes={'2': 'erased 2'}, simCount={DEL: 2})
spass('sim: a dropped delete (a letter left) is deleted again, and the note says so', ER,
      tape=[pt(220, 895, CAPTURE, n=2), left('A', n=1), left('A', 198, n=1)], notes={'2': 'erased 2; deleted 3 more (first read AXTextArea "A")'},
      simCount={DEL: 5})
spass('sim: letters still left after the extra deletes get a second round', ER,
      tape=[pt(220, 895, CAPTURE, n=2), left('Ab', n=1), left('Ab', 198, n=1), left('A', n=1), left('A', 198, n=1)],
      notes={'2': 'deleted more twice, 4 and 3 (first read AXTextArea "Ab")'}, simCount={DEL: 9})
sfail('sim: a field that never empties is ERASED, with what it read and a screenshot', 'ERASED', ER,
      tape=[pt(220, 895, CAPTURE, n=2), left('A'), left('A', 198)], notes={'2': 'the field still reads AXTextArea "A" at 220,895'},
      simCount={DEL: 8}, files=['shots/01-fail.png'])
serr('sim: a hung erase read-back is AX_TIMEOUT, not ERASED', 'AX_TIMEOUT', ER, tape=[pt(220, 895, CAPTURE, n=2), HANG('--point 220,895')], simCount={DEL: 2})
spass('sim: another element at the find point gets the centre look, no extra deletes', ER,
      tape=[pt(220, 895, CAPTURE, n=2), pt(220, 895, el('AXStaticText', 'Reflection', '', 53, 205, 80, 20), n=1), pt(198, 895, CAPTURE)],
      notes={'2': 'erased 2'}, simCount={'--point 198,895': 1, DEL: 2})
sfail('sim: an empty-valued element that isn\'t the field never passes as empty: the field moved is MISS', 'MISS', ER,
      tape=[pt(220, 895, CAPTURE, n=2), pt(220, 895, el('AXStaticText', 'Reflection', '', 53, 205, 80, 20)), pt(198, 895, el('AXStaticText', 'Reflection', '', 53, 205, 80, 20))],
      notes={'2': "the field `bar` found isn't at 220,895 or its centre after erasing (saw AXStaticText \"\")"}, simCount={DEL: 2})
sfail('sim: the field\'s label on another role never passes as empty', 'MISS', ER,
      tape=[pt(220, 895, CAPTURE, n=2), pt(220, 895, el('AXStaticText', 'Capture log', '', 25, 877, 346, 36)), pt(198, 895, el('AXStaticText', 'Capture log', '', 25, 877, 346, 36))],
      simCount={DEL: 2})
srej('sim: erase in an unknown name is BAD_OP', 'BAD_OP', [L, {'op': 'erase', 'n': 2, 'in': 'nope'}])
srej('sim: erase in a name defined after it is BAD_OP', 'BAD_OP', [L, {'op': 'erase', 'n': 2, 'in': 'bar'}, BAR])
srej('sim: erase in a number is BAD_OP', 'BAD_OP', [L, BAR, {'op': 'erase', 'n': 2, 'in': 1}])
# tap … closes: the element must be gone after the tap (…4385: the Cancel tap left the task modal open).
CANCEL = el('AXButton', 'Cancel', '', 150, 590, 100, 30)
CL = [L, {'op': 'tap', 'label': 'Cancel', 'near': {'x': 200, 'y': 600}, 'radius': 10, 'role': 'AXButton', 'closes': True}]
CTAP, CREAD = 'tap -x 200 -y 605', '--point 200,605'
spass('sim: a closes tap whose element is gone passes with one tap', CL, tape=[pt(200, 600, CANCEL, n=1)], simCount={CTAP: 1, CREAD: 1})
spass('sim: a closes tap whose element is still there 1 s later is tapped once more, and the note says so', CL,
      tape=[pt(200, 600, CANCEL, n=1), pt(200, 605, CANCEL, n=2)], notes={'1': 'tapped again (still there after the first)'}, simCount={CTAP: 2, CREAD: 3})
sfail('sim: a closes tap still there after the second tap is TAP_DROPPED', 'TAP_DROPPED', CL,
      tape=[pt(200, 600, CANCEL, n=1), pt(200, 605, CANCEL)], simCount={CTAP: 2, CREAD: 4}, files=['shots/01-fail.png'])
spass('sim: a closes tap replaced by another element at that spot counts as gone', CL,
      tape=[pt(200, 600, CANCEL, n=1), pt(200, 605, el('AXStaticText', '', 'TODAY 1', 40, 595, 100, 20))], simCount={CTAP: 1})
spass('sim: a slow close (gone at the second look) is not tapped again', CL, tape=[pt(200, 600, CANCEL, n=1), pt(200, 605, CANCEL, n=1)],
      simCount={CTAP: 1, CREAD: 2})
serr('sim: a hung look after a closes tap is AX_TIMEOUT', 'AX_TIMEOUT', CL, tape=[pt(200, 600, CANCEL, n=1), HANG(CREAD)], simCount={CTAP: 1})
srej('sim: closes false on a tap is BAD_OP', 'BAD_OP', [L, {'op': 'tap', 'label': 'Cancel', 'near': {'x': 200, 'y': 600}, 'closes': False}])
srej('sim: closes on a find is BAD_OP', 'BAD_OP', [L, {**F('Cancel', 200, 600, 'c'), 'closes': True}])
sfail('sim: a miss names an unlabelled element by its value', 'MISS', [L, F('Zzqx', 100, 300, 'x')], tape=[pt(100, 300, el('AXStaticText', '', 'Zzq', 33, 290, 30, 22))],
      notes={'1': 'saw: Zzq)'})
sfail('sim: a miss names a match its role excluded', 'MISS', [L, F('Capture', 100, 300, 'x', role='AXButton')],
      tape=[pt(100, 300, el('AXTextArea', 'Capture log', '', 25, 290, 346, 36))], notes={'1': 'saw: Capture log (AXTextArea))'})

# --- taps that must have landed ---
spass('sim: blur taps Done again when the keyboard stays up', [L, {'op': 'blur'}], tape=[pt(221, 856, SPACE, n=1), pt(221, 856, {})],
      notes={'1': 'dismissed on the second tap'}, simCount={'tap -x 395 -y 575': 2})
spass('sim: a keyboard that goes down late gets no second tap where Done was', [L, {'op': 'blur'}],
      tape=[pt(221, 856, SPACE, n=1), pt(221, 856, {}), pt(395, 575, el('AXButton', 'Done', '', 375, 556, 40, 38), n=1), {'m': '--point 395,', 'out': el('AXButton', 'Mark done', '', 340, 556, 100, 38)}],
      notes={'1': 'keyboard dismissed'}, simCount={'tap -x 395 -y 575': 1}, simExcludes=['tap -x 390'])
TAPBAR = {'op': 'tap', 'label': 'Capture', 'near': {'x': 220, 'y': 895}}
spass('sim: a field tap that brings no keyboard, still none a second later, with the field still there, is tapped once more', [L, TAPBAR],
      tape=[pt(221, 856, {}, n=2), pt(198, 895, CAPTURE)], notes={'1': 'tapped again (no keyboard after the first)'}, simCount={'tap -x 198 -y 895': 2})
spass('sim: a keyboard that comes up late is not tapped into (job …014933Z…-capture-7ac9 typed a space)', [L, TAPBAR],
      tape=[pt(221, 856, {}, n=1)], notes={'1': 'the keyboard came up late'}, simCount={'tap -x 198 -y 895': 1})
spass('sim: no keyboard, but something else at the field\'s spot, is not tapped again', [L, TAPBAR],
      tape=[pt(221, 856, {}, n=2), pt(198, 895, el('AXButton', 'space', '', 100, 880, 240, 40))],
      notes={'1': 'not tapped again (the field\'s spot reads AXButton space)'}, simCount={'tap -x 198 -y 895': 1})
spass('sim: a field tap that brings the keyboard is not repeated', [L, TAPBAR], simCount={'tap -x 198 -y 895': 1})
spass('sim: a button tap never checks for the keyboard', [L, {'op': 'tap', 'label': 'Home', 'near': {'x': 38, 'y': 168}, 'radius': 10}],
      simCount={'tap -x 38 -y 168': 1, '--point 221,856': 0})
serr('sim: a hung keyboard read after a field tap is AX_TIMEOUT', 'AX_TIMEOUT', [L, TAPBAR], tape=[HANG('--point 221,856')], simCount={'tap -x 198 -y 895': 1})
spass('sim: blur checks the keyboard went down once', [L, {'op': 'blur'}], tape=[pt(221, 856, {})], notes={'1': 'keyboard dismissed'}, simCount={'tap -x 395 -y 575': 1})
sfail('sim: a keyboard that stays up after two Done taps is BLUR', 'BLUR', [L, {'op': 'blur'}], simCount={'tap -x 395 -y 575': 2})
spass('sim: blur with no keyboard up does nothing', [L, {'op': 'blur'}], tape=[pt(395, 575, {})], notes={'1': 'no keyboard to dismiss'}, simExcludes=['tap -x 395'])
spass('sim: a dropped icon tap (still on the Home Screen) is tapped again at the third poll, not swiped', [L],
      tape=[pt(220, 895, {}, n=3), {'m': 'describe-ui --udid', 'out': tree('SpringBoard')}], simCount={'tap -x 371 -y 247': 2},
      notes={'0': 'icon tapped 2 times'}, simExcludes=['swipe --start-x 220 --start-y 450'])
spass('sim: icon taps that keep dropping are tapped again at polls 3, 6 and 10', [L],
      tape=[pt(220, 895, {}, n=11), {'m': 'describe-ui --udid', 'out': tree('SpringBoard')}], simCount={'tap -x 371 -y 247': 4},
      notes={'0': 'icon tapped 4 times'})
sfail('sim: still the Home Screen after four icon taps is ICON_TAP_DROPPED, not LANDMARK', 'ICON_TAP_DROPPED', [L],
      tape=[pt(220, 895, {}), {'m': 'describe-ui --udid', 'out': tree('SpringBoard')}], simCount={'tap -x 371 -y 247': 4}, files=['shots/01-fail.png'])
sfail('sim: the app in front without its landmark stays LANDMARK, its icon never tapped again', 'LANDMARK', [L],
      tape=[pt(220, 895, {}), pt(221, 856, {}), dtree(tree(), 3), dtree(APPFRONT)],  # keyboard down: no mid-typing relaunch
      simCount={'tap -x 371 -y 247': 1, 'swipe --start-x 220 --start-y 450': 1, 'simctl terminate': 0, 'tap -x 409 -y 800': 0})
FORMP = FORM[:-1] + [pt(220, 454, el('AXButton', 'submit', PW, 41, 430, 320, 47, pid=FORMPID))]
serr('sim: a hung re-read of the submit button is AX_TIMEOUT, not AUTH_REJECTED', 'AX_TIMEOUT', [L, {'op': 'signIn'}],
     tape=SIGNED_OUT + FORMP[:-1] + [{**FORMP[-1], 'n': 1}, HANG('--point 220,454')], pwTyped=1, simCount={'tap -x 201 -y 453': 1})
spass('sim: a dropped submit tap is tapped again on the same form', [L, {'op': 'signIn'}],
      tape=[pt(220, 895, {}, n=13)] + SIGNED_OUT[1:] + FORMP + [pt(220, 588, {})], expect={'signedIn': 'fresh'}, pwTyped=1, simCount={'tap -x 201 -y 453': 2})
serr('sim: a password still rejected after the retap is AUTH_REJECTED', 'AUTH_REJECTED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + FORMP, pwTyped=1, simCount={'tap -x 201 -y 453': 2})
serr('sim: a submit button under another process is not tapped again', 'AUTH_REJECTED', [L, {'op': 'signIn'}], reason='SIGNIN_FAILED',
     tape=SIGNED_OUT + FORM, pwTyped=1, simCount={'tap -x 201 -y 453': 1})

# --- shutdown says when it fails ---
serr('sim: a shutdown simctl refuses is SHUTDOWN_FAILED', 'SHUTDOWN_FAILED', [{'op': 'shutdown'}], tape=[{'m': 'simctl shutdown', 'rc': 1}], ts=None)
spass('sim: shutdown: true that fails leaves the rows passed and booted warm', patch={'params': {'shutdown': True}}, expect={'booted': 'warm'},
      tape=[{'m': 'simctl shutdown', 'rc': 1}])
serr('sim: a reboot whose shutdown fails is SHUTDOWN_FAILED, no boot', 'SHUTDOWN_FAILED', [L, {'op': 'kill', 'method': 'reboot'}, L],
     tape=[{'m': 'simctl shutdown', 'rc': 1}], simExcludes=['bootstatus'])

# --- recipes ---
KBX = 'defaults export com.apple.keyboard.preferences'
spass('sim: keyboard prefs already pinned are read once, never written', [L], simCount={KBX: 1}, simExcludes=['defaults write', 'terminate'])
spass('sim: a keyboard pref missing or on is pinned (all of them), the app quit, read back, and the launch note says so', [L],
      tape=[{'m': KBX, 'out': kbx({'KeyboardAutocapitalization': '<true/>'}, drop=['KeyboardPrediction']), 'n': 1}],
      notes={'0': 'pinned the keyboard prefs (2 off)'}, simCount={KBX: 2, 'defaults write com.apple.keyboard.preferences': 16},
      simIncludes=['defaults write com.apple.keyboard.preferences KeyboardAutocorrection -bool false',
                   'defaults write com.apple.keyboard.preferences DidShowGestureKeyboardIntroduction -bool true', 'simctl terminate'])
spass('sim: a tip not marked seen is pinned too', [L], tape=[{'m': KBX, 'out': kbx({'DidShowGestureKeyboardIntroduction': '<false/>'}), 'n': 1}],
      notes={'0': 'pinned the keyboard prefs (1 off)'})
spass('sim: keyboard prefs stored as integers count as pinned', [L],
      tape=[{'m': KBX, 'out': kbx({**{k: '<integer>0</integer>' for k in KB_OFF}, **{k: '<integer>1</integer>' for k in KB_ON}})}], simExcludes=['defaults write'])
serr('sim: keyboard prefs that don\'t take are KEYBOARD_SETUP, naming them', 'KEYBOARD_SETUP', [L], tape=[{'m': KBX, 'out': kbx(drop=['KeyboardPrediction'])}],
     notes={'0': "keyboard prefs didn't take: KeyboardPrediction"}, simExcludes=['tap -x 371'])
serr('sim: an unreadable keyboard domain is pinned, then KEYBOARD_SETUP if it stays unreadable', 'KEYBOARD_SETUP', [L], tape=[{'m': KBX, 'rc': 1}])
serr('sim: a plan without launch after the prefs were pinned is NOT_LAUNCHED', 'NOT_LAUNCHED', [F('Capture log', 220, 895, 'bar')],
     tape=[{'m': KBX, 'out': kbx(drop=['KeyboardPrediction']), 'n': 1}])
spass('sim: keyboard prefs at 1 are re-armed with a reboot', [L], tape=[{'m': 'defaults read com.apple.keyboard.preferences', 'out': '1', 'n': 1}],
      expect={'booted': 'rebooted'}, simIncludes=['defaults write com.apple.keyboard.preferences HardwareKeyboardLastSeen -bool false',
                                                  'defaults write com.apple.keyboard.preferences AutomaticMinimizationEnabled -bool false', 'simctl shutdown', 'bootstatus'])
spass('sim: a shut-down sim is booted cold', [L], tape=[{'m': 'simctl list devices -j', 'out': dev('Shutdown')}], expect={'booted': 'cold'}, simIncludes=['bootstatus'])
spass('sim: an icon on the other Home Screen page is reached with scroll-left', [L], tape=[{'m': 'describe-ui --udid', 'out': tree(icon=False), 'n': 2}],
      simIncludes=['gesture scroll-left --screen-width 440 --screen-height 956', 'tap -x 371 -y 247'])
spass('sim: a stale first landmark read is read again', [L], tape=[pt(220, 895, el('AXRadioButton', 'Capture log', '1', 25, 877, 346, 36), n=1)],
      expect={'signedIn': 'already'})
# The switcher and home presses are read back (job …192707Z…-relaunch-bd33: AXe reported presses iOS never got). One launch
# reads the tree three times (ready, then two icon reads that agree), so a kill's own read is the fourth.
spass('sim: kill by app switcher', KS, tape=[dtree(tree(), 3), dtree(SWITCHER, 2)], notes={'1': 'killed by switcher; web: gone'},
      simIncludes=['batch --step button home --step sleep 0.15 --step button home --step sleep 1.5', SWIPE, 'tap -x 400 -y 880 --tap-style physical', WEB],
      simCount={DOUBLE: 1, SWIPE: 1, LEAVE: 1})
spass('sim: a dropped switcher press (the app still in front) is pressed again before any swipe', KS,
      tape=[dtree(tree(), 3), dtree(APPFRONT, 1), dtree(SWITCHER, 2)], notes={'1': "killed by switcher; web: gone; the switcher didn't open (Web)"},
      simCount={DOUBLE: 2, SWIPE: 1, LEAVE: 1})
spass('sim: one press of the two landing (the Home Screen) is pressed again, not swiped', KS,
      tape=[dtree(tree(), 3), dtree(tree('SpringBoard'), 1), dtree(SWITCHER, 2)], notes={'1': "the switcher didn't open (SpringBoard, Page 2 of 2)"},
      simCount={DOUBLE: 2, SWIPE: 1, LEAVE: 1})
sfail('sim: the app still in front after two switcher tries is SWITCHER_FAILED, never swiped or tapped', 'SWITCHER_FAILED', KS,
      tape=[dtree(tree(), 3), dtree(APPFRONT, 2)], simCount={DOUBLE: 2, SWIPE: 0, LEAVE: 0}, files=['shots/01-fail.png'])
spass('sim: an app still running after the card swipe is swiped again', KS,
      tape=[dtree(tree(), 3), dtree(SWITCHER, 3), {'m': 'Web.app/Web', 'out': '4242', 'n': 2}], notes={'1': 'still running after the swipe'},
      simCount={DOUBLE: 1, SWIPE: 2, LEAVE: 1, WEB: 5})  # 2 alive, then gone before and after the wait, then the note's
serr('sim: an app still running after two card swipes is SWITCHER_FAILED, needs you (re-trial the gesture); the switcher is left', 'SWITCHER_FAILED', KS,
     notes={'1': "the switcher swipe didn't kill the app: re-trial the gesture"},
      tape=[dtree(tree(), 3), dtree(SWITCHER, 2), {'m': 'Web.app/Web', 'out': '4242'}], simCount={DOUBLE: 1, SWIPE: 2, LEAVE: 1}, files=['shots/01-fail.png'])
spass("sim: a switcher without Aperture's card at the swipe spot is not swiped; pressed again", KS,
      tape=[dtree(tree(), 3), dtree(SWITCHER, 3), pt(340, 560, el('AXGenericElement', 'Safari', '', 0, 136, 230, 664), n=1)],
      notes={'1': 'no Aperture card at 340,560 (AXGenericElement Safari)'}, simCount={DOUBLE: 2, SWIPE: 1, LEAVE: 2})
sfail('sim: no Aperture card in two tries is SWITCHER_FAILED, never swiped', 'SWITCHER_FAILED', KS,
      tape=[dtree(tree(), 3), dtree(SWITCHER, 2), pt(340, 560, {})], simCount={DOUBLE: 2, SWIPE: 0, LEAVE: 2},
      notes={'1': 'no Aperture card in the app switcher in two tries'})
serr('sim: a hung card read is AX_TIMEOUT, no swipe', 'AX_TIMEOUT', KS, tape=[dtree(tree(), 3), dtree(SWITCHER, 1), HANG('--point 340,560')], simCount={SWIPE: 0})
spass('sim: a switcher that closed itself with the last card is not tapped (the spot is a dock icon)', KS,
      tape=[dtree(tree(), 3), dtree(SWITCHER, 1), dtree(tree('SpringBoard'), 1)], notes={'1': 'no switcher left to leave (SpringBoard, Page 2 of 2)'},
      simCount={SWIPE: 1, LEAVE: 0})
serr('sim: an unreadable tree after the switcher press is AX_TIMEOUT, no swipe', 'AX_TIMEOUT', KS,
     tape=[dtree(tree(), 3), {'m': 'describe-ui --udid', 'rc': 1}], simCount={SWIPE: 0, LEAVE: 0})
spass('sim: kill by terminate says the web app is gone', [L, {'op': 'kill', 'method': 'terminate'}, L], notes={'1': 'killed by terminate; web: gone'})
spass('sim: a dropped home press at launch (the app still in front) is pressed again', [L],
      tape=[dtree(tree(), 1), dtree(APPFRONT, 1)], notes={'0': 'home pressed 2 times'}, simCount={PRESS: 2}, simIncludes=['tap -x 371 -y 247'])
sfail('sim: the app still in front after three home presses is HOME_PRESS_DROPPED, not HOME_TREE_STALE', 'HOME_PRESS_DROPPED', [L],
      tape=[dtree(tree(), 1), dtree(APPFRONT)], simCount={PRESS: 3}, simExcludes=['tap -x 371', 'gesture scroll-left'], files=['shots/01-fail.png'])
spass('sim: kill by reboot', [L, {'op': 'kill', 'method': 'reboot'}, L], expect={'booted': 'rebooted'}, simIncludes=['simctl shutdown', 'bootstatus'])
spass('sim: keys are tapped on the soft keyboard, never typed', [L, {'op': 'keys', 'text': 'zq x'}],
      simIncludes=['tap -x 91 -y 800', 'tap -x 26 -y 688', 'tap -x 221 -y 856', 'tap -x 134 -y 800'], simExcludes=['axe type'])
spass('sim: a nav tab off the row is found after a swipe', [L, {'op': 'nav', 'tab': 'Settings'}], tape=[pt(395, 168, {}, n=1)],
      simIncludes=['swipe --start-x 398 --start-y 168 --end-x 40 --end-y 168', 'tap -x 395 -y 168'])
spass('sim: shutdown: true shuts the sim down after a pass', patch={'params': {'shutdown': True}}, expect={'booted': 'off'}, simIncludes=['simctl shutdown'])
spass('sim: a bare shutdown of a sim already off does nothing more', [{'op': 'shutdown'}], expect={'booted': 'off'}, tape=[{'m': 'list devices -j', 'out': dev('Shutdown')}], ts=None)
spass('sim: a bare shutdown resolves the device first', [{'op': 'shutdown'}], expect={'booted': 'off'},
      simIncludes=['simctl list devices -j', 'simctl shutdown ' + U], simExcludes=['describe-ui', 'bootstatus'])
# --- the input-gap trial: keys/erase `via` (IOS-CHECK.md -> Input-gap trial) ---
def KV(via, text='ab'): return [L, BAR, {'op': 'keys', 'text': text, 'in': 'bar', 'via': via}]
def EV(via, n=2): return [L, BAR, {'op': 'erase', 'n': n, 'in': 'bar', 'via': via}]
def BATCH(lead, *xy): return 'batch --tap-style physical --step sleep ' + lead + ''.join((' --step sleep 0.6' if i else '') + f' --step tap -x {x} -y {y}' for i, (x, y) in enumerate(xy)) + ' --udid'
AB, D409 = [(48, 744), (264, 800)], (409, 800)
TRIAL = 'trial.jsonl'
srej('sim: a via off the list is BAD_OP', 'BAD_OP', [L, BAR, {'op': 'keys', 'text': 'ab', 'via': 'env'}])
srej('sim: via on a find is BAD_OP', 'BAD_OP', [L, {**BAR, 'via': 'batch'}])
srej('sim: via without in is BAD_OP (its count is the read-back)', 'BAD_OP', [L, BAR, {'op': 'keys', 'text': 'ab', 'via': 'tap'}])
spass('sim: a whole word dropped (the field still reads its placeholder) counts every letter', KV('batch'),
      tape=[pt(220, 895, CAPTURE, n=3), pt(198, 895, CAPTURE, n=1), typed('Ab')], notes={'2': 'via batch, drops 2; retyped once'},
      fileHas=[[TRIAL, '"op":"keys","via":"batch","n":2,"drops":2']])
spass('sim: an erase drop the first look saw counts even when the centre look hits another element', EV('batch'),
      tape=[pt(220, 895, CAPTURE, n=2), left('A', n=1), pt(198, 895, el('AXStaticText', 'Reflection', '', 53, 205, 80, 20), n=1)],
      notes={'2': 'erased 2; via batch, drops 1; deleted 3 more'}, simCount={BATCH('1', *[D409] * 3): 1},
      fileHas=[[TRIAL, '"op":"erase","via":"batch","n":2,"drops":1']])
spass('sim: keys via tap (the baseline) is the per-key path, counted in trial.jsonl with the load', KV('tap'),
      tape=[pt(220, 895, CAPTURE, n=2), typed('Ab')], notes={'2': 'typed 2 keys; via tap, drops 0'}, simCount={'tap -x 48 -y 744 --tap-style physical --udid': 1},
      simExcludes=['batch --tap-style', 'hid=', '--post-delay'], fileHas=[[TRIAL, '{"load":{"start":'], [TRIAL, '"op":"keys","via":"tap","n":2,"drops":0']])
spass('sim: keys without via write no trial.jsonl and no via note', [L, BAR, {'op': 'keys', 'text': 'ab', 'in': 'bar'}],
      tape=[pt(220, 895, CAPTURE, n=2), typed('Ab')], filesAbsent=[TRIAL], simExcludes=['batch --tap-style'])
spass('sim: keys via post tap with --post-delay 0.5', KV('post'), tape=[pt(220, 895, CAPTURE, n=2), typed('Ab')], notes={'2': 'via post, drops 0'},
      simCount={'tap -x 48 -y 744 --tap-style physical --post-delay 0.5 --udid': 1, 'tap -x 264 -y 800 --tap-style physical --post-delay 0.5 --udid': 1})
spass('sim: keys via hid set AXe\'s stabilisation wait on the taps only', KV('hid'), tape=[pt(220, 895, CAPTURE, n=2), typed('Ab')], notes={'2': 'via hid, drops 0'},
      simCount={'tap -x 48 -y 744 --tap-style physical --udid ' + U + ' hid=500': 1, 'tap -x 264 -y 800 --tap-style physical --udid ' + U + ' hid=500': 1, 'hid=': 2})
serr('sim: a failed hid tap still clears the wait (the failure screenshot carries none)', 'AXE_FAILED', KV('hid'),
     tape=[pt(220, 895, CAPTURE, n=2), {'m': 'tap -x 48 -y 744', 'rc': 1}], simCount={'hid=': 1, 'screenshot --output': 1})
spass('sim: keys via batch read every key, then tap them in one batch after a 1 s lead', KV('batch'), tape=[pt(220, 895, CAPTURE, n=2), typed('Ab')],
      notes={'2': 'typed 2 keys; via batch, drops 0'}, simIncludes=['--point 48,744', '--point 264,800', BATCH('1', *AB)],
      simExcludes=['tap -x 48 -y 744 --tap-style'], simCount={'batch --tap-style': 1})
spass('sim: keys via batch15 lead 1.5 s', KV('batch15'), tape=[pt(220, 895, CAPTURE, n=2), typed('Ab')], simCount={BATCH('1.5', *AB): 1})
sfail('sim: a key off its spot under batch is MISS before any batch goes out', 'MISS', KV('batch'),
      tape=[pt(220, 895, CAPTURE, n=2), pt(264, 800, el('AXButton', 'n', '', 249, 780, 30, 40))], simExcludes=['batch --tap-style'])
serr('sim: a failed key batch is AXE_FAILED, never a pass', 'AXE_FAILED', KV('batch'), tape=[pt(220, 895, CAPTURE, n=2), {'m': 'batch --tap-style', 'rc': 1}])
spass('sim: a key dropped under batch is counted, then erased and retyped by batch', KV('batch'),
      tape=[pt(220, 895, CAPTURE, n=2), typed('A', n=1), typed('A', 198, n=1), typed('Ab')],
      notes={'2': 'typed 2 keys; via batch, drops 1; retyped once (first read AXStaticText "A")'},
      simCount={BATCH('1', *AB): 2, BATCH('1', *[D409] * 4): 1}, simExcludes=['tap -x 409 -y 800 --tap-style'],
      fileHas=[[TRIAL, '"op":"keys","via":"batch","n":2,"drops":1']])
spass('sim: a slow field under a trial counts no drop (the second look holds the text)', KV('batch'),
      tape=[pt(220, 895, CAPTURE, n=2), typed('A'), typed('Ab', 198)], notes={'2': 'via batch, drops 0'}, simCount={'batch --tap-style': 1})
spass('sim: erase via batch: one batch of deletes; a letter left is counted and deleted again by batch', EV('batch'),
      tape=[pt(220, 895, CAPTURE, n=2), left('A', n=1), left('A', 198, n=1)], notes={'2': 'erased 2; via batch, drops 1; deleted 3 more (first read AXTextArea "A")'},
      simCount={BATCH('1', *[D409] * 2): 1, BATCH('1', *[D409] * 3): 1}, simExcludes=['tap -x 409 -y 800 --tap-style'],
      fileHas=[[TRIAL, '"op":"erase","via":"batch","n":2,"drops":1']])
spass('sim: erase via tap is the per-key path, counted', EV('tap'), tape=[pt(220, 895, CAPTURE, n=2)], notes={'2': 'erased 2; via tap, drops 0'},
      simCount={DEL: 2}, simExcludes=['batch --tap-style'], fileHas=[[TRIAL, '"op":"erase","via":"tap","n":2,"drops":0']])
sfail('sim: a field that moved under a trial erase is MISS, no drop counted', 'MISS', EV('batch'),
      tape=[pt(220, 895, CAPTURE, n=2), pt(220, 895, el('AXStaticText', 'Reflection', '', 53, 205, 80, 20)), pt(198, 895, el('AXStaticText', 'Reflection', '', 53, 205, 80, 20))],
      filesAbsent=[TRIAL])
sc('sim: an existing result dir is a DUPLICATE, nothing runs', setup='duplicate', noResult=True, simExcludes=NOSIM)

# --- speed-ups (B–E): every fast path has its miss, and the miss is today's path ---
NAVTOP = 'swipe --start-x 220 --start-y 250 --end-x 220 --end-y 882'  # sim_to_top's swipe, 8 a time
NT = [L, {'op': 'nav', 'tab': 'Tasks'}]
spass('sim: nav reads the tab where it sits and taps it, no swipes (fast)', NT, notes={'1': 'on Tasks (fast)'},
      simCount={NAVTOP: 0, '--point 136,168': 1, 'tap -x 136 -y 168': 1})
spass('sim: a tab off the row\'s y (the page scrolled) is the full path', NT, tape=[pt(136, 168, el('AXLink', 'Tasks', 'Tasks', 118, 190, 36, 20), n=1)],
      simCount={NAVTOP: 8, 'tap -x 136 -y 168': 1, 'tap -x 136 -y 200': 0})
spass('sim: another tab at the spot (the row swiped) is the full path', [L, {'op': 'nav', 'tab': 'Home'}],
      tape=[pt(38, 168, el('AXLink', 'Log', 'Log', 20, 158, 37, 20), n=1)], simCount={NAVTOP: 8, 'tap -x 38 -y 168': 1})
spass('sim: the tab\'s label on something not a link is the full path', NT, tape=[pt(136, 168, el('AXStaticText', 'Tasks', 'Tasks', 118, 158, 36, 20), n=1)],
      simCount={NAVTOP: 8, 'tap -x 136 -y 168': 1})
spass('sim: a hung fast read falls through to the full path, not AX_TIMEOUT', NT, tape=[{'m': '--point 136,168', 'rc': 124, 'n': 1}],
      notes={'1': 'on Tasks'}, simCount={NAVTOP: 8, 'tap -x 136 -y 168': 1})
sfail('sim: a hung fast read, then a full path that reads and misses, is MISS', 'MISS', NT, tape=[{'m': '--point 136,168', 'rc': 124, 'n': 1}, pt(136, 168, {})],
      simCount={NAVTOP: 8})
sfail('sim: a fast miss and a full miss is still MISS', 'MISS', NT, tape=[pt(136, 168, {})], simCount={NAVTOP: 8}, simExcludes=['tap -x 136'])
spass('sim: Settings has no fast read (past the row\'s edge until swiped)', [L, {'op': 'nav', 'tab': 'Settings'}], simCount={NAVTOP: 8, '--point 395,168': 1})
STAMP = lambda b: el('AXStaticText', '', f'Build {b}', 20, 852, 71, 17)
spass('sim: readBuild goes back Home by default', [L, {'op': 'readBuild'}], simCount={'tap -x 395 -y 168': 1, 'tap -x 38 -y 168': 1})
spass('sim: readBuild with stay ends on Settings', [L, {'op': 'readBuild', 'stay': True}], notes={'1': 'running aaaaaaa; stayed on Settings'},
      simCount={'tap -x 395 -y 168': 1, 'tap -x 38 -y 168': 0})
spass('sim: expectBuild\'s relaunch keeps readBuild\'s stay', [L, {'op': 'readBuild', 'stay': True}, {'op': 'expectBuild'}],
      tape=[pt(57, 935, STAMP('bbbbbbb'), n=1)], expect={'buildsSeen': ['bbbbbbb', 'aaaaaaa']}, simCount={'tap -x 395 -y 168': 2, 'tap -x 38 -y 168': 0})
spass('sim: readBuild reads the stamp first where it was last found', [L, {'op': 'readBuild'}, {'op': 'readBuild'}],
      tape=[pt(57, 935, {}), pt(57, 920, {}), pt(57, 905, STAMP('aaaaaaa'))], simCount={'--point 57,935': 1, '--point 57,920': 1, '--point 57,905': 2})
spass('sim: a stamp moved from its last y is found by the full scan', [L, {'op': 'readBuild'}], setup='build-y=905',
      tape=[pt(57, 905, {}), pt(57, 935, {}), pt(57, 920, STAMP('aaaaaaa'))], simIncludes=['--point 57,905', '--point 57,935', '--point 57,920'],
      simCount={'--point 57,905': 1}, expect={'buildsSeen': ['aaaaaaa']})
spass('sim: a stored y that isn\'t one of the stamp\'s is ignored', [L, {'op': 'readBuild'}], setup='build-y=999', simExcludes=['--point 57,999'],
      simCount={'--point 57,935': 1})
sfail('sim: a stored y and no stamp anywhere is still MISS after two visits', 'MISS', [L, {'op': 'readBuild'}], setup='build-y=905',
      tape=[{'m': '--point 57,', 'out': {}}], simCount={'tap -x 395 -y 168': 2, '--point 57,905': 2})
REFL = el('AXTextArea', 'Reflection', '', 53, 283, 334, 67)
HF = {'op': 'find', 'label': 'Reflection', 'scan': {'x': 200, 'from': 150, 'to': 720}, 'hint': {'x': 200, 'y': 316}, 'as': 'box'}
spass('sim: a scan\'s hint is read first, and a hit there ends it', [L, HF], tape=[pt(200, 316, REFL)], simCount={'--point 200,316': 1, '--point 200,150': 0})
spass('sim: a hint that misses scans as before', [L, HF], tape=[pt(200, 316, {}), pt(200, 240, {**REFL, 'frame': {'x': 53, 'y': 210, 'width': 334, 'height': 67}})],
      simIncludes=['--point 200,316', '--point 200,150', '--point 200,180', '--point 200,210', '--point 200,240'], simExcludes=['--point 200,270'])
sfail('sim: a hint miss and a scan miss is still MISS', 'MISS', [L, HF], simCount={'--point 200,316': 1, '--point 200,720': 1})
spass('sim: a tap with a hint taps what the hint found', [L, {'op': 'tap', 'label': 'Cancel', 'scan': {'x': 190, 'from': 150, 'to': 720}, 'hint': {'x': 190, 'y': 378}, 'role': 'AXButton'}],
      tape=[pt(190, 378, el('AXButton', 'Cancel', '', 160, 360, 60, 36))], simIncludes=['tap -x 190 -y 378'], simCount={'--point 190,150': 0})
sfail('sim: a hung hint read, then a scan that reads and misses, is MISS', 'MISS', [L, HF], tape=[{'m': '--point 200,316', 'rc': 124, 'n': 1}])
serr('sim: a hung scan read after a hint miss is still AX_TIMEOUT', 'AX_TIMEOUT', [L, HF], tape=[pt(200, 316, {}), HANG('--point 200,240')])
spass('sim: a hint read with the label but the wrong role scans on', [L, {**HF, 'role': 'AXTextArea'}],
      tape=[pt(200, 316, {**REFL, 'role': 'AXStaticText'}), pt(200, 240, {**REFL, 'frame': {'x': 53, 'y': 210, 'width': 334, 'height': 67}})],
      simIncludes=['--point 200,316', '--point 200,150', '--point 200,240'])
spass('sim: a stored y of two of the stamp\'s ys is ignored', [L, {'op': 'readBuild'}], setup='build-y=935 920',
      tape=[pt(57, 935, {}), pt(57, 920, {}), pt(57, 905, STAMP('aaaaaaa'))], simCount={'--point 57,935': 1, '--point 57,920': 1})
spass('sim: a stored y that isn\'t a number is ignored', [L, {'op': 'readBuild'}], setup='build-y=abc', simCount={'--point 57,935': 1})
spass('sim: stay after a second Settings visit says both', [L, {'op': 'readBuild', 'stay': True}], tape=[{'m': '--point 57,', 'out': {}, 'n': 21}],
      notes={'1': 'running aaaaaaa; went to Settings again (no stamp the first time); stayed on Settings'}, simCount={'tap -x 38 -y 168': 0})
spass('sim: a fast nav read with no frame is the full path', NT, tape=[pt(136, 168, {'role': 'AXLink', 'AXLabel': 'Tasks', 'AXValue': 'Tasks'}, n=1)],
      simCount={NAVTOP: 8, 'tap -x 136 -y 168': 1})
srej('sim: a hint off its scan\'s line is BAD_OP', 'BAD_OP', [L, {**HF, 'hint': {'x': 230, 'y': 316}}])
srej('sim: a hint past its scan\'s range is BAD_OP', 'BAD_OP', [L, {**HF, 'hint': {'x': 200, 'y': 721}}])
srej('sim: a hint beside near is BAD_OP', 'BAD_OP', [L, {**F('Home', 200, 200, 'x'), 'hint': {'x': 200, 'y': 200}}])
srej('sim: a hint on absent is BAD_OP', 'BAD_OP', [L, {'op': 'absent', 'label': 'Home', 'scan': {'x': 200, 'from': 100, 'to': 200}, 'hint': {'x': 200, 'y': 150}}])
srej('sim: a hint off the screen is BAD_OP', 'BAD_OP', [L, {**HF, 'hint': {'x': 200, 'y': 957}}])
srej('sim: a hint with an extra key is BAD_OP', 'BAD_OP', [L, {**HF, 'hint': {'x': 200, 'y': 316, 'r': 10}}])
srej('sim: a hint that isn\'t whole is BAD_OP', 'BAD_OP', [L, {**HF, 'hint': {'x': 200.5, 'y': 316}}])
srej('sim: readBuild stay false is BAD_OP', 'BAD_OP', [L, {'op': 'readBuild', 'stay': False}])
srej('sim: readBuild with another key is BAD_OP', 'BAD_OP', [L, {'op': 'readBuild', 'home': True}])

# --- launch onto an app left mid-typing by an aborted job (…043422Z…-trial-idle-2; the next five failed LANDMARK) ---
TERM = 'simctl terminate ' + U
spass('sim: launch onto an app left mid-typing (keyboard up, no landmark) relaunches it once', [L],
      tape=[pt(220, 895, {}, n=3), pt(220, 530, {}, n=3), {'m': 'Web.app/Web', 'rc': 0, 'n': 1}], notes={'0': 'relaunched (it resumed mid-typing, keyboard up)'},
      simCount={TERM: 1}, simIncludes=[TERM, 'Web.app/Web', 'batch --step button home', 'tap -x 371 -y 247'])
spass('sim: a keyboard first seen at poll 6 relaunches then, and the polls start again', [L],
      tape=[pt(220, 895, {}, n=7), pt(220, 530, {}, n=6), pt(221, 856, {}, n=1), {'m': 'Web.app/Web', 'rc': 0, 'n': 1}],  # 7: poll 3 also looks for a draft
      notes={'0': 'relaunched'}, simCount={TERM: 1, '--point 220,895': 8})
serr('sim: a relaunch whose terminate fails says it was launch\'s relaunch', 'TERMINATE', [L],
     tape=[pt(220, 895, {}, n=3), pt(220, 530, {}, n=3), {'m': 'Web.app/Web', 'rc': 0, 'n': 1}, {'m': 'simctl terminate', 'rc': 1}],
     notes={'0': "simctl terminate failed (in launch's relaunch of an app left mid-typing)"})
sfail('sim: still no landmark after the relaunch is LANDMARK, relaunched once only', 'LANDMARK', [L],
      tape=[pt(220, 895, {}), pt(220, 530, {}), {'m': 'Web.app/Web', 'rc': 0, 'n': 1}], simCount={TERM: 1})
sfail('sim: no landmark and no keyboard is LANDMARK as before, no relaunch', 'LANDMARK', [L],
      tape=[pt(220, 895, {}), pt(220, 530, {}), pt(221, 856, {})], simCount={TERM: 0})
spass('sim: a relaunch onto a web app already gone skips the terminate (simctl refuses one)', [L],
      tape=[pt(220, 895, {}, n=3), pt(220, 530, {}, n=3)], notes={'0': 'keyboard up; no web process though the tree showed the app, so not terminated)'}, simCount={TERM: 0, 'tap -x 371 -y 247': 2})
serr('sim: a web app that survives the relaunch\'s terminate is TERMINATE', 'TERMINATE', [L],
     tape=[pt(220, 895, {}, n=3), pt(220, 530, {}, n=3), {'m': 'Web.app/Web', 'rc': 0}], simCount={TERM: 1})

# --- launch onto a bar holding a leftover draft (…060606Z…-idle5-1; reads: empty label, the draft as value) ---
DRAFT = el('AXStaticText', '', 'wkbpxa', 25, 884, 346, 22)  # spans 100 and 220: the peek jobs saw it at both
DEL = 'tap -x 409 -y 800'
KB_DRAFT = [pt(221, 856, {}, n=1), pt(221, 856, SPACE, n=1), pt(221, 856, {})]  # down at poll 3, up after the tap, down after Done
spass('sim: launch onto a leftover draft deletes it, and Home\'s bar is the read-back', [L],
      tape=[pt(220, 895, DRAFT, n=4)] + KB_DRAFT, notes={'0': 'deleted a leftover draft in the bar (8 deletes)'},
      simCount={DEL: 8, 'simctl terminate': 0}, simIncludes=['tap -x 198 -y 895', DEL, 'tap -x 395 -y 575'])
sfail('sim: a leftover draft that stays after its deletes is LANDMARK, deleted once only', 'LANDMARK', [L],
      tape=[pt(220, 895, DRAFT)] + KB_DRAFT, notes={'0': "8 deletes didn't bring Home's bar back"}, simCount={DEL: 8})
serr('sim: a hung keyboard read after tapping the draft is AX_TIMEOUT, not LANDMARK', 'AX_TIMEOUT', [L],
     tape=[pt(220, 895, DRAFT), pt(221, 856, {}, n=1), HANG('--point 221,856')], simCount={DEL: 0})
sfail('sim: the keyboard still up after the draft\'s deletes is BLUR', 'BLUR', [L],
      tape=[pt(220, 895, DRAFT, n=4), pt(221, 856, {}, n=1)], simCount={DEL: 8})
sfail('sim: a button holding text on the bar\'s row is never taken for a draft', 'LANDMARK', [L],
      tape=[pt(220, 895, el('AXButton', '', 'wkbpxa', 25, 884, 346, 22)), pt(221, 856, {})], simCount={DEL: 0}, simExcludes=['tap -x 198 -y 895'])
sfail('sim: text on the bar\'s row not under the probe is never taken for a draft', 'LANDMARK', [L],
      tape=[pt(220, 895, el('AXStaticText', '', 'wkbpxa', 25, 884, 60, 22)), pt(221, 856, {})], simCount={DEL: 0}, simExcludes=['tap -x 55 -y 895'])
sfail('sim: a blur that finds no Done while the keyboard stays up is BLUR, not a pass', 'BLUR', [L],
      tape=[pt(220, 895, DRAFT, n=4), pt(221, 856, {}, n=1), {'m': '--point 395,', 'out': {}}], simCount={DEL: 8})
sfail('sim: a labelled element at the bar\'s spot is never taken for a draft', 'LANDMARK', [L],
      tape=[pt(220, 895, el('AXButton', 'Undo', 'wkbpxa', 180, 880, 80, 30)), pt(221, 856, {})], simCount={DEL: 0}, simExcludes=['tap -x 220 -y 895'])
sfail('sim: unlabelled text off the bar\'s row is never taken for a draft', 'LANDMARK', [L],
      tape=[pt(220, 895, el('AXStaticText', '', 'wkbpxa', 20, 600, 400, 300)), pt(221, 856, {})], simCount={DEL: 0}, simExcludes=['tap -x 220 -y 750'])
sfail('sim: no keyboard after tapping the draft deletes nothing and stays LANDMARK', 'LANDMARK', [L],
      tape=[pt(220, 895, DRAFT), pt(221, 856, {})], simCount={DEL: 0}, notes={'0': 'tapping it brought no keyboard, so nothing was deleted'})

# --- the clip job (jobs/clip.sh): the Mac's clipboard image for the container's Ctrl+V ---
clipbase = {'v': 1, 'id': '20261113T231500Z-clip-ab12', 'job': 'clip', 'submittedAt': 'now', 'expiresInMin': 1, 'params': {}}
JXA = '-l JavaScript - '
BANNER = 'display notification'
def RD(rc, **meta): return {'m': JXA, 'rc': rc, 'out': {'cc': 41, 'front': 'com.googlecode.iterm2', **meta}}
def cc_(name, **k):
    if k.get('expect', {}).get('status') == 'served': k.setdefault('ts', None)  # validateJob passes it too
    c(name, kind='clip', **k)
def crej(name, reason, ts=True, **k):
    if ts: k['ts'] = reason
    cc_(name, expect={'status': 'rejected', 'reason': reason}, simExcludes=['osascript'], **k)
CLIP_SHA = '3064001f9933ee70c48b14f22ec2c487a2c1e205167f7eeed4e9fe1e088a458e'  # the stub's PNG
SERVED = {'status': 'served', 'reason': None, 'job': 'clip'}
# No banner per serve: the maintainer's choice, 2026-11-13 (CLIP_BANNER=0); the Mac log line is the record.
cc_('clip: a PNG on the clipboard with iTerm in front is served and logged, with no banner', tape=[RD(0, source='png', bytes=21)],
    expect={**SERVED, 'clip': {'bytes': 21, 'sha256': CLIP_SHA, 'changeCount': 41, 'source': 'png', 'frontmost': 'com.googlecode.iterm2'}},
    files=['clip.png'], simIncludes=['osascript ' + JXA], simExcludes=[BANNER], clipState={'cc': 41, 'n': 1, 'serves': 1})
cc_('clip: a TIFF-only clipboard is served as PNG', tape=[RD(0, source='tiff', bytes=21)],
    expect={**SERVED, 'clip': {'bytes': 21, 'sha256': CLIP_SHA, 'changeCount': 41, 'source': 'tiff', 'frontmost': 'com.googlecode.iterm2'}},
    files=['clip.png'], clipState={'cc': 41, 'n': 1, 'serves': 1})
cc_('clip: a third serve of one copy is fine and counts on', setup='clip-state=' + json.dumps({'ago': [5, 4], 'cc': 41, 'n': 2}),
    tape=[RD(0, source='png', bytes=21)], expect=SERVED, files=['clip.png'], clipState={'cc': 41, 'n': 3, 'serves': 3})
cc_('clip: a new copy restarts the per-copy count', setup='clip-state=' + json.dumps({'ago': [5, 4, 3], 'cc': 40, 'n': 3}),
    tape=[RD(0, source='png', bytes=21)], expect=SERVED, clipState={'cc': 41, 'n': 1, 'serves': 4})
cc_('clip: serves older than a minute fall out of the rate window', setup='clip-state=' + json.dumps({'ago': [90, 80, 70, 65, 61, 61], 'cc': 40, 'n': 3}),
    tape=[RD(0, source='png', bytes=21)], expect=SERVED, clipState={'cc': 41, 'n': 1, 'serves': 1})
cc_('clip: a copy served 3 times is REPEAT, read nothing', setup='clip-state=' + json.dumps({'ago': [5, 4, 3], 'cc': 41, 'n': 3}),
    tape=[RD(7)], expect={'status': 'rejected', 'reason': 'REPEAT'}, simIncludes=['osascript ' + JXA],
    simExcludes=[BANNER], clipState={'cc': 41, 'n': 3, 'serves': 3})
cc_('clip: the read is told which copy is spent', setup='clip-state=' + json.dumps({'ago': [5, 4, 3], 'cc': 41, 'n': 3}),
    tape=[RD(7)], expect={'status': 'rejected', 'reason': 'REPEAT'}, simIncludes=['com.googlecode.iterm2 com.apple.Terminal 41'])
cc_('clip: a fresh state tells the read nothing is spent', tape=[RD(0, source='png', bytes=21)], expect=SERVED,
    simIncludes=['16777216 com.googlecode.iterm2 com.apple.Terminal -1'])
crej('clip: a 7th serve inside a minute is RATE_LIMITED before any read', 'RATE_LIMITED', ts=False,
     setup='clip-state=' + json.dumps({'ago': [50, 40, 30, 20, 10, 1], 'cc': 40, 'n': 1}), clipState={'cc': 40, 'n': 1, 'serves': 6})
cc_('clip: no image on the clipboard is NO_IMAGE', tape=[RD(3)], expect={'status': 'rejected', 'reason': 'NO_IMAGE'}, simExcludes=[BANNER])
cc_('clip: another app in front is NOT_FRONTMOST, naming it', tape=[RD(6, front='com.apple.Safari')],
    expect={'status': 'rejected', 'reason': 'NOT_FRONTMOST', 'frontmost': 'com.apple.Safari'}, simExcludes=[BANNER])
cc_('clip: a frontmost id that is not a bundle id is never echoed', tape=[RD(6, front='x"; rm -f y')],
    expect={'status': 'rejected', 'reason': 'NOT_FRONTMOST', 'frontmost': ''})
cc_('clip: an image the pasteboard will not hand over is PASTEBOARD_DENIED', tape=[RD(4, source='png')], expect={'status': 'error', 'reason': 'PASTEBOARD_DENIED'})
cc_('clip: over the cap per the read is TOO_LARGE', tape=[RD(5, source='png', bytes=20000000)], expect={'status': 'rejected', 'reason': 'TOO_LARGE'}, simExcludes=[BANNER])
cc_('clip: a written file over the cap is TOO_LARGE, not served', tape=[RD(0, source='png', bytes=21, write='big')], expect={'status': 'rejected', 'reason': 'TOO_LARGE'},
    simExcludes=[BANNER])
cc_('clip: a written file without PNG magic is CLIP_FAILED', tape=[RD(0, source='png', bytes=14, write='gif')], expect={'status': 'error', 'reason': 'CLIP_FAILED'}, simExcludes=[BANNER])
cc_('clip: a report without a changeCount is CLIP_FAILED', tape=[{'m': JXA, 'rc': 0, 'out': {'source': 'png', 'bytes': 21}}], expect={'status': 'error', 'reason': 'CLIP_FAILED'})
cc_('clip: a read that fails otherwise is CLIP_FAILED', tape=[RD(8)], expect={'status': 'error', 'reason': 'CLIP_FAILED'})
cc_('clip: a 2-minute life is the longest taken', patch={'expiresInMin': 2}, tape=[RD(0, source='png', bytes=21)], expect=SERVED)
cc_('clip: an image copied with plain or rich text is MIXED_TEXT, naming the types', tape=[RD(9, types=['public.png', 'public.utf8-plain-text', 'bad type!'])],
    expect={'status': 'rejected', 'reason': 'MIXED_TEXT', 'types': ['public.png', 'public.utf8-plain-text']}, simExcludes=[BANNER])
cc_('clip: junk in the private state counts as nothing, never jamming a cap', setup='clip-state=' + json.dumps({'ago': [], 'cc': 41, 'n': 3}) + '|junk',
    tape=[RD(0, source='png', bytes=21)], expect=SERVED, simIncludes=['com.googlecode.iterm2 com.apple.Terminal -1'], clipState={'cc': 41, 'n': 1, 'serves': 1})
cc_('clip: serve times in the future (a clock jump) are dropped', setup='clip-state=' + json.dumps({'ago': [-500, -400, -300, -200, -100, -50], 'cc': 40, 'n': 1}),
    tape=[RD(0, source='png', bytes=21)], expect=SERVED, clipState={'cc': 41, 'n': 1, 'serves': 1})
crej('clip: any param is BAD_PARAM', 'BAD_PARAM', patch={'params': {'path': '/etc/passwd'}})
crej('clip: a life over 2 min is BAD_PARAM', 'BAD_PARAM', patch={'expiresInMin': 5})
crej('clip: params that are not an object are BAD_PARAM', 'BAD_PARAM', patch={'params': ['x']})
c('clip: an expired paste is EXPIRED, read nothing', kind='clip', patch={'submittedAt': 'now'}, submittedAgoMin=2, ts='EXPIRED',
  expect={'status': 'expired', 'reason': 'EXPIRED'}, simExcludes=['osascript'])


# --- lanes (runner.sh LANE): the slow lane takes only SLOW_JOBS (sim), the fast lane everything else ---
# `lane` is the runner's third argument; no lane = both locks, as every case above. `locks` = the lock dirs left after.
SIMLEFT = dict(noResult=True, inboxLeft=1, simExcludes=NOSIM)
sc('lanes: the fast lane leaves a sim job in the inbox', lane='fast', **SIMLEFT)
cc_('lanes: the slow lane leaves a clip job in the inbox', lane='slow', noResult=True, inboxLeft=1, simExcludes=['osascript'])
c('lanes: the slow lane leaves an open-pr job in the inbox', lane='slow', noResult=True, inboxLeft=1, calls=[])
c('lanes: the slow lane leaves a bad file name for the fast lane', lane='slow', file='notes.txt', noResult=True, inboxLeft=1, calls=[])
c('lanes: the slow lane leaves a dotfile for the fast lane', lane='slow', file='.DS_Store', noResult=True, inboxLeft=1, calls=[])
c('lanes: the slow lane leaves a FIFO unread', lane='slow', setup='fifo', noResult=True, inboxLeft=1, calls=[])
c('lanes: the slow lane leaves non-JSON', lane='slow', raw='{not json', noResult=True, inboxLeft=1, calls=[])
c('lanes: the slow lane leaves an oversized file unopened (the fast lane refuses it)', lane='slow', setup='oversize', noResult=True, inboxLeft=1, calls=[])
c('lanes: the slow lane leaves an unknown job', lane='slow', patch={'job': 'merge-pr'}, noResult=True, inboxLeft=1, calls=[])
c('lanes: the slow lane leaves an expired clip', kind='clip', lane='slow', submittedAgoMin=2, noResult=True, inboxLeft=1, simExcludes=['osascript'])
c('lanes: the fast lane parks a bad file name (junk never waits behind a sim)', lane='fast', file='notes.txt', noResult=True, calls=[])
c('lanes: the fast lane answers an unknown job', lane='fast', patch={'job': 'merge-pr'}, expect={'status': 'rejected', 'reason': 'UNKNOWN_JOB'}, calls=[])
c('lanes: the fast lane answers non-JSON', lane='fast', raw='{not json', expect={'status': 'rejected', 'reason': 'BAD_JSON'}, calls=[])
c('lanes: the fast lane answers a FIFO without reading it', lane='fast', setup='fifo', expect={'status': 'rejected', 'reason': 'BAD_FILE'}, calls=[])
cc_('lanes: a clip is served while the slow lock is held', lane='fast', setup='lock', tape=[RD(0, source='png', bytes=21)], expect=SERVED, locks=['lock'])
c('lanes: an open-pr opens while the slow lock is held', lane='fast', setup='lock', expect={'status': 'opened'}, calls=ALL, locks=['lock'])
sc('lanes: a held slow lock leaves the next sim queued', lane='slow', setup='lock', locks=['lock'], **SIMLEFT)
spass('lanes: the slow lane takes a stale slow lock', lane='slow', setup='stale-lock', locks=[])
spass('lanes: the slow lane ignores a held fast lock', lane='slow', setup='lock-fast', locks=['lock-fast'])
c('lanes: the fast lane takes a stale fast lock', lane='fast', setup='stale-lock-fast', expect={'status': 'opened'}, calls=ALL, locks=[])
c('lanes: a held fast lock leaves the job queued', lane='fast', setup='lock-fast', noResult=True, inboxLeft=1, calls=[], locks=['lock-fast'])
c('lanes: a held fast lock stops a both-lanes drain too', setup='lock-fast', noResult=True, inboxLeft=1, calls=[], locks=['lock-fast'])
c('lanes: a 6-minute-old fast lock is stale (5-minute rule)', lane='fast', setup='aged-lock-fast', expect={'status': 'opened'}, calls=ALL, locks=[])
sc('lanes: a 6-minute-old slow lock is not (15-minute rule: a sim touches it per op)', lane='slow', setup='aged-lock', locks=['lock'], **SIMLEFT)
sc('lanes: a sim not named …Z-ios-… is refused, never run in the fast lane', lane='fast', patch={'id': '20261104T190000Z-launch-ab12'},
   expect={'status': 'rejected', 'reason': 'BAD_FILE'}, simExcludes=NOSIM)
cc_('lanes: a clip named …Z-ios-… is refused, never run in the slow lane', lane='slow', patch={'id': '20261113T231500Z-ios-clip-ab12'},
    expect={'status': 'rejected', 'reason': 'BAD_FILE'}, simExcludes=['osascript'])
c('lanes: an open-pr for a branch named ios-… runs in the slow lane', lane='slow', patch={'id': '20261101T204512Z-ios-probe-check-3kx9'},
  expect={'status': 'opened'}, calls=ALL)
cc_('lanes: at most 5 per drain, counting only the lane\'s own (6 clips + 2 sims → 5 answered, 3 left)', lane='fast', setup='mixed',
    tape=[RD(0, source='png', bytes=21)], inboxLeft=3, simExcludes=NOSIM)

# ================================================================================================= edit-pr job ===
# The default edit API: one open PR from this repo's branch, by the owner, onto main, at the job's sha; the PATCH
# answers with the stored body. Cases override routes as for open-pr.
import hashlib
ebody = 'Updated after the round-2 fixes. BODYMARK\n\nStill fine: `@types/node`.\n'
ebase = {'v': 1, 'id': '20261114T010000Z-edit-mac-mailroom-3kx9', 'job': 'edit-pr', 'submittedAt': 'now', 'expiresInMin': 20,
         'params': {'branch': 'mac-mailroom', 'sha': A, 'title': 'Mac mailroom edits PRs as the user', 'body': ebody, 'bodySha256': 'auto'}}
PATCHK = f'PATCH {R}/pulls/90'
EPR = {**PR, 'base': {'ref': 'main'}, 'head': {'sha': A, 'repo': {'full_name': 'radatta/aperture'}}}
EAPI = {LIST: {'status': 200, 'body': [EPR]}, PATCHK: {'status': 200, 'body': {**EPR, 'body': ebody}}}
EALL = ['GET /user', REF, LIST, MD, PATCHK]
ESHA = hashlib.sha256(ebody.encode()).hexdigest()
EDITED = {'status': 'edited', 'reason': None, 'pr': PRR, 'bodySha256': ESHA}
def ec(name, api=None, **k): c(name, kind='edit-pr', api={**EAPI, **(api or {})}, **k)
def erej(name, reason, ts=True, **k):
    if ts:
        k['ts'] = reason
    ec(name, expect={'status': 'rejected', 'reason': reason}, calls=[], **k)

ec('edit-pr: replaces the title and body of the one open PR, nothing else', ts=None, expect=EDITED, calls=EALL,
   patchBody={'title': ebase['params']['title'], 'body': ebody},
   md={'text': ebase['params']['title'] + '\n\n' + ebody, 'mode': 'gfm', 'context': 'radatta/aperture'})
ec('edit-pr: no title sends the body alone and renders it alone', ts=None, unset=[['params', 'title']], expect=EDITED, calls=EALL,
   patchBody={'body': ebody}, md={'text': ebody, 'mode': 'gfm', 'context': 'radatta/aperture'})
ec('edit-pr: no open PR is NO_PR, no write', api={LIST: {'status': 200, 'body': []}}, expect={'status': 'rejected', 'reason': 'NO_PR'}, calls=EALL[:3])
ec('edit-pr: two open PRs is MANY_PRS, no write', api={LIST: {'status': 200, 'body': [EPR, {**EPR, 'number': 91}]}},
   expect={'status': 'rejected', 'reason': 'MANY_PRS'}, calls=EALL[:3])
ec('edit-pr: a PR by another author is WRONG_AUTHOR, no write', api={LIST: {'status': 200, 'body': [{**EPR, 'user': {'login': 'someone-else'}}]}},
   expect={'status': 'error', 'reason': 'WRONG_AUTHOR'}, calls=EALL[:3])
ec('edit-pr: a PR onto another base is WRONG_BASE, no write', api={LIST: {'status': 200, 'body': [{**EPR, 'base': {'ref': 'dev'}}]}},
   expect={'status': 'rejected', 'reason': 'WRONG_BASE'}, calls=EALL[:3])
ec('edit-pr: a PR whose head moved is HEAD_MISMATCH, no write', api={LIST: {'status': 200, 'body': [{**EPR, 'head': {**EPR['head'], 'sha': 'b' * 40}}]}},
   expect={'status': 'rejected', 'reason': 'HEAD_MISMATCH'}, calls=EALL[:3])
ec('edit-pr: a PR from another repo is HEAD_MISMATCH, no write', api={LIST: {'status': 200, 'body': [{**EPR, 'head': {'sha': A, 'repo': {'full_name': 'evil/aperture'}}}]}},
   expect={'status': 'rejected', 'reason': 'HEAD_MISMATCH'}, calls=EALL[:3])
ec('edit-pr: a branch pushed past the job is HEAD_MISMATCH before the PR lookup', api={REF: {'status': 200, 'body': {'object': {'sha': 'b' * 40}}}},
   expect={'status': 'rejected', 'reason': 'HEAD_MISMATCH'}, calls=EALL[:2])
ec('edit-pr: a PR list that is not a list is API_FAILED', api={LIST: {'status': 200, 'body': {'message': 'odd'}}}, expect={'status': 'error', 'reason': 'API_FAILED'}, calls=EALL[:3])
ec('edit-pr: a mention in the rendered text is MENTION, no write', api={MD: {'status': 200, 'body': MENTION_HTML}}, expect={'status': 'rejected', 'reason': 'MENTION'}, calls=EALL[:4])
ec('edit-pr: a refused PATCH is API_FAILED', api={PATCHK: {'status': 422, 'body': {'message': 'Validation Failed'}}}, expect={'status': 'error', 'reason': 'API_FAILED'}, calls=EALL)
ec('edit-pr: a PATCH answering for another PR is API_FAILED', api={PATCHK: {'status': 200, 'body': {**EPR, 'number': 91, 'html_url': 'https://github.com/radatta/aperture/pull/91'}}},
   expect={'status': 'error', 'reason': 'API_FAILED'}, calls=EALL)
ec('edit-pr: the result hashes the body GitHub stored, not the one sent', api={PATCHK: {'status': 200, 'body': {**EPR, 'body': 'other'}}},
   expect={**EDITED, 'bodySha256': hashlib.sha256(b'other').hexdigest()}, calls=EALL)
ec('edit-pr: no Keychain token is TOKEN_MISSING, no call', noToken=True, expect={'status': 'error', 'reason': 'TOKEN_MISSING'}, calls=[])
erej('edit-pr: a title without a body is BAD_PARAM', 'BAD_PARAM', unset=[['params', 'body']])
erej('edit-pr: an extra param (state) is BAD_PARAM', 'BAD_PARAM', patch={'params': {'state': 'closed'}})
erej('edit-pr: a PR number from the container is BAD_PARAM', 'BAD_PARAM', patch={'params': {'number': 90}})
erej('edit-pr: a title with a double quote is BAD_PARAM', 'BAD_PARAM', patch=T('Fix "quoted" thing'))
erej('edit-pr: branch main is BAD_PARAM', 'BAD_PARAM', patch={'params': {'branch': 'main'}})
erej('edit-pr: a wrong bodySha256 is BAD_PARAM', 'BAD_PARAM', ts=False, patch={'params': {'bodySha256': '0' * 64}})
erej('edit-pr: a mention in the body is MENTION before any call', 'MENTION', patch=B('thanks @octocat'))
erej('edit-pr: a hash ref in the body is HASH_REF', 'HASH_REF', patch=B('fixes #12'))
erej('edit-pr: a cross-repo link in the title is XREF', 'XREF', patch=T('See https://github.com/cli/cli/issues/1'))
ec('lanes: an edit-pr edits while the slow lock is held', lane='fast', setup='lock', expect=EDITED, calls=EALL, locks=['lock'])

# ================================================================================================ fixtures job ===
# The default API: a diff of one runner file, and a tarball (the tar stub unpacks the case's fxScript as the archive's
# run-fixtures.sh); sandbox-exec is a stub that records its profile and runs the rest.
fxbase = {'v': 1, 'id': '20261114T020000Z-fx-aaaaaaaaaaaa-3kx9', 'job': 'fixtures', 'submittedAt': 'now', 'expiresInMin': 20, 'params': {'sha': A}}
CMP = f'GET {R}/compare/main...{A}'
TGZ = f'GET {R}/tarball/{A}'
FXAPI = {CMP: {'status': 200, 'body': {'files': [{'filename': 'tools/mailroom/runner.sh'}]}}, TGZ: {'status': 200, 'body': 'TARBALL'}}
FXALL = ['GET /user', CMP, TGZ]
def suite(*lines, rc=0): return '#!/bin/bash\n' + ''.join(f'echo {json.dumps(l, ensure_ascii=False)}\n' for l in lines) + f'exit {rc}\n'
OK2 = suite('ok - a', 'ok - b', '# 2 passed, 0 failed, of 2 cases')
PROFILE = ['(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)',
           '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/System/Volumes/Data/Users"))',
           '(deny appleevent-send)', '(deny job-creation)', '(deny signal)', '(allow signal (target same-sandbox))']  # each line present; the whole profile, in order: runner-fixtures.test.ts
NOFX = ['sandbox-exec', 'tar ']
def fc(name, api=None, **k): c(name, kind='fixtures', api={**FXAPI, **(api or {})}, **k)
FXPASS = {'status': 'pass', 'reason': None, 'job': 'fixtures', 'fixtures': {'passed': 2, 'failed': 0, 'cases': 2, 'failing': []}}

fc('fixtures: a passing suite runs sandboxed, unpacked sandboxed, in a clean environment', ts=None, fxScript=OK2, expect=FXPASS, calls=FXALL,
   # in order: the unpack's sandbox-exec line, tar itself, then the suite's sandbox-exec line (only sandbox-exec says env -i)
   simIncludes=['sandbox-exec -f', 'tar -xzf', '/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME='],
   sbIncludes=PROFILE, logIncludes=['# 2 passed, 0 failed, of 2 cases'])
fc("fixtures: the suite sees no variable of the runner's (no token, no fixture env)", fxScript='#!/bin/bash\nenv\necho "ok - x"\necho "# 1 passed, 0 failed, of 1 cases"\n',
   expect={'status': 'pass', 'fixtures': {'passed': 1, 'failed': 0, 'cases': 1, 'failing': []}}, calls=FXALL,
   logIncludes=['PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL=C'], logExcludes=['MAILROOM_FIXTURE_', 'BASH_FUNC_', 'HJ=', 'STATE=', 'MR_'])
fc('fixtures: a failing case is fail FIXTURES_FAILED, named', fxScript=suite('ok - a', 'not ok - lanes: a clip: wrote 0 results', '# 1 passed, 1 failed, of 2 cases', rc=1),
   expect={'status': 'fail', 'reason': 'FIXTURES_FAILED', 'fixtures': {'passed': 1, 'failed': 1, 'cases': 2, 'failing': ['lanes: a clip: wrote 0 results'], 'exit': 1}}, calls=FXALL)
fc('fixtures: a shortfall (a shard lost) fails even on exit 0', fxScript=suite('ok - a', '# 1 passed, 0 failed, of 2 cases'),
   expect={'status': 'fail', 'reason': 'FIXTURES_FAILED', 'fixtures': {'passed': 1, 'failed': 0, 'cases': 2, 'failing': [], 'exit': 0}}, calls=FXALL)
fc('fixtures: no summary line fails', fxScript=suite('ok - a'),
   expect={'status': 'fail', 'reason': 'FIXTURES_FAILED', 'fixtures': {'passed': None, 'failed': None, 'cases': None, 'failing': [], 'exit': 0}}, calls=FXALL)
fc('fixtures: at most 20 failing names, odd characters replaced', fxScript=suite(*[f'not ok - c{i} \u00e9: x' for i in range(25)], '# 0 passed, 25 failed, of 25 cases', rc=1),
   expect={'status': 'fail', 'fixtures': {'passed': 0, 'failed': 25, 'cases': 25, 'failing': [f'c{i} ?: x' for i in range(20)], 'exit': 1}}, calls=FXALL)
fc('fixtures: a diff touching install.sh is TOUCHES_INSTALL, nothing fetched or run', api={CMP: {'status': 200, 'body': {'files': [{'filename': 'tools/mailroom/install.sh'}]}}},
   fxScript=OK2, expect={'status': 'rejected', 'reason': 'TOUCHES_INSTALL'}, calls=FXALL[:2], simExcludes=NOFX)
fc('fixtures: a plist template renamed away is TOUCHES_INSTALL', api={CMP: {'status': 200, 'body': {'files': [{'filename': 'x.txt', 'previous_filename': 'tools/mailroom/x.plist.tmpl'}]}}},
   fxScript=OK2, expect={'status': 'rejected', 'reason': 'TOUCHES_INSTALL'}, calls=FXALL[:2], simExcludes=NOFX)
fc('fixtures: 300 files (GitHub cuts the list there) is DIFF_TOO_LARGE', api={CMP: {'status': 200, 'body': {'files': [{'filename': f'f{i}'} for i in range(300)]}}},
   fxScript=OK2, expect={'status': 'rejected', 'reason': 'DIFF_TOO_LARGE'}, calls=FXALL[:2], simExcludes=NOFX)
fc('fixtures: a compare without a file list is API_FAILED', api={CMP: {'status': 200, 'body': {'status': 'identical'}}}, fxScript=OK2,
   expect={'status': 'error', 'reason': 'API_FAILED'}, calls=FXALL[:2], simExcludes=NOFX)
fc('fixtures: an unknown sha is HEAD_MISSING', api={CMP: {'status': 404, 'body': {}}}, fxScript=OK2, expect={'status': 'rejected', 'reason': 'HEAD_MISSING'}, calls=FXALL[:2], simExcludes=NOFX)
fc('fixtures: a tarball refused is TOKEN_FORBIDDEN, nothing run', api={TGZ: {'status': 404, 'body': {}}}, fxScript=OK2, expect={'status': 'error', 'reason': 'TOKEN_FORBIDDEN'}, calls=FXALL, simExcludes=NOFX)
fc('fixtures: an archive without run-fixtures.sh is API_FAILED, nothing run', expect={'status': 'error', 'reason': 'API_FAILED'}, calls=FXALL, simExcludes=['/bin/bash '])
fc('fixtures: a profile this macOS will not compile is SANDBOX_FAILED, nothing unpacked or run', sandboxFails=True, fxScript=OK2,
   expect={'status': 'error', 'reason': 'SANDBOX_FAILED'}, calls=FXALL, simIncludes=['sandbox-exec -f'], simExcludes=['tar ', '/usr/bin/env -i'])
fc('fixtures: no temp dir is API_FAILED, nothing run, the inbox kept', setup='no-tmp', fxScript=OK2, expect={'status': 'error', 'reason': 'API_FAILED'}, calls=FXALL, simExcludes=NOFX)
fc('fixtures: no Keychain token is TOKEN_MISSING, no call', noToken=True, fxScript=OK2, expect={'status': 'error', 'reason': 'TOKEN_MISSING'}, calls=[], simExcludes=NOFX)
fc('fixtures: an extra param is BAD_PARAM', ts='BAD_PARAM', patch={'params': {'branch': 'x'}}, expect={'status': 'rejected', 'reason': 'BAD_PARAM'}, calls=[])
fc('fixtures: a short sha is BAD_PARAM', ts='BAD_PARAM', patch={'params': {'sha': 'abc1234'}}, expect={'status': 'rejected', 'reason': 'BAD_PARAM'}, calls=[])
fc('fixtures: a sha with a trailing newline is BAD_PARAM', ts='BAD_PARAM', patch={'params': {'sha': A + '\n'}}, expect={'status': 'rejected', 'reason': 'BAD_PARAM'}, calls=[])
fc('lanes: the slow lane runs a fixtures job named …Z-fx-…', lane='slow', fxScript=OK2, expect=FXPASS, calls=FXALL)
fc('lanes: the fast lane leaves a fixtures job named …Z-fx-… queued', lane='fast', fxScript=OK2, noResult=True, inboxLeft=1, calls=[], simExcludes=NOFX)
fc('lanes: a fixtures job not named …Z-fx-… is refused, never run in the fast lane', lane='fast', patch={'id': '20261114T020000Z-other-3kx9'}, fxScript=OK2,
   expect={'status': 'rejected', 'reason': 'BAD_FILE'}, calls=[], simExcludes=NOFX)
cc_('lanes: a clip named …Z-fx-… is refused, never run in the slow lane', lane='slow', patch={'id': '20261114T020100Z-fx-clip-ab12'},
    expect={'status': 'rejected', 'reason': 'BAD_FILE'}, simExcludes=['osascript'])

with open(out, 'w') as f:
    f.write(json.dumps({'base': base, 'simBase': simbase, 'clipBase': clipbase, 'editBase': ebase, 'fixturesBase': fxbase}) + '\n')
    f.write(json.dumps({'defaultApi': default, 'defaultTape': deftape}) + '\n')
    for x in C:
        f.write(json.dumps(x, ensure_ascii=True) + '\n')
print(len(C), 'cases')
