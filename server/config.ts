function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(env("PORT", "8080")),
  dataDir: env("DATA_DIR", "./data"),
  publicUrl: env("PUBLIC_URL", "http://localhost:8080").replace(/\/$/, ""),
  serbleApi: env("SERBLE_API", "https://api.serble.net").replace(/\/$/, ""),
  serbleWeb: env("SERBLE_WEB", "https://serble.net").replace(/\/$/, ""),
  chatApi: env("SERBLE_CHAT_API", "https://api.chat.serble.net").replace(/\/$/, ""),
  chatClientId: env("SERBLE_CHAT_CLIENT_ID", "1ebf51ca-9eae-46ad-aa98-b984c47ad94d"),
  // Public identifiers (not secrets).
  clientId: env("SERBLE_CLIENT_ID", "f4270945-1cc9-4512-8f2d-56397dc2e62d"),
  ownerUserId: env("OWNER_USER_ID", "30b4a186-f30f-412f-b9af-d6cabb795c46"),
  clientSecret: env("SERBLE_CLIENT_SECRET"),
  appKey: env("SERBLE_APP_KEY"),
  rakePercent: Number(env("RAKE_PERCENT", "5")),
  maxStake: Number(env("MAX_STAKE", "100000")),
  turnSeconds: Number(env("TURN_SECONDS", "15")),
  version: env("APP_VERSION", "dev"),
};
