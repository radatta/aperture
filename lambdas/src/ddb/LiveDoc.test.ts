import { beforeEach, describe, expect, it, vi } from 'vitest';

// LiveDoc.add's UpdateItem, against a stubbed SDK: the one write that isn't a whole-item put (the live-pull
// count). The rest of LiveDoc stays a thin wrapper proven on dev; this expression is easy to get subtly wrong.
const update = vi.fn();
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocument: { from: () => ({ update }) },
}));
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
  ConditionalCheckFailedException: class extends Error {},
}));
const { createLiveDoc } = await import('./LiveDoc');

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
