export {
  AtlassianClient,
  AtlassianError,
  adfToText,
  atlassianConfigFromEnv,
  confluencePageId,
  type AtlassianConfig,
  type IssueState,
} from "./atlassian.js";
export { markdownToStorage } from "./confluence-storage.js";
export { run, type ExecResult } from "./exec.js";
export { decodeText, htmlToText, loadLocalDocuments, MAX_FILE_BYTES, parseDocument, parseEmail, READABLE_EXTENSIONS, textDocument, type LoadError } from "./files.js";
export * from "./readers/index.js";
export {
  METADATA_PROVIDERS,
  redactLocation,
  resolveMetadataSource,
  type MetadataProvider,
  type MetadataSourceSpec,
} from "./metadata-source.js";
export { type PublishedPage } from "./atlassian.js";
export { SalesforceOrg, defaultSfRunner, orgToMarkdown, type OrgInfo, type SfRunner, type SObjectDescribe } from "./salesforce.js";
export {
  checkOrgArg,
  DEFAULT_ORG_TYPES,
  MAX_FILES_PER_RETRIEVE,
  readManifest,
  retrieveOrgMetadata,
  splitManifest,
  writeManifest,
  type ManifestEntry,
  type OrgRetrieval,
  type RetrieveOptions,
} from "./org-metadata.js";
export { BackgroundIndexer, indexOrg, indexProject, indexTarget, projectSource, type IndexJob, type IndexOptions, type IndexTarget } from "./indexing.js";
