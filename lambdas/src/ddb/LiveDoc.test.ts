import { beforeEach, describe, expect, it, vi } from 'vitest';

// LiveDoc.add's UpdateItem, against a stubbed SDK: the one write that isn't a whole-item put (the live-pull
// count). The rest of LiveDoc stays a thin wrapper proven on dev; this expression is easy to get subtly wrong.
const update = vi.fn();
const sdk = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  query: vi.fn(),
  delete: vi.fn(),
  batchWrite: vi.fn(),
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocument: { from: () => ({ update, ...sdk }) },
}));
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
  ConditionalCheckFailedException: class extends Error {},
}));
const { createLiveDoc } = await import('./LiveDoc');
const { metered } = await import('./meter');

describe('LiveDoc.add', () => {
  beforeEach(() => update.mockReset());

  it('ADDs the field, sets init only where absent and set every time, and returns the new count', async () => {
    update.mockResolvedValue({ Attributes: { count: 3, updatedAt: 9 } });
    const n = await createLiveDoc('t').add(
      'u#1',
      'lcs#s#reads',
      'count',
      1,
      { id: 's', deletedAt: null },
      { updatedAt: 9 },
    );
    expect(n).toBe(3);
    expect(update).toHaveBeenCalledWith({
      TableName: 't',
      Key: { PK: 'u#1', SK: 'lcs#s#reads' },
      UpdateExpression:
        'ADD #f :by SET #i0 = if_not_exists(#i0, :i0), #i1 = if_not_exists(#i1, :i1), #s0 = :s0',
      ExpressionAttributeNames: {
        '#f': 'count',
        '#i0': 'id',
        '#i1': 'deletedAt',
        '#s0': 'updatedAt',
      },
      ExpressionAttributeValues: { ':by': 1, ':i0': 's', ':i1': null, ':s0': 9 },
      ReturnValues: 'UPDATED_NEW',
    });
  });

  it('throws rather than return NaN when no number comes back', async () => {
    update.mockResolvedValue({ Attributes: {} });
    await expect(createLiveDoc('t').add('u#1', 'x', 'count', 1, {}, {})).rejects.toThrow(
      /no number/,
    );
  });
});

// The dev meter (meter.ts): metered, every SDK call asks for its ConsumedCapacity and records it; unmetered, the
// requests are exactly today's — the parameter appears nowhere.
describe('LiveDoc meter', () => {
  const all = [update, ...Object.values(sdk)];
  // The query's two pages are one-shot, so a second drive re-arms the mocks.
  const arm = () => {
    for (const f of all) f.mockReset();
    update.mockResolvedValue({ Attributes: { n: 1 }, ConsumedCapacity: { CapacityUnits: 1 } });
    sdk.get.mockResolvedValue({
      Item: { PK: 'p', SK: 'settings' },
      ConsumedCapacity: { CapacityUnits: 0.5 },
    });
    sdk.put.mockResolvedValue({ ConsumedCapacity: { CapacityUnits: 1 } });
    sdk.delete.mockResolvedValue({ ConsumedCapacity: { CapacityUnits: 1 } });
    sdk.batchWrite.mockResolvedValue({
      UnprocessedItems: {},
      ConsumedCapacity: [
        { TableName: 't', CapacityUnits: 2 },
        { TableName: 't', CapacityUnits: 3 },
      ],
    });
    sdk.query
      .mockResolvedValueOnce({
        Items: [
          { PK: 'p', SK: 'task#a' },
          { PK: 'p', SK: 'task#b', deletedAt: 5 },
        ],
        LastEvaluatedKey: { PK: 'p', SK: 'task#b' },
        ConsumedCapacity: { CapacityUnits: 4 },
      })
      .mockResolvedValueOnce({
        Items: [{ PK: 'p', SK: 'task#c', deletedAt: null }],
        ConsumedCapacity: { CapacityUnits: 1.5 },
      })
      .mockResolvedValue({ Items: [] }); // no ConsumedCapacity: counts 0
  };
  beforeEach(arm);

  const drive = async (d: ReturnType<typeof createLiveDoc>) => {
    await d.get('p', 'settings', { consistent: true });
    await d.put({ PK: 'p', SK: 'task#a' });
    await d.putIf({ PK: 'p', SK: 'task#a' }, null);
    await d.putIf({ PK: 'p', SK: 'task#a' }, 7);
    await d.query('p', 'task#', { consistent: true });
    await d.queryIndex('u#x#done', { from: 1, to: 2 });
    await d.delete('p', 'task#a');
    await d.deleteIf('p', 'task#a', 7);
    await d.add('p', 'lcs#s#reads', 'n', 1, {}, {});
    await d.batchPut([{ PK: 'p', SK: 'log#d#1' }]);
  };

  const params = () => all.flatMap((f) => f.mock.calls.map((c) => c[0] as Record<string, unknown>));

  it('unmetered: no call carries ReturnConsumedCapacity, and metering adds that key and nothing else', async () => {
    await drive(createLiveDoc('t'));
    const plain = params();
    expect(plain).toHaveLength(11); // 10 calls, the query paginating once
    for (const p of plain) expect(p).not.toHaveProperty('ReturnConsumedCapacity');
    arm();
    await drive(createLiveDoc('t', { meter: true }));
    expect(
      params().map((p) =>
        Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'ReturnConsumedCapacity')),
      ),
    ).toEqual(plain);
  });

  it('metered: every call asks for TOTAL, and the line sums pages, the batch array and absent capacity', async () => {
    const lines: string[] = [];
    await metered(
      'bff',
      () => 'x',
      async () => (await drive(createLiveDoc('t', { meter: true })), { statusCode: 200 }),
      {
        log: (l) => lines.push(l),
      },
    )({});
    const params = all.flatMap((f) => f.mock.calls.map((c) => c[0] as Record<string, unknown>));
    expect(params).toHaveLength(11);
    for (const p of params) expect(p).toHaveProperty('ReturnConsumedCapacity', 'TOTAL');
    const line = JSON.parse(lines[0]!) as { ru: number; wu: number; n: number; by: unknown[] };
    expect(line.ru).toBe(0.5 + 5.5 + 0);
    expect(line.wu).toBe(1 + 1 + 1 + 1 + 1 + 1 + 5);
    expect(line.n).toBe(10);
    expect(line.by).toEqual(
      expect.arrayContaining([
        ['qc:task', 1, 5.5, 3, 1], // two pages, one call; deletedAt null is not dead
        ['gc:settings', 1, 0.5, 1, 0],
        ['x:done', 1, 0, 0, 0],
        ['b:log', 1, 5, 0, 0],
        ['p:task', 3, 3, 0, 0],
        ['d:task', 2, 2, 0, 0],
        ['u:lcs', 1, 1, 0, 0],
      ]),
    );
  });
});
