// SQLite backends use native primitives without loading host database lifecycle owners.
export type { Generated, Selectable } from "kysely";
export {
  compileSqliteQueryBindings,
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
export {
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  supportsNodeSqliteExtensionLoading,
} from "../infra/node-sqlite.js";
export {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
export type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
  SqliteWorkerOperations,
} from "../infra/sqlite-worker-contract.js";
export { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
// Restored to upstream's export surface: the trim dropped this line, and the standing-intents
// worker binding imports it from here. The target module is vendored.
export { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
export { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
