import { type DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ACTIVE_VARIANT_SETTING,
  DEFAULT_DECIDER_VARIANT,
  type DeciderVariantId,
  isDeciderVariantId,
} from "./decider-variants";

/**
 * Which decision-model variant the pipeline uses, stored in the settings table (one item). A
 * missing or unreadable item means the default variant, so a fresh stack works without setup.
 */
export async function getActiveDeciderVariant(
  ddb: DynamoDBDocumentClient,
  table: string
): Promise<{ variant: DeciderVariantId; updatedAt: string | null; updatedBy: string | null }> {
  const res = await ddb.send(
    new GetCommand({ TableName: table, Key: { settingKey: ACTIVE_VARIANT_SETTING }, ConsistentRead: true })
  );
  const value = res.Item?.value;
  return {
    variant: isDeciderVariantId(value) ? value : DEFAULT_DECIDER_VARIANT,
    updatedAt: typeof res.Item?.updatedAt === "string" ? res.Item.updatedAt : null,
    updatedBy: typeof res.Item?.updatedBy === "string" ? res.Item.updatedBy : null,
  };
}

export async function setActiveDeciderVariant(
  ddb: DynamoDBDocumentClient,
  table: string,
  variant: DeciderVariantId,
  updatedBy: string
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: {
        settingKey: ACTIVE_VARIANT_SETTING,
        value: variant,
        updatedAt: new Date().toISOString(),
        updatedBy,
      },
    })
  );
}
