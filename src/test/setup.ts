import { applyTestDatabaseEnv } from "./db-env";

// Runs in every test worker before test modules load, so src/lib/db picks up the test URLs.
applyTestDatabaseEnv();
