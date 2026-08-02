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

  const scenarios = loadScenarios();
  console.log(`Loaded ${scenarios.length} scenarios.`);

  let failures = 0;

  for (const scenario of scenarios) {
    process.stdout.write(`Running ${scenario.id}... `);
    try {
      const result = await synthesizeWeek(scenario);
      const markdown = renderMarkdown(scenario, result);
      fs.writeFileSync(path.join(OUTPUT_DIR, `${scenario.id}.md`), markdown, "utf-8");
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

main();
