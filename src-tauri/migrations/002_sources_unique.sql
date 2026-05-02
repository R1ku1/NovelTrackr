CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_novel_domain 
ON sources(novel_id, domain);