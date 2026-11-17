/**
 * The decision model's endpoint variants: the same model on a CPU instance or on a GPU instance.
 * Settings picks which one the pipeline uses ("active"); a run uses that one only. This module has
 * no AWS SDK imports so the CDK app can share it (lib/decider-config.ts).
 */
export type DeciderVariantId = "cpu" | "gpu";
export const DECIDER_VARIANT_IDS: readonly DeciderVariantId[] = ["cpu", "gpu"];
/** The variant the pipeline uses until someone picks another one in Settings. */
export const DEFAULT_DECIDER_VARIANT: DeciderVariantId = "cpu";
/** Key of the active-variant item in the settings table. */
export const ACTIVE_VARIANT_SETTING = "decider.activeVariant";

export function isDeciderVariantId(value: unknown): value is DeciderVariantId {
  return value === "cpu" || value === "gpu";
}

/** One variant as the Lambdas receive it in env DECIDER_VARIANTS (set by lib/decision-model.ts). */
export interface DeciderVariantInfo {
  id: DeciderVariantId;
  label: string;
  endpointName: string;
  endpointConfigName: string;
  instanceType: string;
  hourlyUsd: number | null;
}

const NAME = /^[a-zA-Z0-9](-*[a-zA-Z0-9]){0,62}$/;

/** Parse and validate env DECIDER_VARIANTS. Throws on anything unexpected: it is deploy config. */
export function parseDeciderVariants(raw: string | undefined): DeciderVariantInfo[] {
  const parsed: unknown = JSON.parse(raw ?? "[]");
  if (!Array.isArray(parsed)) throw new Error("DECIDER_VARIANTS must be a JSON array");
  const variants = parsed.map((item): DeciderVariantInfo => {
    const r = (item ?? {}) as Record<string, unknown>;
    if (
      !isDeciderVariantId(r.id) ||
      typeof r.label !== "string" ||
      typeof r.endpointName !== "string" ||
      !NAME.test(r.endpointName) ||
      typeof r.endpointConfigName !== "string" ||
      !NAME.test(r.endpointConfigName) ||
      typeof r.instanceType !== "string"
    ) {
      throw new Error("DECIDER_VARIANTS has an invalid entry");
    }
    const hourly = typeof r.hourlyUsd === "number" && Number.isFinite(r.hourlyUsd) && r.hourlyUsd > 0 ? r.hourlyUsd : null;
    return {
      id: r.id,
      label: r.label,
      endpointName: r.endpointName,
      endpointConfigName: r.endpointConfigName,
      instanceType: r.instanceType,
      hourlyUsd: hourly,
    };
  });
  if (new Set(variants.map((v) => v.id)).size !== variants.length) {
    throw new Error("DECIDER_VARIANTS has duplicate ids");
  }
  return variants;
}
