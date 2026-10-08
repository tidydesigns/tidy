-- Operator operation, not an automatically applied schema migration.
-- Run in a transaction with tidy.runtime_role set to the existing runtime role.
-- See migrations/README.md#runtime-privileges. This never creates or rotates credentials.
DO $runtime_grants$
DECLARE
  runtime_name text := current_setting('tidy.runtime_role');
  runtime_oid oid;
  table_name text;
  known_tables text[] := ARRAY[
    'account',
    'agentConnection',
    'agentEvent',
    'agentMessage',
    'agentOAuthAttempt',
    'agentReservation',
    'agentRun',
    'agentThread',
    'agentThreadFile',
    'agentToolOperation',
    'agentWorker',
    'billingDeployment',
    'billingPlan',
    'billingPlanPrice',
    'connectorAccount',
    'connectorConnection',
    'connectorOAuthState',
    'connectorOperation',
    'connectorWebhookDelivery',
    'designAsset',
    'designCommentMessage',
    'designCommentReaction',
    'designCommentThread',
    'designDocument',
    'designFile',
    'designFileRestore',
    'designFileThumbnail',
    'designFileVersion',
    'designFileVersionAsset',
    'designFolder',
    'designFrame',
    'designImport',
    'designObject',
    'designRealtimeEvent',
    'designRealtimeOperation',
    'designRealtimeProperty',
    'designRealtimeState',
    'designRectangle',
    'feedbackUpload',
    'githubCapture',
    'githubConnection',
    'githubFeedback',
    'githubOAuthState',
    'githubReview',
    'githubReviewAsset',
    'githubUser',
    'githubWebhookDelivery',
    'invitation',
    'jwks',
    'member',
    'oauthAccessToken',
    'oauthClient',
    'oauthClientAssertion',
    'oauthClientResource',
    'oauthConsent',
    'oauthRefreshToken',
    'oauthResource',
    'organization',
    'organizationCreationPermission',
    'organizationMcpUsage',
    'organization_billing',
    'session',
    'user',
    'vaultLogin',
    'verification'];
  protected_tables text[] := ARRAY['billingDeployment','billingPlan','billingPlanPrice','organizationCreationPermission'];
BEGIN
  SELECT oid INTO runtime_oid FROM pg_roles
    WHERE rolname = runtime_name AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
      AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication;
  IF runtime_oid IS NULL OR runtime_name = current_user THEN
    RAISE EXCEPTION 'Choose a separate existing non-administrative runtime login';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid
    WHERE a.member=runtime_oid AND r.rolname NOT IN ('pg_read_all_data','pg_write_all_data')) THEN
    RAISE EXCEPTION 'Review unexpected runtime role memberships before changing privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner=runtime_oid)
    OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner=runtime_oid)
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=runtime_oid)
    OR EXISTS (SELECT 1 FROM pg_database WHERE datdba=runtime_oid) THEN
    RAISE EXCEPTION 'Runtime must not own database objects';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND NOT tablename=ANY(known_tables))
    OR EXISTS (SELECT 1 FROM unnest(known_tables) t WHERE to_regclass(format('public.%I', t)) IS NULL) THEN
    RAISE EXCEPTION 'Public table inventory differs from the reviewed runtime grant manifest';
  END IF;
  EXECUTE format('REVOKE pg_read_all_data, pg_write_all_data FROM %I', runtime_name);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', runtime_name);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', runtime_name);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', runtime_name);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_name);
  FOREACH table_name IN ARRAY known_tables LOOP
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', table_name, runtime_name);
    IF NOT table_name=ANY(protected_tables) THEN
      EXECUTE format('GRANT INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', table_name, runtime_name);
    END IF;
  END LOOP;
  -- Version ordering is the only reviewed identity sequence. No future sequences
  -- inherit runtime access; reads cannot reset its counter.
  EXECUTE format('GRANT USAGE ON SEQUENCE public."designFileVersion_sequence_seq" TO %I', runtime_name);
  FOREACH table_name IN ARRAY protected_tables LOOP
    IF has_table_privilege(runtime_name, format('public.%I',table_name), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(runtime_name, format('public.%I',table_name), 'INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Inherited, public or column grants still allow changes to %', table_name;
    END IF;
  END LOOP;
  IF has_schema_privilege(runtime_name, 'public', 'CREATE') OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND has_table_privilege(runtime_name,c.oid,'TRUNCATE,TRIGGER,REFERENCES')
  ) THEN
    RAISE EXCEPTION 'Runtime still has schema or administrative table privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(runtime_name,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'Review callable security-definer functions before granting runtime access';
  END IF;
END
$runtime_grants$;
