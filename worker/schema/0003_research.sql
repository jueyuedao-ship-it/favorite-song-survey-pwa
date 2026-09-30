-- Bounded research stage lookups; no new business table or export schema.
CREATE INDEX research_due_active ON research_jobs(json_extract(data,'$.status'),json_extract(data,'$.next_attempt_at'),json_extract(data,'$.lease_until')) WHERE json_extract(data,'$.deleted_at') IS NULL;
CREATE INDEX source_version_url_active ON sources(json_extract(data,'$.version_id'),json_extract(data,'$.url')) WHERE json_extract(data,'$.deleted_at') IS NULL;
CREATE INDEX credit_version_role_active ON credits(json_extract(data,'$.version_id'),json_extract(data,'$.role')) WHERE json_extract(data,'$.deleted_at') IS NULL;
CREATE INDEX entity_name_kind_active ON entities(json_extract(data,'$.name'),json_extract(data,'$.kind')) WHERE json_extract(data,'$.deleted_at') IS NULL;
