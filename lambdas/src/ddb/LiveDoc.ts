import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { ConditionFailedError, rangeOf } from './DocClient';
import type { DocClient, IndexRange, Item } from './DocClient';
import { indexKind, record, skKind } from './meter';
import type { Verb } from './meter';

// The real DynamoDB single-table DocClient — the deploy-time (Phase 12) implementation of the same
// interface the in-memory table backs the tests with. Not exercised locally in Phase 10 (no AWS), so
// it stays a thin, obvious SDK wrapper: the behavior is proven against InMemoryDoc, this just speaks
// DynamoDB. Queries paginate to completion (single-user volume — the result sets are small).
// `meter` (the dev slots only, meter.ts): every call also asks for its ConsumedCapacity and records it for the
// request's `ddb_units` line. Without it the requests are exactly the unmetered ones.
export function createLiveDoc(tableName: string, opts?: { meter?: boolean }): DocClient {
  const doc = DynamoDBDocument.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const meter = opts?.meter === true;
  const rcc = meter ? ({ ReturnConsumedCapacity: 'TOTAL' } as const) : {};
  const unitsOf = (c: { CapacityUnits?: number } | { CapacityUnits?: number }[] | undefined) =>
    (Array.isArray(c) ? c : c ? [c] : []).reduce((s, x) => s + (x.CapacityUnits ?? 0), 0);
  const isDead = (i: Item) => i.deletedAt !== undefined && i.deletedAt !== null;
  const note = (
    verb: Verb,
    kind: string,
    units: number,
    extra?: { consistent?: boolean; items?: Item[] },
  ) => {
    if (!meter) return;
    const items = extra?.items;
    record({
      verb,
      kind,
      units,
      consistent: extra?.consistent,
      ...(items ? { items: items.length, dead: items.filter(isDead).length } : {}),
    });
  };

  async function queryAll(
    params: Record<string, unknown>,
    m: { verb: Verb; kind: string; consistent?: boolean },
  ): Promise<Item[]> {
    const items: Item[] = [];
    let units = 0;
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await doc.query({ TableName: tableName, ...params, ExclusiveStartKey, ...rcc });
      items.push(...((res.Items ?? []) as Item[]));
      units += unitsOf(res.ConsumedCapacity);
      ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (ExclusiveStartKey);
    note(m.verb, m.kind, units, { consistent: m.consistent, items }); // one call, summed over its pages
    return items;
  }

  return {
    async get(pk, sk, opts) {
      const res = await doc.get({
        TableName: tableName,
        Key: { PK: pk, SK: sk },
        ConsistentRead: opts?.consistent === true,
        ...rcc,
      });
      const item = (res.Item as Item | undefined) ?? null;
      note('g', skKind(sk), unitsOf(res.ConsumedCapacity), {
        consistent: opts?.consistent === true,
        items: item ? [item] : [],
      });
      return item;
    },
    async put(item) {
      const res = await doc.put({ TableName: tableName, Item: item, ...rcc });
      note('p', skKind(item.SK), unitsOf(res.ConsumedCapacity));
    },
    async putIf(item, expectedUpdatedAt) {
      // A refused condition returns no capacity: the call is uncounted (writes only; the meter is about reads).
      try {
        const res = await doc.put(
          expectedUpdatedAt === null
            ? {
                TableName: tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(PK)',
                ...rcc,
              }
            : {
                TableName: tableName,
                Item: item,
                ConditionExpression: 'updatedAt = :u',
                ExpressionAttributeValues: { ':u': expectedUpdatedAt },
                ...rcc,
              },
        );
        note('p', skKind(item.SK), unitsOf(res.ConsumedCapacity));
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (
          err instanceof ConditionalCheckFailedException ||
          name === 'ConditionalCheckFailedException'
        )
          throw new ConditionFailedError();
        throw err;
      }
    },
    async query(pk, skPrefix, opts) {
      // One sort-key condition per query: a bound inside the prefix is BETWEEN, not begins_with AND >=.
      const bounded = opts?.from !== undefined || opts?.to !== undefined;
      const { from, to } = rangeOf(skPrefix, opts);
      if (from > to) return []; // BETWEEN refuses a reversed range; the in-memory doc and the stub read it as empty
      return queryAll(
        {
          KeyConditionExpression: bounded
            ? 'PK = :pk AND SK BETWEEN :from AND :to'
            : 'PK = :pk AND begins_with(SK, :p)',
          ExpressionAttributeValues: bounded
            ? { ':pk': pk, ':from': from, ':to': to }
            : { ':pk': pk, ':p': skPrefix },
          ConsistentRead: opts?.consistent === true,
        },
        { verb: 'q', kind: skKind(skPrefix), consistent: opts?.consistent === true },
      );
    },
    async queryIndex(gsi1pk, range?: IndexRange) {
      let expr = 'GSI1PK = :pk';
      const values: Record<string, unknown> = { ':pk': gsi1pk };
      if (range?.from !== undefined && range?.to !== undefined) {
        expr += ' AND GSI1SK BETWEEN :from AND :to';
        values[':from'] = range.from;
        values[':to'] = range.to;
      } else if (range?.from !== undefined) {
        expr += ' AND GSI1SK >= :from';
        values[':from'] = range.from;
      } else if (range?.to !== undefined) {
        expr += ' AND GSI1SK <= :to';
        values[':to'] = range.to;
      }
      return queryAll(
        { IndexName: 'GSI1', KeyConditionExpression: expr, ExpressionAttributeValues: values },
        { verb: 'x', kind: indexKind(gsi1pk) },
      );
    },
    async delete(pk, sk) {
      const res = await doc.delete({ TableName: tableName, Key: { PK: pk, SK: sk }, ...rcc });
      note('d', skKind(sk), unitsOf(res.ConsumedCapacity));
    },
    async deleteIf(pk, sk, expectedUpdatedAt) {
      // An unknown version can't be matched — and `updatedAt = :undefined` would be a malformed request.
      if (typeof expectedUpdatedAt !== 'number') throw new ConditionFailedError();
      try {
        const res = await doc.delete({
          TableName: tableName,
          Key: { PK: pk, SK: sk },
          ConditionExpression: 'updatedAt = :u',
          ExpressionAttributeValues: { ':u': expectedUpdatedAt },
          ...rcc,
        });
        note('d', skKind(sk), unitsOf(res.ConsumedCapacity));
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (
          err instanceof ConditionalCheckFailedException ||
          name === 'ConditionalCheckFailedException'
        )
          throw new ConditionFailedError();
        throw err;
      }
    },
    async add(pk, sk, field, by, init, set) {
      const names: Record<string, string> = { '#f': field };
      const values: Record<string, unknown> = { ':by': by };
      const sets = [
        ...Object.entries(init).map(([k, v], i) => {
          names[`#i${i}`] = k;
          values[`:i${i}`] = v;
          return `#i${i} = if_not_exists(#i${i}, :i${i})`;
        }),
        ...Object.entries(set).map(([k, v], i) => {
          names[`#s${i}`] = k;
          values[`:s${i}`] = v;
          return `#s${i} = :s${i}`;
        }),
      ];
      const res = await doc.update({
        TableName: tableName,
        Key: { PK: pk, SK: sk },
        UpdateExpression: `ADD #f :by${sets.length ? ` SET ${sets.join(', ')}` : ''}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'UPDATED_NEW',
        ...rcc,
      });
      note('u', skKind(sk), unitsOf(res.ConsumedCapacity));
      const n = res.Attributes?.[field];
      if (typeof n !== 'number') throw new Error(`add: no number came back for ${field}`);
      return n;
    },
    async batchPut(items) {
      for (let i = 0; i < items.length; i += 25) {
        // BatchWriteItem is best-effort per item: under throttling it returns the rejected writes in
        // UnprocessedItems rather than erroring. Retry those (capped, backed off) so a batch never
        // silently loses rows — the difference between "best-effort" and "quietly lossy".
        let requests: { PutRequest: { Item: Item } }[] = items
          .slice(i, i + 25)
          .map((Item) => ({ PutRequest: { Item } }));
        for (let attempt = 0; requests.length > 0; attempt++) {
          const res = await doc.batchWrite({ RequestItems: { [tableName]: requests }, ...rcc });
          note('b', skKind(requests[0]?.PutRequest.Item.SK ?? ''), unitsOf(res.ConsumedCapacity));
          requests = (res.UnprocessedItems?.[tableName] ?? []) as typeof requests;
          if (requests.length === 0) break;
          if (attempt >= 7)
            throw new Error(`batchPut: ${requests.length} items unprocessed after retries`);
          await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
        }
      }
    },
  };
}
