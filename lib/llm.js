/**
 * LiteLLM client — OpenAI-compatible /v1/chat/completions.
 * Model gemini-2.5-flash handles both image and PDF input.
 */

const MODEL = "gemini-2.5-flash";

/**
 * Thrown when the model reply cannot be parsed into the expected JSON shape.
 * The server maps this to a clean 422 instead of a 500.
 */
export class LLMParseError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = "LLMParseError";
    this.raw = raw;
  }
}

/**
 * Send a document (PDF or image) to the LLM with a system + user prompt and
 * return the parsed JSON object the model emitted.
 *
 * @param {object}  args
 * @param {string}  args.systemPrompt
 * @param {string}  args.userPrompt
 * @param {Buffer}  args.fileBuffer
 * @param {string}  args.contentType  e.g. "application/pdf", "image/jpeg"
 */
export async function extractJson({ systemPrompt, userPrompt, fileBuffer, contentType }) {
  const baseUrl = (process.env.LITELLM_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.LITELLM_API_KEY;
  if (!baseUrl) throw new Error("LITELLM_BASE_URL must be set");
  if (!apiKey) throw new Error("LITELLM_API_KEY must be set");

  const dataUrl = `data:${contentType};base64,${fileBuffer.toString("base64")}`;

  const body = {
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LiteLLM responded ${resp.status}: ${text.slice(0, 500)}`);
  }

  const payload = await resp.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new LLMParseError("LLM returned an empty completion", payload);
  }

  return parseJsonLoose(content);
}

/**
 * Parse JSON from a model reply, tolerating markdown code fences or stray
 * prose around the object. Throws LLMParseError on failure.
 */
export function parseJsonLoose(raw) {
  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fenced / substring recovery
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through
    }
  }

  throw new LLMParseError("could not parse JSON from LLM reply", raw);
}
