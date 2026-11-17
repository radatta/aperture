import { describe, expect, it } from 'vitest';
import { commentBlocks, isTraceBlock, traceCommentIn } from './traceComment';

// Synthetic fixtures only: made-up inputs on a made-up function.
const PY_DOCSTRING = `class Solution:
    def pairSum(self, vals: List[int], goal: int) -> List[int]:
        """
        vals = [4, 1, 6], goal = 7
        i=0: 4, need 3, seen {} -> add 4
        i=1: 1, need 6, seen {4:0} -> add 1
        i=2: 6, need 1, seen {4:0, 1:1} -> found [1, 2]
        """
        seen = {}
`;

describe('traceCommentIn', () => {
  it('reads a Python docstring that walks an input', () => expect(traceCommentIn(PY_DOCSTRING)).toBe(true));

  it("reads a ''' docstring", () =>
    expect(traceCommentIn(PY_DOCSTRING.replaceAll('"""', "'''"))).toBe(true));

  it('reads a /* */ block with leading stars', () => {
    const code = `/*
 * input: grid = [[1,0],[0,1]]
 * (0,0) -> visit, count = 1
 * (1,1) -> visit, count = 2
 */
int countIslands(vector<vector<int>>& grid) {`;
    expect(traceCommentIn(code)).toBe(true);
  });

  it('reads a run of # lines', () => {
    const code = `# s = "abca"
# l=0 r=0 window {a} best = 1
# l=0 r=2 window {a,b,c} best = 3
def longest(s):`;
    expect(traceCommentIn(code)).toBe(true);
  });

  it('reads a run of // lines', () => {
    const code = `// example: nums = [3, 5]
// step 1: lo=0 hi=1 mid=0
// step 2: lo=1 hi=1 -> 5
function f(nums) {}`;
    expect(traceCommentIn(code)).toBe(true);
  });

  it('ignores LeetCode starter docstrings', () => {
    const code = `# Definition for singly-linked list.
# class ListNode:
#     def __init__(self, val=0, next=None):
#         self.val = val
#         self.next = next
class Solution:
    def reverse(self, head):
        """
        :type head: ListNode
        :rtype: ListNode
        """`;
    expect(traceCommentIn(code)).toBe(false);
  });

  it('needs at least two step lines besides the input', () => {
    const code = `"""
vals = [4, 1]
i=0 -> 4
"""`;
    expect(traceCommentIn(code)).toBe(false);
  });

  it('needs an input line', () => {
    const code = `"""
then 1 -> 2
then 2 -> 3
then 3 -> 4
"""`;
    expect(traceCommentIn(code)).toBe(false);
  });

  it('ignores a two-line # run', () => {
    const code = `# vals = [4, 1]
# i=0 -> 4, i=1 -> 1
x = 1`;
    expect(traceCommentIn(code)).toBe(false);
  });

  it('ignores prose comments', () => {
    const code = `"""
Use a hash map to remember what we've seen.
Then look up the complement for each value.
Return the pair of indexes.
"""`;
    expect(traceCommentIn(code)).toBe(false);
  });

  it('skips a block still being typed (no closing delimiter)', () => {
    const code = `"""
vals = [4, 1, 6]
i=0: 4 -> add
i=1: 1 -> add`;
    expect(traceCommentIn(code)).toBe(false);
  });

  it('ignores one-line docstrings and plain code', () => {
    expect(traceCommentIn(`"""vals = [1] -> 1: 2"""\nx = 1\ny = 2\nz = 3`)).toBe(false);
    expect(traceCommentIn('')).toBe(false);
  });

  it('a trace in a later block still counts', () => {
    const code = `"""
Hash map approach.
"""
${PY_DOCSTRING}`;
    expect(traceCommentIn(code)).toBe(true);
  });
});

describe('commentBlocks', () => {
  it('splits # runs at a code line', () => {
    const blocks = commentBlocks('# a\n# b\n# c\nx = 1\n# d\n# e\n# f');
    expect(blocks).toEqual([[' a', ' b', ' c'], [' d', ' e', ' f']]);
  });

  it('isTraceBlock counts steps apart from the input line', () =>
    expect(isTraceBlock(['n = 3', 'n=3 -> 2', 'n=2 -> 1'])).toBe(true));
});
