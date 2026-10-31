export interface Migration { version: number; sql: string }

export const migrations: readonly Migration[] = [{
  version: 1,
  sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,                 -- UUID
  username TEXT NOT NULL,              -- 原样（去首尾空格）
  username_key TEXT NOT NULL UNIQUE,   -- 小写，用于不区分大小写的查找
  created_at TEXT NOT NULL
);

CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,         -- 随机令牌的 SHA-256（十六进制），库里不存明文
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tokens_user ON auth_tokens(user_id, created_at);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting','completed')),
  engine_preference TEXT NOT NULL DEFAULT 'auto'
    CHECK (engine_preference IN ('auto','remote','local','rules')),
  profile_json TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,          -- 已分配的最大消息序号
  last_assistant_seq INTEGER NOT NULL DEFAULT 0,-- 最新助手回复的序号，用于未读
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_preview TEXT,
  plan_id TEXT,
  create_client_id TEXT NOT NULL,               -- 新建时首条消息的 clientMessageId，用于创建幂等
  version INTEGER NOT NULL DEFAULT 1,           -- 每次变更 +1，前端按它取新
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, create_client_id)
);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  payload_json TEXT,
  client_message_id TEXT,
  turn_id TEXT,                         -- 助手消息：由哪个任务生成
  consumed_by_turn_id TEXT,             -- 用户消息：被哪个已完成的任务处理过
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, client_message_id)
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','completed','failed','cancelled','superseded')),
  stage TEXT NOT NULL CHECK (stage IN ('queued','understanding','deciding','replying','done')),
  input_message_ids_json TEXT NOT NULL,
  engine_requested TEXT NOT NULL,
  engine_used TEXT,
  fallbacks_json TEXT NOT NULL DEFAULT '[]',
  timings_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  prompt_version TEXT,
  retry_of_turn_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,   -- 被重启恢复的次数 + 1
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX uq_turns_active ON turns(conversation_id)
  WHERE status IN ('queued','running');           -- 每个会话最多一个进行中的任务
CREATE INDEX idx_turns_queue ON turns(status, created_at);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_plans_user ON plans(user_id, created_at DESC);

CREATE TABLE read_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- 全局递增，WebSocket 补发的游标
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_user ON events(user_id, id);
`,
}];
