CREATE TABLE IF NOT EXISTS public.user_kv (
  user_id uuid NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT 'null'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_kv TO authenticated;
GRANT ALL ON public.user_kv TO service_role;
ALTER TABLE public.user_kv ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own kv select" ON public.user_kv FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own kv insert" ON public.user_kv FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own kv update" ON public.user_kv FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own kv delete" ON public.user_kv FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS user_kv_key_idx ON public.user_kv (key);

CREATE TABLE IF NOT EXISTS public.cron_config (
  id int PRIMARY KEY DEFAULT 1,
  token text NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex')
);
GRANT ALL ON public.cron_config TO service_role;
ALTER TABLE public.cron_config ENABLE ROW LEVEL SECURITY;
INSERT INTO public.cron_config (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.cron_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  responded int NOT NULL DEFAULT 0,
  total int NOT NULL DEFAULT 0,
  sources text[] NOT NULL DEFAULT '{}',
  probe jsonb,
  cycle jsonb,
  error text,
  requests int NOT NULL DEFAULT 0,
  duration_ms int NOT NULL DEFAULT 0,
  users_processed int NOT NULL DEFAULT 0,
  users_deferred int NOT NULL DEFAULT 0,
  skipped boolean NOT NULL DEFAULT false
);
GRANT ALL ON public.cron_runs TO service_role;
ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS cron_runs_ran_at_idx ON public.cron_runs (ran_at DESC);

CREATE TABLE IF NOT EXISTS public.cron_lock (
  id int PRIMARY KEY DEFAULT 1,
  locked_until timestamptz NOT NULL DEFAULT 'epoch',
  holder text
);
GRANT ALL ON public.cron_lock TO service_role;
ALTER TABLE public.cron_lock ENABLE ROW LEVEL SECURITY;
INSERT INTO public.cron_lock (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.try_cron_lock(p_holder text, p_lease_seconds int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE public.cron_lock SET locked_until = now() + make_interval(secs => p_lease_seconds), holder = p_holder
  WHERE id = 1 AND locked_until < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

CREATE OR REPLACE FUNCTION public.release_cron_lock(p_holder text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.cron_lock SET locked_until = 'epoch' WHERE id = 1 AND holder = p_holder;
$$;

REVOKE ALL ON FUNCTION public.try_cron_lock(text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_cron_lock(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_cron_lock(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_cron_lock(text) TO service_role;

CREATE OR REPLACE FUNCTION public.cron_status()
RETURNS TABLE(ran_at timestamptz, ok boolean, skipped boolean, duration_ms int, requests int, users_processed int, users_deferred int, error text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ran_at, ok, skipped, duration_ms, requests, users_processed, users_deferred, left(error, 200)
  FROM public.cron_runs ORDER BY ran_at DESC LIMIT 10;
$$;
REVOKE ALL ON FUNCTION public.cron_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cron_status() TO authenticated;

CREATE TABLE IF NOT EXISTS public.daily_stats (
  user_id uuid NOT NULL,
  day date NOT NULL,
  bets int NOT NULL DEFAULT 0,
  wins int NOT NULL DEFAULT 0,
  losses int NOT NULL DEFAULT 0,
  net_pct double precision NOT NULL DEFAULT 0,
  by_coin jsonb NOT NULL DEFAULT '{}'::jsonb,
  combo text,
  regime text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_stats TO authenticated;
GRANT ALL ON public.daily_stats TO service_role;
ALTER TABLE public.daily_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own daily select" ON public.daily_stats FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own daily insert" ON public.daily_stats FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own daily update" ON public.daily_stats FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own daily delete" ON public.daily_stats FOR DELETE TO authenticated USING (auth.uid() = user_id);