import { z } from "zod";

const MAX_INPUT_LENGTH = 1024;
const emailSchema = z.string().max(254).email();
const unsafeCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;

function replaceSpokenSeparators(value: string): string {
  const words = value.split(/\s+/);
  const result: string[] = [];

  for (let index = 0; index < words.length; index += 1) {
    // Normalize only the separator lookup, never accents in the address itself.
    switch (words[index].normalize("NFC")) {
      case "arroba":
      case "at":
        result.push("@");
        break;
      case "punto":
      case "dot":
        result.push(".");
        break;
      case "underscore":
        result.push("_");
        break;
      case "guion":
      case "guión":
        if (words[index + 1] === "bajo") {
          result.push("_");
          index += 1;
        } else {
          result.push("-");
        }
        break;
      case "hyphen":
        result.push("-");
        break;
      default:
        result.push(words[index]);
    }
  }

  return result.join(" ");
}

function joinSpelledComponents(value: string): string | undefined {
  const components = value.split(/([@._+-])/);
  const result: string[] = [];

  for (const component of components) {
    const trimmed = component.trim();
    const letters = trimmed.split(/\s+/);
    // A whole component must be spelled out: never join "juan perez" or "me com".
    if (letters.length > 1 && !letters.every((letter) => /^[a-z0-9]$/.test(letter))) {
      return undefined;
    }
    result.push(letters.join(""));
  }

  return result.join("");
}

/**
 * Normalize only explicit email dictation, not prose or guessed domains.
 * Caller confirmation/consent remains the voice prompt's responsibility.
 */
export function normalizeVoiceIdentityEmail(value: unknown): string | undefined {
  // Check before trimming so even leading/trailing CRLF or a BOM is rejected.
  if (typeof value !== "string" || value.length > MAX_INPUT_LENGTH || unsafeCharacters.test(value)) {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  const original = emailSchema.safeParse(trimmed);
  if (original.success) return original.data;

  // At most one sentence-ending mark; never strip quotes, brackets or content.
  const utterance = trimmed.replace(/[.,;:!?]$/, "").trim();
  const literal = joinSpelledComponents(utterance);
  if (literal !== undefined) {
    const parsed = emailSchema.safeParse(literal);
    if (parsed.success) return parsed.data;
  }

  const candidate = joinSpelledComponents(replaceSpokenSeparators(utterance));
  const parsed = emailSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}