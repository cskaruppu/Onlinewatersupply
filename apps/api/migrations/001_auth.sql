-- Users sign in with a phone number. The number is stored encrypted (phone_enc);
-- phone_idx is a keyed hash used to find a user without decrypting every row.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_enc     text        NOT NULL,
  phone_idx     char(64)    NOT NULL UNIQUE,
  phone_last4   char(4)     NOT NULL,
  role          text        NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer', 'owner', 'driver', 'admin')),
  status        text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Refresh tokens are stored only as SHA-256 hashes. Each login starts a "family";
-- every refresh replaces the token, and reusing an old token revokes the whole family.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid        NOT NULL,
  token_hash  char(64)    NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  user_agent  text,
  ip_hash     char(64),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- Security audit trail for sign-in activity. IP addresses are stored hashed.
CREATE TABLE auth_events (
  id         bigserial PRIMARY KEY,
  event      text        NOT NULL,
  user_id    uuid        REFERENCES users(id) ON DELETE SET NULL,
  phone_idx  char(64),
  ip_hash    char(64),
  user_agent text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_created_idx ON auth_events (created_at);
CREATE INDEX auth_events_phone_idx ON auth_events (phone_idx);
