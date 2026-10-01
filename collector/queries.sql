-- Open a read-only connection: sqlite3 'file:data/mirror.sqlite?mode=ro' -uri
-- Active responses by original work: counts, plus distinct supporters.
SELECT work_id, work_title, count(*) AS records, count(DISTINCT participant_id) AS supporters
FROM response_details WHERE record_date BETWEEN '2026-09-28' AND '2026-10-04'
AND version_id IS NOT NULL GROUP BY work_id, work_title ORDER BY records DESC;

-- Raw historical rows include tombstones; details views filter active rows.
SELECT response_id, participant_name, record_date, version_title, unresolved_title FROM response_details ORDER BY record_date DESC;
SELECT id AS response_id, deleted_at, revision FROM v_responses WHERE deleted_at IS NOT NULL;

-- Music credits and aliases remain separate from the uploading channel.
SELECT c.version_id,c.role,c.entity_name,a.name AS alias FROM credit_details c
LEFT JOIN v_aliases a ON a.entity_id=c.entity_id AND a.deleted_at IS NULL;
SELECT r.record_date,r.work_title,t.tag_name,t.evidence,t.source_id
FROM response_details r JOIN tag_details t ON t.version_id=r.version_id WHERE t.confirmed=1;

-- Original audit snapshots and separate correction history (no overwrite).
SELECT a.id,a."table",a.row_id,a.before,a.after,c.reason,c.corrected
FROM v_audit a LEFT JOIN v_audit_corrections c ON c.audit_id=a.id ORDER BY a.created_at;
SELECT key,value FROM mirror_meta WHERE key IN ('cursor','ack_cursor','last_ack_at');
SELECT sequence,event_json FROM events ORDER BY sequence;
