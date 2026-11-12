export {
  AtlassianClient,
  AtlassianError,
  adfToText,
  atlassianConfigFromEnv,
  confluencePageId,
  type AtlassianConfig,
  type IssueState,
  type JiraStory,
} from "./atlassian.js";
export { diagramNames, markdownToStorage, type StorageOptions } from "./confluence-storage.js";
export {
  DRAWIO_MEDIA_TYPE,
  drawioMacro,
  drawioText,
  drawioXml,
  layoutDiagram,
  type DiagramGraph,
  type DiagramKind,
  type DiagramLayout,
} from "./drawio-write.js";
export { run, type ExecResult } from "./exec.js";
export { decodeText, htmlToText, loadLocalDocuments, MAX_FILE_BYTES, parseDocument, parseEmail, READABLE_EXTENSIONS, textDocument, type LoadError } from "./files.js";
export * from "./readers/index.js";
export {
  METADATA_PROVIDERS,
  parseRepoSpec,
  redactLocation,
  REPO_PROVIDERS,
  REPO_SPEC_HELP,
  repoSource,
  resolveMetadataSource,
  type MetadataProvider,
  type RepoProvider,
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
export { BackgroundIndexer, checkFolderSet, indexOrg, indexProject, indexRemote, indexTarget, formatDuration, projectSource, SET_NAME, setSource, StepTimer, summarizeWarnings, type FolderSet, type IndexJob, type IndexOptions, type IndexTarget } from "./indexing.js";
