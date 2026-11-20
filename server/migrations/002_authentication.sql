ALTER TABLE public.users
  ADD COLUMN password_hash text,
  ADD CONSTRAINT users_password_hash_nonempty
    CHECK (password_hash IS NULL OR length(password_hash) > 0);

CREATE UNIQUE INDEX users_email_case_insensitive_idx
  ON public.users (lower(email));

CREATE TABLE public.auth_sessions (
  token_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_active_idx
  ON public.auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;
