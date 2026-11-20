CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  role text NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'staff')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_nonempty CHECK (length(trim(email)) > 0)
);

CREATE TABLE public.service_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (length(trim(slug)) > 0),
  name text NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  assigned_to uuid REFERENCES public.users(id) ON DELETE SET NULL,
  category_id uuid NOT NULL REFERENCES public.service_categories(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'in_progress', 'waiting_on_employee', 'resolved', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT service_requests_resolution_time CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE TABLE public.request_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (length(trim(body)) > 0),
  is_internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.request_activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(trim(action)) > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX service_requests_requester_created_idx
  ON public.service_requests (requester_id, created_at DESC);
CREATE INDEX service_requests_assignee_status_idx
  ON public.service_requests (assigned_to, status) WHERE assigned_to IS NOT NULL;
CREATE INDEX service_requests_status_created_idx
  ON public.service_requests (status, created_at DESC);
CREATE INDEX service_requests_category_created_idx
  ON public.service_requests (category_id, created_at DESC);
CREATE INDEX request_comments_request_created_idx
  ON public.request_comments (request_id, created_at);
CREATE INDEX request_activity_logs_request_created_idx
  ON public.request_activity_logs (request_id, created_at);

CREATE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER service_categories_set_updated_at
  BEFORE UPDATE ON public.service_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER service_requests_set_updated_at
  BEFORE UPDATE ON public.service_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE FUNCTION public.ensure_assignee_is_staff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = NEW.assigned_to AND role = 'staff'
  ) THEN
    RAISE EXCEPTION 'Assigned user must have the staff role'
      USING ERRCODE = '23514', CONSTRAINT = 'service_requests_assigned_staff';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_requests_assigned_staff
  BEFORE INSERT OR UPDATE OF assigned_to ON public.service_requests
  FOR EACH ROW EXECUTE FUNCTION public.ensure_assignee_is_staff();

CREATE FUNCTION public.prevent_role_change_for_assigned_staff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role <> 'staff' AND OLD.role = 'staff' AND EXISTS (
    SELECT 1 FROM public.service_requests WHERE assigned_to = OLD.id
  ) THEN
    RAISE EXCEPTION 'Cannot change a staff role while the user is assigned to requests'
      USING ERRCODE = '23514', CONSTRAINT = 'users_assigned_staff_role';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_preserve_assigned_staff_role
  BEFORE UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.prevent_role_change_for_assigned_staff();
