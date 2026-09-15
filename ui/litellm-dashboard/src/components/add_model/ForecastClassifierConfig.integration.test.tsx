import React, { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen } from "../../../tests/test-utils";
import ClassificationMethodConfig from "./ClassificationMethodConfig";
import type { ComplexityRouterConfigValue } from "./ComplexityRouterConfig";
import { getForecastConfigError } from "./forecast_classifier_config";
import { buildUpdatedComplexityRouterConfig } from "../edit_auto_router/edit_auto_router_modal";

const initial: ComplexityRouterConfigValue = {
  classifier_type: "capability",
  classifier_llm_config: { model: "judge", timeout_ms: 20000 },
  tiers: { SIMPLE: ["efficient"], MEDIUM: [], COMPLEX: [], REASONING: ["capable"] },
  capability_classifier_config: { efficient_tier: "SIMPLE", capable_tier: "REASONING", base_threshold: 0.7 },
};
const options = ["judge", "efficient", "capable"].map((model) => ({ value: model, label: model }));

function Form() {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState("");
  return (
    <>
      <ClassificationMethodConfig value={value} onChange={setValue} modelOptions={options} effortOptionsByModel={{}} />
      <button
        disabled={Boolean(getForecastConfigError(value))}
        onClick={() => setSaved(JSON.stringify(buildUpdatedComplexityRouterConfig({}, value)))}
      >
        Save configuration
      </button>
      <output aria-label="Saved configuration">{saved}</output>
    </>
  );
}

describe("forecast classifier form", () => {
  it("saves capability threshold edits together with fitted calibration", () => {
    renderWithProviders(<Form />);
    fireEvent.change(screen.getByLabelText("Solve probability threshold"), { target: { value: "0.6" } });
    fireEvent.click(screen.getByRole("switch", { name: "Use fitted calibration" }));
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Calibration version"), { target: { value: "eval-a" } });
    fireEvent.change(screen.getByLabelText("Efficient slope"), { target: { value: "1.2" } });
    fireEvent.change(screen.getByLabelText("Efficient intercept"), { target: { value: "-0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    const output = screen.getByRole("status", { name: "Saved configuration" });
    expect(output).toHaveTextContent('"base_threshold":0.6');
    expect(output).toHaveTextContent('"calibration":{"version":"eval-a","slope":1.2,"intercept":-0.3}');
    fireEvent.change(screen.getByLabelText("Solve probability threshold"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  });

  it("switches to Fuse, requires solver context, and saves the filled fields", () => {
    renderWithProviders(<Form />);
    fireEvent.click(screen.getByRole("radio", { name: /^Fuse v2/ }));
    expect(screen.queryByLabelText("Solve probability threshold")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Efficient solver profile"), {
      target: { value: "Short reasoning budget" },
    });
    fireEvent.change(screen.getByLabelText("Capable solver profile"), { target: { value: "Larger reasoning budget" } });
    fireEvent.change(screen.getByLabelText("Harness and budget"), {
      target: { value: "Shell and test runner, one attempt" },
    });
    fireEvent.change(screen.getByLabelText("Maximum quality gap"), { target: { value: "0.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    const output = screen.getByRole("status", { name: "Saved configuration" });
    expect(output).toHaveTextContent('"classifier_type":"llm_v2"');
    expect(output).toHaveTextContent('"efficient_profile":"Short reasoning budget"');
    expect(output).toHaveTextContent('"capable_profile":"Larger reasoning budget"');
    expect(output).toHaveTextContent('"harness":"Shell and test runner, one attempt"');
    expect(output).toHaveTextContent('"max_quality_gap":0.05');
    expect(output).toHaveTextContent('"adaptive":false');
    expect(output).not.toHaveTextContent('"capability_classifier_config"');
  });
});
