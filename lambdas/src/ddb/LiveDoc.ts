import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { DocClient, IndexRange, Item } from './DocClient';

// The real DynamoDB single-table DocClient — the deploy-time (Phase 12) implementation of the same
// interface the in-memory table backs the tests with. Not exercised locally in Phase 10 (no AWS), so
// it stays a thin, obvious SDK wrapper: the behavior is proven against InMemoryDoc, this just speaks
// DynamoDB. Queries paginate to completion (single-user volume — the result sets are small).
export function createLiveDoc(tableName: string): DocClient {
  const doc = DynamoDBDocument.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  async function queryAll(params: Record<string, unknown>): Promise<Item[]> {
    const items: Item[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await doc.query({ TableName: tableName, ...params, ExclusiveStartKey });
      items.push(...((res.Items ?? []) as Item[]));
      ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (ExclusiveStartKey);
    return items;
  }

  return {
    async get(pk, sk) {
      const res = await doc.get({ TableName: tableName, Key: { PK: pk, SK: sk } });
      return (res.Item as Item | undefined) ?? null;
    },
    async put(item) {
      await doc.put({ TableName: tableName, Item: item });
    },
    async query(pk, skPrefix) {
      return queryAll({
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': pk, ':p': skPrefix },
      });
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
      return queryAll({
        IndexName: 'GSI1',
        KeyConditionExpression: expr,
        ExpressionAttributeValues: values,
      });
    },
    async delete(pk, sk) {
      await doc.delete({ TableName: tableName, Key: { PK: pk, SK: sk } });
    },
    async batchPut(items) {
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        await doc.batchWrite({
          RequestItems: { [tableName]: chunk.map((Item) => ({ PutRequest: { Item } })) },
        });
      }
    },
  };
}
