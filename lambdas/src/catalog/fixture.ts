// A synthetic stand-in for the pinned dataset (lcCatalog.ts → LC_CATALOG_SOURCE), in its shape: the fake source's
// rows for tests and the local server. Made-up problems, plus two NeetCode slugs so the NeetCode-wins overlay is
// exercised and one public off-list slug the dev check reads on local and dev alike (palindrome-number, with its
// public number and difficulty). Never a real problem list.

const row = (
  id: number,
  slug: string,
  difficulty: 'Easy' | 'Medium' | 'Hard',
  tags: string[],
  over: { paid?: boolean; category?: string; title?: string } = {},
) => ({
  questionId: String(id),
  questionFrontendId: String(id),
  title: over.title ?? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  titleSlug: null,
  difficulty,
  isPaidOnly: over.paid ?? false,
  categoryTitle: over.category ?? 'Algorithms',
  topicTags: tags.map((name) => ({ name })),
  stats: JSON.stringify({ acRate: `${(30 + (id % 50)).toFixed(1)}%` }),
  url: `https://leetcode.com/problems/${slug}/`,
});

export const FIXTURE_SOURCE = [
  row(1, 'two-sum', 'Easy', ['Array', 'Hash Table'], { title: 'Two Sum' }),
  row(242, 'valid-anagram', 'Easy', ['Hash Table', 'String', 'Sorting'], {
    title: 'Valid Anagram',
  }),
  row(9, 'palindrome-number', 'Easy', ['Math'], { title: 'Palindrome Number' }),
  row(9001, 'synthetic-window-sum', 'Medium', ['Array', 'Sliding Window']),
  row(9002, 'synthetic-heap-merge', 'Hard', ['Heap (Priority Queue)', 'Linked List']),
  row(9003, 'synthetic-grid-paths', 'Medium', ['Array', 'Dynamic Programming', 'Matrix']),
  row(9004, 'synthetic-tree-depth', 'Easy', ['Tree', 'Depth-First Search', 'Binary Tree']),
  row(9005, 'synthetic-locked-graph', 'Medium', ['Graph', 'Breadth-First Search'], { paid: true }),
  row(9006, 'synthetic-interval-join', 'Medium', ['Array', 'Sorting']),
  row(9007, 'synthetic-bits-count', 'Easy', ['Bit Manipulation']),
  row(9008, 'synthetic-greedy-jumps', 'Medium', ['Array', 'Greedy']),
  row(9009, 'synthetic-trie-words', 'Hard', ['String', 'Trie']),
  row(9010, 'synthetic-orders-report', 'Easy', ['Database'], { category: 'Database' }),
  row(9011, 'synthetic-stack-parse', 'Medium', ['String', 'Stack']),
  row(9012, 'synthetic-plain-design', 'Medium', ['Design']),
];
// A classification for the fixture (parseClasses' format), as a test or the dev check uploads.
export const FIXTURE_CLASSES = [
  '# synthetic classes',
  '9001\tsliding-window\t9008\t9002',
  '9002\theap\t-\t-',
  '9003\tdp-2d\t-\t-',
  '9006\tintervals\t9008\t-',
  '9008\tgreedy\t9001\t9003',
].join('\n');
