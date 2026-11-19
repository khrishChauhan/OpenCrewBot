// OpenCrewBot 2.0 Dynamic Agent Factory
// Interprets natural-language requests to synthesize, validate, persist,
// and manage custom workforce agents safely.

import type { Bot, BotInput, BotTools, ApprovalMode, BotOutputPreferences } from "@/lib/shared/types";
import { createBot, updateBot, deleteBot } from "./service";
import { getBot } from "./db";
import { isBotBusy } from "./runtime";
import { DEFAULT_MODEL } from "./models";
import { DEFAULT_AGENT_HANDLES } from "./workforce-defaults";
import { InputError } from "./errors";

export interface AgentSpecDraft {
  name: string;
  handle?: string;
  title: string;
  role: string;
  description: string;
  instructions: string;
  emoji: string;
  color: string;
  model: string;
  tools: BotTools;
  approval: ApprovalMode;
  pinned: boolean;
  status: "active" | "inactive";
  skills: string[];
  outputPreferences: BotOutputPreferences;
}

export type ParseResult =
  | { success: true; spec: AgentSpecDraft }
  | { success: false; clarificationNeeded: true; question: string; missingFields: string[] };

export type AgentCreationResult =
  | { success: true; bot: Bot; spec: AgentSpecDraft }
  | { success: false; clarificationNeeded: true; question: string; missingFields: string[] };

/**
 * Natural Language Parser for agent creation requests.
 * Extracts persona, role, capabilities, tools, permissions, and output styles from free text.
 */
