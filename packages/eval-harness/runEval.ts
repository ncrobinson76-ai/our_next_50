import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { ScenarioInput, SynthesisOutput } from "./types";
import { synthesizeWeek } from "./synthesisEngine";

dotenv.config();

const SCENARIOS_DIR = path.join(__dirname, "scenarios");
const OUTPUT_DIR = path.join(__dirname, "output");

function loadScenarios(): ScenarioInput[] {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".json"));
  return files
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, file), "utf-8")) as ScenarioInput);
}

interface CliOptions {
  scenarioIds: string[];
  label?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const scenarioIds: string[] = [];
  let label: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--label") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--label requires a value, e.g. --label run2");
      }
      label = value;
      i++;
    } else {
      scenarioIds.push(arg);
    }
  }

  return { scenarioIds, label };
}

function selectScenarios(all: ScenarioInput[], requestedIds: string[]): ScenarioInput[] {
  if (requestedIds.length === 0) return all;

  const validIds = all.map((s) => s.id);
  const unknownIds = requestedIds.filter((id) => !validIds.includes(id));
  if (unknownIds.length > 0) {
    throw new Error(
      `Unknown scenario ID(s): ${unknownIds.join(", ")}\n\nValid scenario IDs:\n${validIds
        .map((id) => `  - ${id}`)
        .join("\n")}`
    );
  }

  return all.filter((s) => requestedIds.includes(s.id));
}

function outputFilename(scenarioId: string, label?: string): string {
  return label ? `${scenarioId}.${label}.md` : `${scenarioId}.md`;
}

function renderList(title: string, items: string[]): string {
  if (items.length === 0) return `### ${title}\n\n_None._\n`;
  return `### ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

function renderMarkdown(scenario: ScenarioInput, result: SynthesisOutput): string {
  const lines: string[] = [`# ${scenario.id}`, ""];

  if (result.safetyPathwayTriggered) {
    lines.push("## SAFETY PATHWAY TRIGGERED — normal synthesis skipped");
    lines.push("");
    lines.push(`**Categories:** ${result.safetyCheck.categories.join(", ")}`);
    lines.push("");
    lines.push("**Reasons:**");
    for (const reason of result.safetyCheck.reasons) lines.push(`- ${reason}`);
    lines.push("");
    lines.push("**Pathway message shown to user:**");
    lines.push("");
    lines.push(`> ${result.proposedNextStep.description}`);
    lines.push("");
    return lines.join("\n");
  }

  lines.push("_Safety check passed; normal synthesis below._");
  lines.push("");
  lines.push(renderList("Recorded Facts", result.recordedFacts));
  lines.push(renderList("Observations", result.observationsSummary));
  lines.push(renderList("Tentative Hypotheses", result.tentativeHypotheses));
  lines.push(renderList("What's Working", result.whatsWorking));
  lines.push(renderList("Friction", result.friction));
  lines.push(renderList("What Should Remain Unchanged", result.whatShouldRemainUnchanged));
  lines.push(`### Proposed Next Step (${result.proposedNextStep.type})`);
  lines.push("");
  lines.push(result.proposedNextStep.description);
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const { scenarioIds, label } = parseArgs(process.argv.slice(2));

  const allScenarios = loadScenarios();
  const scenarios = selectScenarios(allScenarios, scenarioIds);
  console.log(
    scenarioIds.length === 0
      ? `Loaded ${scenarios.length} scenarios (all).`
      : `Loaded ${scenarios.length} of ${allScenarios.length} scenarios (filtered).`
  );
  if (label) console.log(`Run label: ${label}`);

  let failures = 0;

  for (const scenario of scenarios) {
    process.stdout.write(`Running ${scenario.id}... `);
    try {
      const result = await synthesizeWeek(scenario);
      const markdown = renderMarkdown(scenario, result);
      fs.writeFileSync(path.join(OUTPUT_DIR, outputFilename(scenario.id, label)), markdown, "utf-8");
      console.log(result.safetyPathwayTriggered ? "safety pathway" : "ok");
    } catch (err) {
      failures++;
      console.log("FAILED");
      console.error(err);
    }
  }

  console.log(`\nDone. ${scenarios.length - failures}/${scenarios.length} scenarios completed successfully.`);
  console.log(`Output written to ${OUTPUT_DIR}`);

  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
