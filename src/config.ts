import { config as loadEnv } from "dotenv";

loadEnv();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function requireAnyEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  throw new Error(
    `Missing required environment variable. Set one of: ${names.join(", ")}`,
  );
}

function envValuesByPrefix(prefix: string): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => name.startsWith(prefix) && Boolean(value?.trim()))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => value!.trim());
}

export const appConfig = {
  discordToken: requireEnv("DISCORD_TOKEN"),
  clientId: requireEnv("CLIENT_ID"),
  aiApiKey: requireAnyEnv(["ALABS_API_KEY", "OPENAI_KEY"]),
  geminiApiKeys: envValuesByPrefix("GEMINI_API_KEY"),
  aiBaseUrl: requireEnv("ALABS_AI_BASE_URL"),
  textModel: "google/gemini-3-flash-lite",
  geminiTextModel: "gemini-3.1-flash-lite",
  textMaxTokens: 550,
  textTemperature: 0.6,
  textTopP: 0.9,
  imageModel: "google/gemini-3.1-flash-image",
  geminiImageModel: "gemini-3.1-flash-lite-image",
};
