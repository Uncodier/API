/** Small, pinned facts from the same authorized site/settings load as AgentBase. */
export const MAX_VOICE_BUSINESS_BRIEF_LENGTH = 1_600;

type BusinessSource = {
  site?: { name?: unknown; description?: unknown } | null;
  settings?: { about?: unknown; products?: unknown; services?: unknown } | null;
};

function singleLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function excerpt(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 12).trimEnd()}… [excerpt]`;
}

function offeringNames(value: unknown): string[] {
  // DataFetcher normally decodes JSON. Do not serialize arbitrary settings or
  // product records: they can contain costs, private metadata and long copy.
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => singleLine(
    typeof entry === "string" ? entry : entry?.name
  )).filter(Boolean)));
}

function nameList(label: string, names: string[], limit: number): string {
  if (!names.length) return "";
  const included: string[] = [];
  const omitted = (count: number) => count ? ` [${count} more omitted; use tools.]` : "";
  // Keep complete names rather than a prefix of the first service's JSON.
  for (const name of names) {
    const candidate = `${label}: ${[...included, name].join("; ")}`;
    if (candidate.length + omitted(names.length - included.length - 1).length <= limit) {
      included.push(name);
    }
  }
  return `${label}: ${included.join("; ")}${omitted(names.length - included.length)}`;
}

export function buildVoiceBusinessBrief(source: BusinessSource, agentName: string): string {
  const businessName = singleLine(source.site?.name);
  const identity = businessName
    ? `Business name: ${excerpt(businessName, 160)}\nYou are ${excerpt(singleLine(agentName), 100)}, speaking for this business, not a generic assistant.`
    : "Business name unavailable. Do not invent it or infer it from the caller's wording; ask for clarification.";
  const overview = singleLine(source.settings?.about) || singleLine(source.site?.description);
  const introduction = [
    "# Business Identity and Offerings",
    identity,
    "Use these facts when asked who you represent or what the business does. If speech recognition suggests a different business or offering, clarify instead of adopting it.",
    "For an appointment about an unverified offering, first state this business's name and ask if the caller means an appointment with this business. Do not ask for an offering subtype, date or time until clarified; never imply that offering exists.",
    ...(overview ? [`Business overview: ${excerpt(overview, 320)}`] : []),
    "Configured offerings are an overview, not live availability or prices. Use tools to verify those before booking or selling.",
  ].join("\n");
  const services = offeringNames(source.settings?.services);
  const products = offeringNames(source.settings?.products);
  const available = MAX_VOICE_BUSINESS_BRIEF_LENGTH - introduction.length - 2;
  const serviceBudget = products.length ? Math.floor(available * (services.length ? 0.7 : 0)) : available;
  const serviceList = nameList("Services", services, serviceBudget);
  const productList = nameList("Products", products, available - serviceList.length);
  return [introduction, serviceList, productList].filter(Boolean).join("\n");
}