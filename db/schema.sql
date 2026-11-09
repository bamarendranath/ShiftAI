CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  country_code TEXT NOT NULL DEFAULT 'DE' CHECK (char_length(country_code) = 2),
  industry TEXT NOT NULL DEFAULT 'Restaurant & food service',
  weekly_hours_cap SMALLINT NOT NULL DEFAULT 40 CHECK (weekly_hours_cap BETWEEN 8 AND 60),
  minimum_rest_hours SMALLINT NOT NULL DEFAULT 11 CHECK (minimum_rest_hours BETWEEN 8 AND 24),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS users_workspace_idx ON users(workspace_id);

CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (char_length(role) BETWEEN 1 AND 60),
  unavailable_days SMALLINT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (array_position(unavailable_days, NULL) IS NULL),
  CHECK (unavailable_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::SMALLINT[])
);

CREATE INDEX IF NOT EXISTS team_members_workspace_idx ON team_members(workspace_id);

CREATE TABLE IF NOT EXISTS rule_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code TEXT NOT NULL CHECK (char_length(country_code) = 2),
  region_code TEXT,
  industry TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'reviewed', 'active', 'retired')),
  source_urls TEXT[] NOT NULL DEFAULT '{}',
  effective_from DATE,
  effective_to DATE,
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (country_code, region_code, industry, version),
  CHECK (status <> 'active' OR (
    reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND cardinality(source_urls) > 0
  ))
);

CREATE INDEX IF NOT EXISTS rule_profiles_lookup_idx
  ON rule_profiles(country_code, industry, status);

CREATE TABLE IF NOT EXISTS schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  is_stale BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, week_start)
);

CREATE TABLE IF NOT EXISTS schedule_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  day_index SMALLINT NOT NULL CHECK (day_index BETWEEN 0 AND 6),
  shift_key TEXT NOT NULL CHECK (shift_key IN ('morning', 'evening')),
  team_member_id UUID REFERENCES team_members(id) ON DELETE SET NULL,
  UNIQUE (schedule_id, day_index, shift_key)
);

CREATE INDEX IF NOT EXISTS schedules_workspace_week_idx ON schedules(workspace_id, week_start);
CREATE INDEX IF NOT EXISTS schedule_shifts_schedule_idx ON schedule_shifts(schedule_id);
