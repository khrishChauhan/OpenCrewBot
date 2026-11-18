import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Generate an isolated temporary directory for testing so real user data is untouched
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencrewbot-test-"));
process.env.OPENCREWBOT_DATA_DIR = testDataDir;
(process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";

// Ensure mock mode is default in tests
delete process.env.NEBIUS_API_KEY;
delete process.env.TAVILY_API_KEY;
delete process.env.BROWSERBASE_API_KEY;
delete process.env.COMPOSIO_API_KEY;
delete process.env.TYPESAFE_API_KEY;

export { testDataDir };
