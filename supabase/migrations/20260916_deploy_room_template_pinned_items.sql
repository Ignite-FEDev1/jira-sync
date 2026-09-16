ALTER TABLE public.deploy_room_templates
  ADD COLUMN IF NOT EXISTS pinned_before_items text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS pinned_after_items  text[] NOT NULL DEFAULT '{}';
