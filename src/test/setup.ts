import { applyTestDatabaseEnv } from "./db-env";

// Runs in every test worker before test modules load, so src/lib/db picks up the test URLs.
applyTestDatabaseEnv();

// Unit and integration tests never make live AI calls (Rule 6, D-186).
// Blank the developer's .env key for the test process so tests expecting
// unconfigured AI see that state without attempting outbound API calls.
process.env.ANTHROPIC_API_KEY = "";
