// LeetCode's traffic, hand-written from the shapes in extension/README.md → Wire contract (2026-11-08 captures) —
// synthetic values only (slug two-sum, code print("x"), username "user"); no captured text.
export const SLUG = 'two-sum';
export const QID = '1';
export const CODE = 'class Solution:\n    def twoSum(self, nums, target):\n        print("x")\n';
const gql = (operationName: string, variables: object) =>
  JSON.stringify({ operationName, variables, query: `query ${operationName} { x }` });

export const T = {
  updateSyncedCode: {
    url: 'https://leetcode.com/graphql/',
    reqText: gql('updateSyncedCode', { code: CODE, lang: 11, questionId: 1 }),
    resText: JSON.stringify({ data: { updateSyncedCode: { ok: true } } }),
  },
  syncedCode: {
    url: 'https://leetcode.com/graphql/',
    reqText: gql('syncedCode', { lang: 11, questionId: 1 }),
    resText: JSON.stringify({ data: { syncedCode: { timestamp: 1, code: CODE } } }),
  },
  questionDetail: {
    url: 'https://leetcode.com/graphql/',
    reqText: gql('questionDetail', { titleSlug: SLUG }),
    resText: JSON.stringify({
      data: {
        languageList: [{ id: 11, name: 'python3' }],
        question: {
          title: 'Two Sum',
          titleSlug: SLUG,
          questionId: QID,
          questionFrontendId: '1',
          difficulty: 'Easy',
          topicTags: [
            { name: 'Array', slug: 'array' },
            { name: 'Hash Table', slug: 'hash-table' },
          ],
          companyTagStatsV2: '{"threeMonths":[{"name":"Acme","timesEncountered":3}]}',
        },
      },
    }),
  },
  nextQuestionDetail: {
    url: 'https://leetcode.com/graphql/',
    reqText: gql('questionDetail', { titleSlug: 'add-two-numbers' }),
    resText: JSON.stringify({
      data: {
        question: { title: 'Add Two Numbers', titleSlug: 'add-two-numbers', questionId: '2' },
      },
    }),
  },
  submissionDetails: {
    url: 'https://leetcode.com/graphql/',
    reqText: gql('submissionDetails', { submissionId: '900001' }),
    resText: JSON.stringify({
      data: {
        submissionDetails: {
          code: CODE,
          statusCode: 10,
          runtime: 3,
          user: { username: 'user' },
          question: { titleSlug: SLUG, questionId: QID },
        },
      },
    }),
  },
  updateNote: {
    url: 'https://leetcode.com/graphql/',
    reqText: gql('updateNote', { titleSlug: SLUG, content: 'use a map' }),
    resText: JSON.stringify({ data: { updateNote: { ok: true, error: null } } }),
  },
  replay: {
    url: 'https://leetcode.com/graphql/',
    reqText: gql('PracticeReplayUploadEvents', {
      questionSlug: SLUG,
      clientSessionId: 'practice-0000',
      events: JSON.stringify([
        { questionId: QID, type: 0, lang: 'python3', ts: 1 },
        { questionId: QID, type: 7, ts: 2, data: { range: [1, 1, 1, 1], text: 'x' } },
      ]),
      activeSessionId: 1,
    }),
    resText: JSON.stringify({ data: { createPracticeReplayEvents: { ok: true } } }),
  },
  unrelated: {
    url: 'https://leetcode.com/graphql/',
    reqText: gql('globalData', {}),
    resText: JSON.stringify({ data: { userStatus: { username: 'user' } } }),
  },
  submit: {
    url: `https://leetcode.com/problems/${SLUG}/submit/`,
    reqText: JSON.stringify({
      lang: 'python3',
      question_id: QID,
      typed_code: CODE,
      solve_session_id: 'ss-1',
      solve_elapsed_ms: 1000,
    }),
    resText: JSON.stringify({ submission_id: 900001 }),
  },
  submitPending: {
    url: 'https://leetcode.com/submissions/detail/900001/v2/check/',
    reqText: null,
    resText: JSON.stringify({ state: 'STARTED' }),
  },
  submitCheck: {
    url: 'https://leetcode.com/submissions/detail/900001/v2/check/',
    reqText: null,
    resText: JSON.stringify({
      state: 'SUCCESS',
      status_code: 11,
      status_msg: 'Wrong Answer',
      total_correct: 40,
      total_testcases: 63,
      last_testcase: '[3,2,4]\n6',
      expected_output: '[1,2]',
      code_output: '[0,0]',
      submission_id: '900001',
    }),
  },
  run: {
    url: `https://leetcode.com/problems/${SLUG}/interpret_solution/`,
    reqText: JSON.stringify({
      lang: 'python3',
      question_id: QID,
      typed_code: CODE,
      data_input: '[2,7]\n9',
    }),
    resText: JSON.stringify({ interpret_id: 'runcode_1_2_x', test_case: '[2,7]\n9' }),
  },
  runCheck: {
    url: 'https://leetcode.com/submissions/detail/runcode_1_2_x/check/',
    reqText: null,
    resText: JSON.stringify({
      state: 'SUCCESS',
      status_code: 10,
      status_msg: 'Accepted',
      total_correct: 3,
      total_testcases: 3,
      code_answer: ['[0,1]'],
    }),
  },
} as const;

// The QD_TIMER_STATE shape from the 2026-11-08 page dump (values synthetic).
export const TIMER_PAUSED = JSON.stringify({
  mode: 'reverse',
  startTimestamp: null,
  pauseMs: 2453619,
  endMs: 3600000,
  lastUsedEndMs: 3600000,
  status: 'pause',
  isUserPaused: true,
  alertMinute: 5,
});
