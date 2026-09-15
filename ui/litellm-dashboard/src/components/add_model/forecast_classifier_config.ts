import { z } from "zod";
import type { ClassifierType, ComplexityRouterConfigValue, ComplexityTiers } from "./ComplexityRouterConfig";
import { tierOrderFor } from "./tier_rows";

const probability = z.number().finite().min(0).max(1);
const version = z.string().trim().min(1).max(512);
const profile = z.string().trim().min(1).max(4000);
const transport = {
  max_output_tokens: z.number().int().positive().optional(),
  response_format: z.enum(["json_schema", "json_object"]).optional(),
};
const coefficients = z.object({ slope: z.number().finite().positive(), intercept: z.number().finite() });

const capabilityShape = {
  efficient_tier: z.string().min(1),
  capable_tier: z.string().min(1),
  base_threshold: probability,
  threshold_step: z.number().finite().nonnegative().optional(),
  ...transport,
  calibration: z
    .object({
      version: z
        .string()
        .min(1)
        .max(128)
        .regex(/^\S(?:.*\S)?$/),
      slope: z.number().finite().min(0).max(20),
      intercept: z.number().finite().min(-20).max(20),
    })
    .nullable()
    .optional(),
};
export const capabilitySettingsSchema = z.object(capabilityShape);

const fuseCalibrationShape = {
  version,
  prompt_version: z.literal("llm-v2-1"),
  efficient: coefficients,
  capable: coefficients,
};
const fuseShape = {
  efficient_tier: z.string().min(1).optional(),
  capable_tier: z.string().min(1).optional(),
  efficient_profile: profile,
  capable_profile: profile,
  harness: profile,
  max_quality_gap: probability,
  ...transport,
  calibration: z.object(fuseCalibrationShape).nullable().optional(),
};
export const fuseSettingsSchema = z.object(fuseShape);

export type CapabilitySettings = z.infer<typeof capabilitySettingsSchema>;
export type FuseSettings = z.infer<typeof fuseSettingsSchema>;

export const isForecastClassifier = (type: ClassifierType): boolean => type === "capability" || type === "llm_v2";

export const newCapabilitySettings = (): CapabilitySettings => ({
  efficient_tier: "SIMPLE",
  capable_tier: "REASONING",
  base_threshold: Number.NaN,
});

export const newFuseSettings = (): FuseSettings => ({
  efficient_profile: "",
  capable_profile: "",
  harness: "",
  max_quality_gap: Number.NaN,
});

export const forecastTierNames = (
  value: Pick<ComplexityRouterConfigValue, "classifier_type" | "capability_classifier_config" | "llm_v2_config">,
): readonly [string, string] => {
  const settings = value.classifier_type === "capability" ? value.capability_classifier_config : value.llm_v2_config;
  return [settings?.efficient_tier ?? "SIMPLE", settings?.capable_tier ?? "REASONING"];
};

export const forecastModels = (tiers: ComplexityTiers, tier: string): string[] =>
  Object.entries(tiers).find(([name]) => name === tier)?.[1] ?? [];

export const withoutForecastPromptOverrides = <T extends { system_prompt?: string; classification_rubric?: string }>(
  config: T,
): Omit<T, "system_prompt" | "classification_rubric"> => {
  const { system_prompt: _prompt, classification_rubric: _rubric, ...rest } = config;
  return rest;
};

export const prepareForecastClassifier = (value: ComplexityRouterConfigValue): ComplexityRouterConfigValue => {
  if (!isForecastClassifier(value.classifier_type))
    return {
      ...value,
      capability_classifier_config: undefined,
      llm_v2_config: undefined,
    };
  const configured = {
    ...value,
    capability_classifier_config:
      value.classifier_type === "capability"
        ? value.capability_classifier_config ?? newCapabilitySettings()
        : undefined,
    llm_v2_config: value.classifier_type === "llm_v2" ? value.llm_v2_config ?? newFuseSettings() : undefined,
  };
  const [efficient, capable] = forecastTierNames(configured);
  return {
    ...configured,
    custom_tier_set: undefined,
    enable_non_reasoning_tier: false,
    classification_prompt: undefined,
    classification_examples: undefined,
    classifier_fallback: undefined,
    classifier_llm_config: value.classifier_llm_config && withoutForecastPromptOverrides(value.classifier_llm_config),
    ...(value.classifier_type === "llm_v2" && {
      adaptive: false,
      tiers: {
        SIMPLE: [],
        MEDIUM: [],
        COMPLEX: [],
        REASONING: [],
        [efficient]: forecastModels(value.tiers, efficient).slice(0, 1),
        [capable]: forecastModels(value.tiers, capable).slice(0, 1),
      },
      plan_mode_min_tier:
        value.plan_mode_min_tier && [efficient, capable].includes(value.plan_mode_min_tier)
          ? value.plan_mode_min_tier
          : undefined,
    }),
  };
};

export const getForecastConfigError = (value: ComplexityRouterConfigValue): string | null => {
  if (!isForecastClassifier(value.classifier_type) || value.custom_tier_set) return null;
  const timeout = value.classifier_llm_config?.timeout_ms;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0))
    return "Enter a positive whole-number classifier timeout";
  const [efficient, capable] = forecastTierNames(value);
  const order: readonly string[] = tierOrderFor(value.enable_non_reasoning_tier);
  if (!order.includes(efficient) || !order.includes(capable) || order.indexOf(capable) <= order.indexOf(efficient))
    return "The capable tier must be higher than the efficient tier";
  const efficientModels = forecastModels(value.tiers, efficient);
  const capableModels = forecastModels(value.tiers, capable);
  if (!efficientModels.length || !capableModels.length)
    return "Select models for both the efficient and capable solvers";
  if (value.classifier_type === "capability") {
    const result = capabilitySettingsSchema.safeParse(value.capability_classifier_config);
    if (!result.success)
      return "Enter a solve threshold between 0 and 1 and valid capability settings, including any calibration coefficients";
    if (result.data.base_threshold + 2 * (result.data.threshold_step ?? 0) > 1)
      return "The solve threshold plus twice the boundary step must be at most 1";
    return null;
  }
  return getFuseConfigError(value, efficient, capable);
};

const getFuseConfigError = (value: ComplexityRouterConfigValue, efficient: string, capable: string): string | null => {
  const efficientModels = forecastModels(value.tiers, efficient);
  const capableModels = forecastModels(value.tiers, capable);
  if (value.adaptive) return "Turn off adaptive routing for Fuse v2";
  if (value.enable_non_reasoning_tier) return "Fuse v2 does not support the non-reasoning tier";
  if (efficientModels.length !== 1 || capableModels.length !== 1 || efficientModels[0] === capableModels[0])
    return "Fuse v2 requires one distinct model group for each solver";
  if (Object.entries(value.tiers).some(([tier, models]) => models.length > 0 && ![efficient, capable].includes(tier)))
    return "Fuse v2 supports only its efficient and capable tiers";
  const result = fuseSettingsSchema.safeParse(value.llm_v2_config);
  if (!result.success)
    return "Complete both solver profiles, the harness, and a quality gap between 0 and 1; any calibration needs valid coefficients and a version";
  return null;
};
