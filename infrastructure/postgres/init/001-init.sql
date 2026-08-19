-- pgvector 扩展：Phase 7 Memory 语义检索使用
CREATE EXTENSION IF NOT EXISTS vector;

-- 会话持久化：桌面端重启后仍可恢复同一段对话
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  system_prompt text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions (updated_at DESC);
