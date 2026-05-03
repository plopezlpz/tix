PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  -- group_id: TODO Phase 2 — bundle related issues that share a parent doc.
  -- Currently unused; kept as a column so the future feature doesn't need
  -- a migration.
  group_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  tmux_session TEXT,
  slot INTEGER,
  -- agent_state / agent_state_at: TODO Phase 3 — populated by the daemon
  -- from tmux pane activity (working / waiting_input / idle / crashed).
  agent_state TEXT,
  agent_state_at INTEGER,
  needs_human_validation INTEGER NOT NULL DEFAULT 0,
  plan_review_round INTEGER NOT NULL DEFAULT 0,
  code_review_round INTEGER NOT NULL DEFAULT 0,
  human_validation_round INTEGER NOT NULL DEFAULT 0,
  -- pr_url: TODO Phase 2 — set by the publisher once a host PR API is wired.
  -- Read by `tix show`; currently always null.
  pr_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_updated ON issues(updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_state ON issues(agent_state);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT,
  at INTEGER NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_id, at);

CREATE TABLE IF NOT EXISTS slots (
  slot INTEGER PRIMARY KEY,
  issue_id INTEGER,
  claimed_at INTEGER,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE SET NULL
);
