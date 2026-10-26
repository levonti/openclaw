// Preserve legacy plugin installation state across the v13 fold.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL } from "./openclaw-state-schema-v13-widerow.test-support.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const templateDirs = useAutoCleanupTempDirTracker(afterAll);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});
let templatePath: string;

beforeAll(async () => {
  const stateDir = templateDirs.make("openclaw-plugin-index-template-");
  templatePath = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } }).path;
  await closeOpenClawStateDatabaseAsync();
  using legacy = new (requireNodeSqlite().DatabaseSync)(templatePath);
  addPreCutoverClientCredentialTablesForTest(legacy);
  legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
});

const validIndex = {
  install_records_json: '{ "demo": { "source": "npm", "spec": "demo@1.0.0" } }',
  plugins_json: "[]",
  diagnostics_json: "[]",
};

function createLegacyStateDatabase(values: typeof validIndex) {
  const stateDir = tempDirs.make("openclaw-plugin-index-migration-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = resolveOpenClawStateSqlitePath(options.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(templatePath, databasePath);
  const legacy = new (requireNodeSqlite().DatabaseSync)(databasePath);
  legacy
    .prepare(`INSERT INTO installed_plugin_index (
    index_key, version, host_contract_version, compat_registry_version, migration_version,
    policy_hash, generated_at_ms, install_records_json, plugins_json, diagnostics_json, updated_at_ms
  ) VALUES ('installed-plugin-index', 1, 'host', 'compat', 1, 'policy', 10, ?, ?, ?, 11)`)
    .run(values.install_records_json, values.plugins_json, values.diagnostics_json);
  const original = legacy.prepare("SELECT * FROM installed_plugin_index").get();
  return { legacy, options, original };
}

it.each(
  (["runtime open", "doctor repair"] as const).flatMap((migrationPath) => [
    [migrationPath, "install_records_json", "[]"] as const,
    [migrationPath, "install_records_json", "{"] as const,
    [migrationPath, "plugins_json", "{}"] as const,
    [migrationPath, "diagnostics_json", "{"] as const,
  ]),
)(
  "preserves an invalid plugin-index row during captured v13 %s when %s is invalid (%s)",
  async (migrationPath, column, value) => {
    const values = { ...validIndex, [column]: value };
    const { legacy, options, original } = createLegacyStateDatabase(values);
    legacy.close();

    await withStateMigrationBackupForTest(options, () => {
      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      openOpenClawStateDatabase(options);
    });
    const { db } = openOpenClawStateDatabase(options);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'installed_plugin_index'").get(),
    ).toBeUndefined();
    const quarantine =
      "SELECT payload_json FROM diagnostic_events WHERE scope = 'plugins.installedIndex.quarantine'";
    const preserved = db.prepare(quarantine).get();
    expect(preserved).toBeDefined();
    expect(JSON.parse(String(preserved?.payload_json))).toMatchObject({
      level: "warn",
      message: expect.stringContaining("openclaw doctor --fix"),
      raw: original,
    });
    const folded = readConfigMachineState<{ index: { installRecords: unknown } }>(
      "plugins.installedIndex",
      options,
    );
    expect(folded?.index.installRecords).toEqual(
      column === "install_records_json" ? null : JSON.parse(values.install_records_json),
    );
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(reopened.prepare(quarantine).all()).toEqual([preserved]);
  },
);

it("keeps the legacy plugin-index row when quarantine preservation fails", async () => {
  const { legacy, options, original } = createLegacyStateDatabase({
    ...validIndex,
    install_records_json: "{",
  });
  legacy.exec(`
      INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at, sequence)
      VALUES ('plugins.installedIndex.quarantine', 'retained', '{}', 1, 9007199254740991);
    `);
  legacy.close();

  await expect(
    withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
  ).rejects.toThrow("Audit sequence exhausted");
  using retained = new (requireNodeSqlite().DatabaseSync)(
    resolveOpenClawStateSqlitePath(options.env),
  );
  expect(retained.prepare("SELECT * FROM installed_plugin_index").get()).toEqual(original);
  expect(retained.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
  expect(
    retained
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
      .get("plugins.installedIndex"),
  ).toBeUndefined();
});
