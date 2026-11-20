INSERT INTO public.service_categories (slug, name, description)
VALUES
  ('it', 'IT', 'Technology, equipment, and access support.'),
  ('hr', 'HR', 'People operations and workplace support.'),
  ('facilities', 'Facilities', 'Workplace, building, and facilities support.')
ON CONFLICT (slug) DO NOTHING;
