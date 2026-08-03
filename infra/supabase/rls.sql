-- Row Level Security for every current T3 Connect relay table.
--
-- Supabase creates anon, authenticated, and service_role. The Worker should connect through a
-- dedicated LOGIN role named relay_runtime that is a member of service_role. Supabase commonly
-- gives service_role BYPASSRLS; the explicit policies and grants below still document the intended
-- authorization boundary and support deployments where that attribute is removed.

BEGIN;

GRANT USAGE ON SCHEMA public TO service_role;

DO $rls$
DECLARE
  relay_table text;
  relay_tables constant text[] := ARRAY[
    'relay_mobile_devices',
    'relay_live_activities',
    'relay_environment_links',
    'relay_managed_endpoint_allocations',
    'relay_managed_tunnel_limits',
    'relay_environment_credentials',
    'relay_agent_activity_rows',
    'relay_delivery_attempts',
    'relay_dpop_proofs'
  ];
BEGIN
  FOREACH relay_table IN ARRAY relay_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relay_table);

    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',
      relay_table
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role',
      relay_table
    );

    EXECUTE format(
      'DROP POLICY IF EXISTS relay_service_role_full_access ON public.%I',
      relay_table
    );
    EXECUTE format(
      'CREATE POLICY relay_service_role_full_access ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      relay_table
    );

    EXECUTE format(
      'DROP POLICY IF EXISTS relay_anon_deny_all ON public.%I',
      relay_table
    );
    EXECUTE format(
      'CREATE POLICY relay_anon_deny_all ON public.%I AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)',
      relay_table
    );

    EXECUTE format(
      'DROP POLICY IF EXISTS relay_authenticated_deny_all ON public.%I',
      relay_table
    );
    EXECUTE format(
      'CREATE POLICY relay_authenticated_deny_all ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false)',
      relay_table
    );
  END LOOP;
END
$rls$;

COMMIT;
