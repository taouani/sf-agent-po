export { Database, migrate, schemaVersion } from "./store/db.js";
export { MIGRATIONS, type Migration } from "./store/migrations.js";
export {
  ContextRepository,
  DOCUMENT_KINDS,
  documentId,
  validateContextName,
  type ContextInfo,
  type DocumentKind,
  type NewDocument,
  type SourceDocument,
} from "./store/contexts.js";