export function parseAgentRequest(prompt: string): ParseResult {
  const text = prompt.trim();
  if (!text) {
    return {
      success: false,
      clarificationNeeded: true,
      question: "What role, responsibilities, or skills should this agent have?",
      missingFields: ["role", "instructions"],
    };
  }

  // Check if request is overly brief or lacks actionable role definition
  const genericWords = /^(create|build|make|add|spawn|generate)\s+(a|an|the)?\s*(bot|agent|teammate|worker)?$/i;
  if (genericWords.test(text) || text.length < 8) {
    return {
      success: false,
      clarificationNeeded: true,
      question: "Could you specify the agent's primary title, domain expertise, and intended responsibilities?",
      missingFields: ["role", "instructions"],
    };
  }

  // 1. Extract Role & Title
  // Common patterns: "Create a [role] who [specialization]...", "Build an agent named [name]..."
  let extractedName = "";
  let extractedRole = "";
  let extractedSpecialization = "";

  const namedMatch = text.match(/named\s+["']?([a-zA-Z0-9\s_-]+?)["']?(?:,|\s+who|\s+that|\s+with|\s*$)/i);
  if (namedMatch) {
    extractedName = namedMatch[1].trim();
  }

  const rolePatterns = [
    /(?:create|build|make|add|spawn)\s+(?:a|an)\s+([a-zA-Z0-9\s_-]+?)(?:\s+who|\s+that|\s+specializing|\s+specializes|\s+with|\s+to|\s+for|\.|$)/i,
    /([a-zA-Z0-9\s_-]+?)\s+(?:who|that)\s+(?:specializes|focuses|works)/i,
  ];

  for (const pat of rolePatterns) {
    const m = text.match(pat);
    if (m && m[1].trim().length > 2 && !m[1].toLowerCase().includes("agent") && !m[1].toLowerCase().includes("bot")) {
      extractedRole = m[1].trim();
      break;
    }
  }

  if (!extractedRole && namedMatch) {
    extractedRole = namedMatch[1].trim();
  }

  if (!extractedRole) {
    // Fallback: look for common professions or nouns
    const professionMatch = text.match(/\b(strategist|analyst|engineer|developer|writer|auditor|designer|manager|researcher|consultant|specialist|assistant|marketer|expert)\b/i);
    if (professionMatch) {
      extractedRole = capitalizeWords(professionMatch[1]);
    } else {
      extractedRole = "Autonomous Specialist";
    }
  }

  // Capitalize title
  extractedRole = capitalizeWords(extractedRole);
  if (!extractedName) {
    extractedName = extractedRole;
  }

  // 2. Extract Specialization / Niche
  const specMatch = text.match(
    /(?:specializes\s+in|specializing\s+in|focuses\s+on|expert\s+in|centered\s+on)\s+([^,]+?)(?:\s+(?:and\s+requires|and\s+uses|with\s+|who\s+|that\s+)|[,.]|$)/i,
  );
  if (specMatch) {
    extractedSpecialization = capitalizeWords(specMatch[1].trim());
  } else {
    extractedSpecialization = `Expertise In ${extractedRole}`;
  }

  // 3. Extract Tools & Capabilities
  const lower = text.toLowerCase();
  const tools: BotTools = {
    webSearch: /(research|search|web|google|browse|crawl|market intelligence|tavily)/i.test(lower),
    memory: !/(no memory|stateless|without memory)/i.test(lower),
    codeMode: /(code|coding|typescript|python|scripts|programming|arithmetic|execute)/i.test(lower),
    browser: /(browser|playwright|puppeteer|click|automate web|drive web)/i.test(lower),
    askUser: !/(no questions|autonomous only|never ask)/i.test(lower),
  };

  // 4. Extract Approval / Permission Tier
  let approval: ApprovalMode = "controlled";
  if (/(require[s]?\s+approval|ask\s+first|ask\s+before|gated|confirm\s+before|human\s+sign-off)/i.test(lower)) {
    approval = "ask";
  } else if (/(full\s+access|full\s+autonomy|autonomous\s+mode|unrestricted|no\s+approval)/i.test(lower)) {
    approval = "full";
  }

  // 5. Extract Skills
  const skills: string[] = [];
  if (tools.webSearch) skills.push("web_research");
  if (tools.codeMode) skills.push("code_execution");
  if (/(writing|copywriting|documentation|articles|posts|drafts)/i.test(lower)) skills.push("writing");
  if (/(finance|financial|burn|revenue|pricing|valuation)/i.test(lower)) skills.push("financial_analysis");
  if (/(security|audit|vulnerability|compliance)/i.test(lower)) skills.push("security_audit");
  if (/(qa|verification|testing|quality)/i.test(lower)) skills.push("quality_assurance");
  if (/(strategy|campaign|campaigns|planning)/i.test(lower)) skills.push("strategic_planning");
  if (skills.length === 0) skills.push("domain_analysis");

  // 6. Contextual Emoji & Theme Color
  const { emoji, color } = pickAppearance(extractedRole + " " + extractedSpecialization);

  // 7. Output Preferences
  let format: BotOutputPreferences["format"] = "markdown";
  if (/(bullet|bullets|list)/i.test(lower)) format = "bullet";
  else if (/(json|structured|schema)/i.test(lower)) format = "structured";

  let tone = "professional";
  if (/(casual|friendly)/i.test(lower)) tone = "conversational";
  else if (/(rigorous|strict|adversarial)/i.test(lower)) tone = "rigorous";
  else if (/(executive|concise)/i.test(lower)) tone = "executive";

  // 8. Generate Instructions
  const instructions = [
    `You are ${extractedName}, a specialist in ${extractedSpecialization}.`,
    `Your role is ${extractedRole}.`,
    `Approach tasks with ${tone} discipline and clarity.`,
    tools.webSearch ? "Thoroughly research questions, cite your sources, and verify data before making claims." : "",
    tools.codeMode ? "Use TypeScript execution when exact calculations, filtering, or programmatic multi-tool coordination is required." : "",
    approval === "ask" ? "Pause and request explicit human approval before executing sensitive, mutating, or external operations." : "",
    `Deliver your output in ${format} format with clear, direct insights and zero conversational fluff.`,
  ].filter(Boolean).join(" ");

  const description = `${extractedRole} specializing in ${extractedSpecialization}.`;

  const spec: AgentSpecDraft = {
    name: extractedName.slice(0, 40),
    title: extractedRole.slice(0, 40),
    role: extractedSpecialization,
    description: description.slice(0, 300),
    instructions,
    emoji,
    color,
    model: DEFAULT_MODEL,
    tools,
    approval,
    pinned: false,
    status: "active",
    skills,
    outputPreferences: {
      format,
      tone,
      detailLevel: "standard",
    },
  };

  return { success: true, spec };
}

/**
 * Creates, persists, and registers a new agent from a natural-language description.
 */
export async function createAgentFromNaturalLanguage(prompt: string): Promise<AgentCreationResult> {
  const parsed = parseAgentRequest(prompt);
  if (!parsed.success) {
    return parsed;
  }

  const { spec } = parsed;

  const botInput: BotInput = {
    name: spec.name,
    title: spec.title,
    role: spec.role,
    description: spec.description,
    instructions: spec.instructions,
    emoji: spec.emoji,
    color: spec.color,
    model: spec.model,
    tools: spec.tools,
    approval: spec.approval,
    pinned: spec.pinned,
    status: spec.status,
    skills: spec.skills,
    outputPreferences: spec.outputPreferences,
  };

  const bot = await createBot(botInput);
  return { success: true, bot, spec };
}

/**
 * Clones an existing agent with a new unique name and handle.
 */
export async function duplicateAgent(botId: string, nameOverride?: string): Promise<Bot> {
  const source = await getBot(botId);
  if (!source) throw new InputError(`Agent '${botId}' not found.`);

  const newName = nameOverride ? nameOverride.trim() : `${source.name} (Copy)`;
  const input: BotInput = {
    name: newName,
    title: source.title,
    role: source.role,
    description: source.description,
    instructions: source.instructions,
    emoji: source.emoji,
    color: source.color,
    model: source.model,
    tools: { ...source.tools },
    approval: source.approval,
    pinned: false,
    status: "active",
    skills: source.skills ? [...source.skills] : [],
    outputPreferences: source.outputPreferences ? { ...source.outputPreferences } : undefined,
  };

  return await createBot(input);
}

/**
 * Deactivates an agent so it cannot be assigned new tasks or turns.
 */
export async function deactivateAgent(botId: string): Promise<Bot> {
  return await updateBot(botId, { status: "inactive", pinned: false });
}

/**
 * Re-activates an inactive agent.
 */
export async function activateAgent(botId: string): Promise<Bot> {
  return await updateBot(botId, { status: "active" });
}

/**
 * Safely deletes a custom agent with strict operational safeguards:
 * 1. Blocks deletion if agent is currently executing a turn.
 * 2. Protects default workforce agents from deletion.
 */
export async function deleteAgentSafely(botId: string): Promise<void> {
  const bot = await getBot(botId);
  if (!bot) throw new InputError(`Agent '${botId}' not found.`);

  if (isBotBusy(botId)) {
    throw new InputError(`Cannot delete agent '${bot.name}' while it is actively executing a turn.`);
  }

  if (DEFAULT_AGENT_HANDLES.includes(bot.handle)) {
    throw new InputError(`Agent '${bot.name}' (@${bot.handle}) is a default workforce agent and cannot be deleted.`);
  }

  await deleteBot(botId);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function capitalizeWords(str: string): string {
  const acronyms: Record<string, string> = {
    b2b: "B2B",
    b2c: "B2C",
    saas: "SaaS",
    ai: "AI",
    api: "API",
    qa: "QA",
    ui: "UI",
    ux: "UX",
    cicd: "CI/CD",
    seo: "SEO",
  };

  return str
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => {
      const lower = w.toLowerCase();
      if (acronyms[lower]) return acronyms[lower];
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function pickAppearance(text: string): { emoji: string; color: string } {
  const t = text.toLowerCase();
  if (/(social|media|marketing|campaign|b2b)/.test(t)) return { emoji: "📱", color: "#ec4899" };
  if (/(finance|financial|model|accounting|tax|invest)/.test(t)) return { emoji: "📊", color: "#059669" };
  if (/(security|audit|cyber|crypto|vulnerability)/.test(t)) return { emoji: "🛡️", color: "#dc2626" };
  if (/(devops|infra|cloud|kubernetes|docker|deploy)/.test(t)) return { emoji: "☁️", color: "#0284c7" };
  if (/(code|software|engineer|developer|architect)/.test(t)) return { emoji: "💻", color: "#2563eb" };
  if (/(qa|tester|verification|quality)/.test(t)) return { emoji: "🔍", color: "#d97706" };
  if (/(writer|editor|docs|copy|content)/.test(t)) return { emoji: "✍️", color: "#ea580c" };
  if (/(research|scientist|data|intel)/.test(t)) return { emoji: "🔬", color: "#7c3aed" };
  if (/(legal|compliance|regulatory)/.test(t)) return { emoji: "⚖️", color: "#475569" };
  return { emoji: "🤖", color: "#6366f1" };
}
