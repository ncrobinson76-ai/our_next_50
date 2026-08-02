import { DeepgramClient } from "@deepgram/sdk";

// Speech-to-text via Deepgram. Chosen over the alternatives considered
// (OpenAI Whisper API, Groq) specifically for its configurable
// zero-retention option (mip_opt_out below) — a better structural fit for
// PRD Section 17/11's requirement to weigh and document provider
// retention behavior than a policy-only "we don't train on your data"
// assurance. See README.md for the full comparison.

const DEFAULT_MODEL = "nova-3";

export interface TranscriptionResult {
  text: string;
  confidence: number | null;
  modelName: string;
  modelVersion: string | null;
}

let cachedClient: DeepgramClient | null = null;

function getClient(): DeepgramClient {
  if (!cachedClient) {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error("DEEPGRAM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    }
    cachedClient = new DeepgramClient({ apiKey });
  }
  return cachedClient;
}

export async function transcribeAudio(audio: Buffer, mimeType: string): Promise<TranscriptionResult> {
  const client = getClient();
  const model = process.env.DEEPGRAM_MODEL || DEFAULT_MODEL;

  let response;
  try {
    response = await client.listen.v1.media.transcribeFile(
      { data: audio, contentType: mimeType },
      {
        model,
        // Excludes this request from Deepgram's Model Improvement Program;
        // data is retained only as long as needed to process the request —
        // the zero-retention behavior this provider was chosen for.
        mip_opt_out: true,
      }
    );
  } catch (err) {
    throw new Error(`Deepgram transcription failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const alternative =
    "results" in response ? response.results?.channels?.[0]?.alternatives?.[0] : undefined;
  if (!alternative?.transcript) {
    throw new Error("Deepgram returned no transcription alternative.");
  }

  return {
    text: alternative.transcript,
    confidence: typeof alternative.confidence === "number" ? alternative.confidence : null,
    modelName: "deepgram",
    modelVersion: model,
  };
}
