import { describe, expect, it } from "vitest";
import type { ComplexityRouterConfigValue } from "./ComplexityRouterConfig";
import { getForecastConfigError, prepareForecastClassifier } from "./forecast_classifier_config";
import {
  buildUpdatedComplexityRouterConfig,
  hydrateComplexityRouterConfig,
} from "../edit_auto_router/edit_auto_router_modal";

const capability: ComplexityRouterConfigValue = {
  classifier_type: "capability",
  classifier_llm_config: { model: "judge", timeout_ms: 20000 },
  tiers: { SIMPLE: ["efficient"], MEDIUM: [], COMPLEX: [], REASONING: ["capable"] },
  capability_classifier_config: {
    efficient_tier: "SIMPLE",
    capable_tier: "REASONING",
    base_threshold: 0.7,
    threshold_step: 0.1,
  },
};
const fuse: ComplexityRouterConfigValue = {
  ...capability,
  classifier_type: "llm_v2",
  capability_classifier_config: undefined,
  adaptive: false,
  llm_v2_config: {
    efficient_profile: "A concise solver",
    capable_profile: "A solver with more reasoning budget",
    harness: "One attempt with shell and tests",
    max_quality_gap: 0.05,
  },
};

describe("forecast classifier configuration", () => {
  it.each([
    { version: "eval", slope: 21, intercept: 0 },
    { version: "eval", slope: 1, intercept: -21 },
    { version: " eval ", slope: 1, intercept: 0 },
  ])("rejects capability calibration outside the server contract: %j", (calibration) => {
    const value = {
      ...capability,
      capability_classifier_config: { ...capability.capability_classifier_config!, calibration },
    };
    expect(getForecastConfigError(value)).toContain("calibration");
  });

  it.each([capability, fuse])("accepts a complete $classifier_type configuration", (value) => {
    expect(getForecastConfigError(value)).toBeNull();
  });

  it("requires both solvers without requiring unused middle tiers", () => {
    expect(getForecastConfigError({ ...capability, tiers: { ...capability.tiers, REASONING: [] } })).toContain("both");
    expect(getForecastConfigError(capability)).toBeNull();
  });

  it("rejects a stepped threshold that exceeds one", () => {
    expect(
      getForecastConfigError({
        ...capability,
        capability_classifier_config: { ...capability.capability_classifier_config!, threshold_step: 0.2 },
      }),
    ).toContain("twice");
  });

  it.each([Number.NaN, -0.1, 1.1])("rejects an invalid probability %s", (base_threshold) => {
    expect(
      getForecastConfigError({
        ...capability,
        capability_classifier_config: { ...capability.capability_classifier_config!, base_threshold },
      }),
    ).not.toBeNull();
  });

  it.each(["efficient_profile", "capable_profile", "harness"] as const)("requires %s for Fuse", (field) => {
    expect(getForecastConfigError({ ...fuse, llm_v2_config: { ...fuse.llm_v2_config!, [field]: " " } })).not.toBeNull();
  });

  it("requires distinct single model groups and disables adaptive selection", () => {
    expect(getForecastConfigError({ ...fuse, tiers: { ...fuse.tiers, SIMPLE: ["capable"] } })).toContain("distinct");
    expect(getForecastConfigError({ ...fuse, tiers: { ...fuse.tiers, SIMPLE: ["efficient", "second"] } })).toContain(
      "distinct",
    );
    expect(getForecastConfigError({ ...fuse, adaptive: true })).toContain("adaptive");
  });

  it("removes incompatible prompt and tier settings when switching to Fuse", () => {
    const previous: ComplexityRouterConfigValue = {
      ...fuse,
      adaptive: true,
      classifier_fallback: "default_model",
      classifier_llm_config: {
        model: "judge",
        timeout_ms: 20000,
        system_prompt: "old rubric",
        classification_rubric: "business",
      },
      classification_prompt: "old prompt",
      classification_examples: "old example",
      tiers: { ...fuse.tiers, MEDIUM: ["extra"], SIMPLE: ["efficient", "second"] },
    };
    const next = prepareForecastClassifier(previous);
    const saved = buildUpdatedComplexityRouterConfig({}, next);
    expect(getForecastConfigError(next)).toBeNull();
    expect(saved.adaptive).toBe(false);
    expect(saved.tiers).toEqual(fuse.tiers);
    expect(saved.classifier_llm_config).toEqual({ model: "judge", timeout_ms: 20000 });
    expect(saved).not.toHaveProperty("classification_prompt");
    expect(saved).not.toHaveProperty("classification_examples");
    expect(saved).not.toHaveProperty("classifier_fallback");
  });

  it("preserves fitted calibration through edits and removes it when disabled", () => {
    const stored = {
      ...capability,
      capability_classifier_config: {
        ...capability.capability_classifier_config!,
        calibration: { version: "eval-a", slope: 1.2, intercept: -0.3 },
      },
    };
    const hydrated = hydrateComplexityRouterConfig(stored, undefined);
    const edited = {
      ...hydrated,
      capability_classifier_config: { ...hydrated.capability_classifier_config!, base_threshold: 0.6 },
    };
    expect(buildUpdatedComplexityRouterConfig(stored, edited).capability_classifier_config).toEqual({
      ...stored.capability_classifier_config,
      base_threshold: 0.6,
    });
    const disabled = {
      ...edited,
      capability_classifier_config: { ...edited.capability_classifier_config, calibration: undefined },
    };
    expect(buildUpdatedComplexityRouterConfig(stored, disabled).capability_classifier_config).toHaveProperty(
      "calibration",
      undefined,
    );
  });

  it("preserves non-default tier assignments", () => {
    const value = {
      ...capability,
      capability_classifier_config: {
        ...capability.capability_classifier_config!,
        efficient_tier: "MEDIUM",
        capable_tier: "COMPLEX",
      },
      tiers: { SIMPLE: [], MEDIUM: ["efficient"], COMPLEX: ["capable"], REASONING: [] },
    };
    expect(getForecastConfigError(value)).toBeNull();
    expect(buildUpdatedComplexityRouterConfig({}, value).capability_classifier_config).toEqual(
      value.capability_classifier_config,
    );
  });

  it.each([capability, fuse])("drops $classifier_type settings when switching to the heuristic", (value) => {
    const saved = buildUpdatedComplexityRouterConfig(value, { ...value, classifier_type: "heuristic" });
    expect(saved).not.toHaveProperty("capability_classifier_config");
    expect(saved).not.toHaveProperty("llm_v2_config");
  });
});
