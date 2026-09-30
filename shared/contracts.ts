/** Stable JSON contract. All dates are JST civil dates, all timestamps ISO UTC. */
export const API_PREFIX = "/api/v1";
export const SCHEMA_VERSION = 1;
export type ApiResult<T> =
  | { data: T }
  | { error: { code: string; message: string } };
export interface Mutation {
  operation_id: string;
}
export interface RevisionMutation extends Mutation {
  expected_revision: number;
}
export interface Row {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export interface Participant extends Row {
  name: string;
}
export interface Work extends Row {
  title: string;
  manual_lock: boolean;
}
export type VersionKind = "original" | "cover" | "remix" | "other";
export type ResearchStatus =
  | "unconfirmed"
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "needs_review";
export interface Version extends Row {
  work_id: string;
  title: string;
  kind: VersionKind;
  reference_url: string | null;
  uploader_entity_id: string | null;
  research_status: ResearchStatus;
  manual_lock: boolean;
}
export interface Entity extends Row {
  name: string;
  kind: "person" | "group" | "synthetic_voice" | "channel";
  manual_lock: boolean;
}
export interface Alias extends Row {
  entity_id: string;
  name: string;
}
export type CreditRole = "vocalist" | "composer" | "release_name" | "uploader";
export interface Credit extends Row {
  version_id: string;
  entity_id: string;
  role: CreditRole;
  source_id: string | null;
  confirmed: boolean;
  manual_lock: boolean;
}
export interface SurveyRecord extends Row {
  participant_id: string;
  version_id: string | null;
  record_date: string;
  unresolved_title: string | null;
  artist_hint: string | null;
  reference_url: string | null;
}
export interface Tag extends Row {
  name: string;
  category: string;
  criterion: string;
  active: boolean;
}
export interface TagAssignment extends Row {
  version_id: string;
  tag_id: string;
  evidence: string;
  source_id: string | null;
  origin: "admin" | "research";
  confirmed: boolean;
  manual_lock: boolean;
}
export interface Source extends Row {
  version_id: string;
  url: string;
  title: string;
  excerpt: string;
  checked_at: string;
  origin: "admin" | "research";
}
export interface ResearchResult extends Row {
  version_id: string;
  model: string;
  dictionary_version: string;
  analysis_version: string;
  source_ids: string[];
  payload: Record<string, unknown>;
}
export interface ResearchEvidence {
  id: string;
  url: string;
  title: string;
  content: string;
}
export interface ResearchClaim {
  name: string;
  kind: Entity["kind"];
  role: CreditRole;
  source_id: string;
  quote: string;
  aliases: { name: string; quote: string }[];
}
export interface ResearchRecording {
  original?: {
    title: string;
    reference_url: string;
    source_id: string;
    quote: string;
  } | null;
  title: string;
  reference_url: string;
  kind: VersionKind;
  source_id: string;
  quote: string;
  credits: ResearchClaim[];
  tags: {
    tag_id: string;
    source_id: string;
    quote: string;
    reasoning?: string;
  }[];
}
export interface ResearchAnalysis {
  recordings: ResearchRecording[];
}
export interface ResearchJob extends Row {
  stage?:
    | "search"
    | "extract"
    | "infer"
    | "catalog"
    | "metadata"
    | "await_versions"
    | "done";
  evidence?: ResearchEvidence[];
  analysis?: ResearchAnalysis;
  metadata_cursor?: number;
  catalog_cursor?: number;
  version_id: string | null;
  response_id: string | null;
  query: {
    title: string;
    artist_hint: string | null;
    reference_url: string | null;
  } | null;
  candidates: CatalogCandidate[];
  status: ResearchStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  lease_until: string | null;
  dictionary_version: string;
  analysis_version: string;
}
export interface Usage extends Row {
  month: string;
  tavily_credits: number;
  tavily_credit_cap: number;
  groq_requests: number;
  last_error: string | null;
}
export interface Device extends Row {
  participant_id: string;
  label: string;
  revoked_at: string | null;
}
export interface Invite extends Row {
  participant_id: string;
  expires_at: string;
  claimed_at: string | null;
}
export interface Audit extends Row {
  table: BusinessTable;
  row_id: string;
  action: "create" | "update" | "delete";
  actor_id: string;
  actor_type: "guest" | "admin" | "system";
  participant_id: string | null;
  before: unknown;
  after: unknown;
  effective?: unknown;
}
export interface AuditCorrection extends Row {
  audit_id: string;
  reason: string;
  corrected: Record<string, unknown>;
  actor_id: string;
}
export interface SyncAcknowledgement extends Row {
  collector_id: string;
  cursor: number;
  schema_version: number;
}
export interface BusinessRows {
  participants: Participant;
  works: Work;
  versions: Version;
  entities: Entity;
  aliases: Alias;
  credits: Credit;
  responses: SurveyRecord;
  tags: Tag;
  tag_assignments: TagAssignment;
  sources: Source;
  research_results: ResearchResult;
  research_jobs: ResearchJob;
  usage: Usage;
  devices: Device;
  invites: Invite;
  audit: Audit;
  audit_corrections: AuditCorrection;
  sync_status: SyncAcknowledgement;
}
export type BusinessTable = keyof BusinessRows;
export type EditableTable =
  | "participants"
  | "works"
  | "versions"
  | "entities"
  | "aliases"
  | "credits"
  | "tags"
  | "tag_assignments"
  | "sources";
export type CreateValues<T extends BusinessTable> = Omit<
  BusinessRows[T],
  keyof Row
>;
export interface DataCreate<T extends EditableTable> extends Mutation {
  values: Partial<CreateValues<T>>;
}
export interface DataUpdate<T extends EditableTable> extends RevisionMutation {
  values: Partial<CreateValues<T>>;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export interface GuestCreate extends Mutation {
  name: string;
  device_label: string;
  device_secret: string;
}
export interface GuestClaim extends Mutation {
  invite_secret: string;
  device_label: string;
  device_secret: string;
}
export interface GuestIdentity {
  participant: Participant;
  device_id: string;
}
export interface InviteCreate extends Mutation {
  participant_id: string;
  invite_secret: string;
}
export interface RecordCreate extends Mutation {
  version_id: string | null;
  record_date: string;
  unresolved_title?: string | null;
  artist_hint?: string | null;
  reference_url?: string | null;
  participant_id?: string;
}
export interface RecordUpdate extends RevisionMutation {
  version_id?: string | null;
  record_date?: string;
  unresolved_title?: string | null;
  artist_hint?: string | null;
  reference_url?: string | null;
  participant_id?: string;
}
export interface CatalogCandidate extends Version {
  work_title: string;
  credits: (Credit & { entity_name: string })[];
}
export interface SongDetail {
  version: Version;
  work: Work;
  credits: (Credit & { entity: Entity; aliases: Alias[] })[];
  tags: (TagAssignment & { tag: Tag })[];
  sources: Source[];
}
export interface RecordCandidates {
  response_id: string;
  status: ResearchStatus;
  candidates: CatalogCandidate[];
  last_error: string | null;
}
export interface Ranking {
  id: string;
  title: string;
  count: number;
  rank: number;
  supporter_count: number;
  supporters: Pick<Participant, "id" | "name">[];
}
export interface RoleCount {
  entity_id: string;
  name: string;
  count: number;
}
export interface WeeklyTag {
  week_start: string;
  total_records: number;
  unparsed_records: number;
  tags: { tag_id: string; name: string; count: number; percentage: number }[];
}
export interface Statistics {
  from: string;
  to: string;
  group_by: "work" | "version";
  total_records: number;
  unparsed_records: number;
  rankings: Ranking[];
  roles: Record<CreditRole, RoleCount[]>;
  weekly_tags: WeeklyTag[];
}
export interface ChangeEvent {
  sequence: number;
  table: BusinessTable;
  row_id: string;
  action: "upsert";
  row: BusinessRows[BusinessTable];
  occurred_at: string;
}
export interface SyncFeed {
  schema_version: number;
  high_watermark: number;
  next_cursor: number;
  has_more: boolean;
  events: ChangeEvent[];
}
export interface BusinessExport {
  schema_version: number;
  high_watermark: number;
  exported_at: string;
  tables: { [T in BusinessTable]: BusinessRows[T][] };
}
export interface Health {
  schema_version: number;
  configured: {
    admin: boolean;
    sync: boolean;
    groq: boolean;
    tavily: boolean;
    research_runner: boolean;
  };
}
export interface AdminSession {
  session_token: string;
  expires_at: string;
}
export interface AuditCorrectionCreate extends Mutation {
  reason: string;
  corrected: Record<string, unknown>;
}
export interface ResolveRecord extends RevisionMutation {
  version_id: string;
}
export interface ResearchRetry extends RevisionMutation {}
export interface UsageUpdate extends RevisionMutation {
  tavily_credit_cap: number;
}
export interface UsageCreate extends Mutation {
  tavily_credit_cap: number;
}
/** Handler passed by Task 3. No external research is represented as completed without it. */
export interface WorkerEnv {
  DB: D1Database;
  ADMIN_PASSWORD_HASH?: string;
  ALLOWED_ORIGINS?: string;
  GROQ_API_KEY?: string;
  TAVILY_API_KEY?: string;
  SYNC_TOKEN_HASH?: string;
  GROQ_MODEL?: string;
}
