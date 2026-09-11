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

-- LLM usage ledger：每次真实调用一行（tokens；DeepSeek 可估 cost_cny）
CREATE TABLE IF NOT EXISTS llm_usage (
  id uuid PRIMARY KEY,
  session_id uuid,
  colleague text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_cny numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_usage_created_idx ON llm_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_colleague_created_idx ON llm_usage (colleague, created_at DESC);
