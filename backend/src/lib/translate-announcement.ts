// ---------------------------------------------------------------------------
// Announcement auto-translation — reusable core. Ported from Hookka
// (src/api/lib/translate-announcement.ts).
//
// The office posts a free-text announcement in ONE language. To support
// multilingual office staff we translate ONCE on POST (and on edit when
// title/body change), store all four versions as a JSON blob on the row, and
// the FE picks the matching language at render time.
//
// HOUZS NOTE: ANTHROPIC_API_KEY is OPTIONAL in Env. When unset the call
// short-circuits to null and the FE simply renders the original title/body.
// The route never blocks on the translate call — a Claude outage or missing
// key MUST NEVER prevent posting an announcement.
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Anthropic returns transient 429 rate-limits and 529 "Overloaded" / 5xx spikes
// that clear on a retry. Without one a single transient blip drops the whole
// announcement translation to null (FE then shows the original text only). Retry
// those a few times with an exponential-ish backoff; non-retryable statuses and
// the final attempt fall through to the caller's existing !resp.ok handling.
const RETRYABLE_ANTHROPIC_STATUS = new Set([429, 500, 502, 503, 529]);

async function anthropicFetchWithRetry(
  init: RequestInit,
  tries = 3,
): Promise<Response> {
  let resp: Response | null = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    resp = await fetch(ANTHROPIC_URL, init);
    if (resp.ok) return resp;
    let overloaded = false;
    try {
      const peek = await resp.clone().text();
      if (/overloaded/i.test(peek)) overloaded = true;
    } catch { /* body peek is best-effort */ }
    const retryable = RETRYABLE_ANTHROPIC_STATUS.has(resp.status) || overloaded;
    if (!retryable || attempt === tries - 1) return resp;
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  return resp as Response;
}

// Four supported languages — English, Bahasa Melayu, Simplified Chinese,
// Burmese. Mirrors the Hookka worker portal even though Houzs office staff
// today mostly read English (covers future regional expansion + keeps the
// translation blob stable so a 5th language is a single column addition).
export const ANNOUNCEMENT_LANGS = ["en", "ms", "zh", "my"] as const;
export type AnnouncementLang = (typeof ANNOUNCEMENT_LANGS)[number];

// One translated pair.
export type TranslationPair = { title: string; body: string };

// The full stored shape — title+body for every supported language.
export type AnnouncementTranslations = Record<AnnouncementLang, TranslationPair>;

type AnthropicTranslateResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
  usage?: { input_tokens?: number; output_tokens?: number };
};

const SYSTEM_PROMPT = `You are a translator for an interior/exhibition company's office-staff announcements. You receive a notice's TITLE and BODY in some language and must translate BOTH into all four target languages.

Target languages (use exactly these JSON keys):
  - en — English
  - ms — Bahasa Melayu (Malay)
  - zh — Simplified Chinese
  - my — Burmese

Rules:
  - Return STRICT JSON ONLY, no commentary, no markdown fences, in exactly this shape:
    {"en":{"title":"...","body":"..."},"ms":{"title":"...","body":"..."},"zh":{"title":"...","body":"..."},"my":{"title":"...","body":"..."}}
  - Translate naturally for office staff — plain, clear, professional.
  - For the language the notice is ALREADY in, return its original text unchanged.
  - PRESERVE all numbers, dates, times, money amounts, product codes, SKUs, and proper names verbatim.
  - PRESERVE line breaks in the body (keep \\n where the original had them).
  - If the BODY is empty, return an empty string for body in every language.
  - The very first character of your response must be "{". Anything else corrupts the stored data.`;

function validateTranslations(
  parsed: unknown,
): AnnouncementTranslations | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const out = {} as AnnouncementTranslations;
  for (const lang of ANNOUNCEMENT_LANGS) {
    const pair = obj[lang];
    if (!pair || typeof pair !== "object") return null;
    const p = pair as Record<string, unknown>;
    if (typeof p.title !== "string" || typeof p.body !== "string") return null;
    out[lang] = { title: p.title, body: p.body };
  }
  return out;
}

function extractJson(raw: string): string {
  let s = raw.trim();
  const fence = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const m = s.match(fence);
  if (m) s = m[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s;
}

export function parseTranslationsText(
  raw: string,
): AnnouncementTranslations | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }
  return validateTranslations(parsed);
}

/**
 * Translate a posted announcement's title + body into all four supported
 * languages with ONE Claude call.
 *
 * Best-effort by contract: returns `null` (never throws) on a missing key,
 * a Claude error, a network failure, or an unparseable response. The caller
 * stores null and the FE falls back to the original posted text — so the
 * translate call can NEVER block posting an announcement.
 */
export async function translateAnnouncement(args: {
  title: string;
  body: string;
  apiKey: string | undefined;
}): Promise<AnnouncementTranslations | null> {
  const { title, body, apiKey } = args;
  if (!apiKey) return null;
  if (!title.trim() && !body.trim()) return null;

  const userPayload = JSON.stringify({ title, body });

  try {
    const resp = await anthropicFetchWithRetry({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Translate this announcement (title + body) into all four target languages:\n\n${userPayload}`,
              },
            ],
          },
        ],
      }),
    });

    if (!resp.ok) return null;
    const bodyText = await resp.text();
    let parsedResp: AnthropicTranslateResponse;
    try {
      parsedResp = JSON.parse(bodyText) as AnthropicTranslateResponse;
    } catch {
      return null;
    }
    if (parsedResp.error) return null;
    const firstText =
      parsedResp.content?.find((b) => b.type === "text")?.text ?? "";
    return parseTranslationsText(firstText);
  } catch {
    return null;
  }
}
