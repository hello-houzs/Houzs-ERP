-- 0161_scm_so_concurrency_domain_closure.sql (Postgres)
-- Must run after 0158 -> 0159 -> 0160. This migration closes the remaining
-- canonical Sales Order concurrency domains: transactional header followers
-- and row-versioned payment corrections.

ALTER TABLE scm.mfg_sales_order_payments
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE scm.so_amendments
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS apply_lease_token text,
  ADD COLUMN IF NOT EXISTS apply_lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_so_amendments_apply_lease_expiry
  ON scm.so_amendments (apply_lease_expires_at)
  WHERE apply_lease_token IS NOT NULL;

-- Apply the header CAS and all version-bound followers in one database
-- transaction. jsonb_populate_record starts from the locked row, therefore
-- omitted keys retain their stored values while explicit JSON null remains an
-- intentional clear. Only service_role can call this function; browser roles
-- can never use the JSON patch to bypass the route's field allow-list.
CREATE OR REPLACE FUNCTION scm.apply_so_header_cas(
  p_doc_no text,
  p_expected_version integer,
  p_required_lease text,
  p_patch jsonb,
  p_recustomer boolean DEFAULT false,
  p_customer_name text DEFAULT NULL,
  p_customer_phone text DEFAULT NULL,
  p_customer_email text DEFAULT NULL,
  p_apply_warehouse boolean DEFAULT false,
  p_warehouse_id uuid DEFAULT NULL,
  p_apply_delivery_date boolean DEFAULT false,
  p_delivery_date date DEFAULT NULL
) RETURNS TABLE(
  applied boolean,
  current_version integer,
  resolved_customer_id uuid,
  conflict_reason text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = scm, pg_temp AS $$
DECLARE
  v_row scm.mfg_sales_orders%ROWTYPE;
  v_saved_version integer;
  v_customer_id uuid;
  v_assignments text;
  v_sql text;
  v_patched scm.mfg_sales_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM mfg_sales_orders
  WHERE doc_no = p_doc_no
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::integer, NULL::uuid, 'not_found'::text;
    RETURN;
  END IF;
  IF v_row.version <> p_expected_version THEN
    RETURN QUERY SELECT false, v_row.version, NULL::uuid, 'version'::text;
    RETURN;
  END IF;
  IF p_required_lease IS NOT NULL THEN
    IF v_row.edit_lease_token IS DISTINCT FROM p_required_lease
       OR v_row.edit_lease_expires_at IS NULL
       OR v_row.edit_lease_expires_at <= now() THEN
      RETURN QUERY SELECT false, v_row.version, NULL::uuid, 'lease'::text;
      RETURN;
    END IF;
  ELSIF v_row.edit_lease_token IS NOT NULL
        AND v_row.edit_lease_expires_at IS NOT NULL
        AND v_row.edit_lease_expires_at > now() THEN
    RETURN QUERY SELECT false, v_row.version, NULL::uuid, 'lease'::text;
    RETURN;
  END IF;

  -- Materialize the typed composite before entering dynamic SQL. Passing an
  -- UPDATE target alias directly as jsonb_populate_record's polymorphic base
  -- is not portable across supported PostgreSQL versions and can be resolved
  -- as a scalar at runtime ("cannot call populate_composite on a scalar").
  -- Starting from the locked row keeps omitted keys unchanged while preserving
  -- explicit JSON null as an intentional clear.
  v_patched := jsonb_populate_record(v_row, p_patch);

  SELECT string_agg(
    format('%1$I = ($1::scm.mfg_sales_orders).%1$I', a.attname),
    ', ' ORDER BY a.attnum
  )
  INTO v_assignments
  FROM pg_attribute a
  WHERE a.attrelid = 'scm.mfg_sales_orders'::regclass
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND a.attgenerated = ''
    AND a.attidentity = ''
    AND a.attname <> 'doc_no';

  v_sql := format(
    'UPDATE scm.mfg_sales_orders AS t '
    'SET %1$s '
    'WHERE t.doc_no = $2 AND t.version = $3 RETURNING t.version',
    v_assignments
  );
  EXECUTE v_sql INTO v_saved_version USING v_patched, p_doc_no, p_expected_version;
  IF v_saved_version IS NULL THEN
    RETURN QUERY SELECT false, v_row.version, NULL::uuid, 'version'::text;
    RETURN;
  END IF;

  IF p_recustomer
     AND NULLIF(btrim(p_customer_name), '') IS NOT NULL
     AND NULLIF(btrim(p_customer_phone), '') IS NOT NULL THEN
    v_customer_id := upsert_customer_by_name_phone(
      p_customer_name, p_customer_phone, p_customer_email
    );
    UPDATE mfg_sales_orders
    SET customer_id = v_customer_id
    WHERE doc_no = p_doc_no AND version = v_saved_version;
    UPDATE pwp_codes
    SET customer_id = v_customer_id, updated_at = now()
    WHERE source_doc_no = p_doc_no;
  END IF;

  IF p_apply_warehouse AND p_warehouse_id IS NOT NULL THEN
    UPDATE mfg_sales_order_items
    SET warehouse_id = p_warehouse_id
    WHERE doc_no = p_doc_no AND cancelled = false AND warehouse_id IS NULL;
  END IF;
  IF p_apply_delivery_date THEN
    UPDATE mfg_sales_order_items
    SET line_delivery_date = p_delivery_date,
        line_delivery_date_overridden = false
    WHERE doc_no = p_doc_no;
  END IF;

  RETURN QUERY SELECT true, v_saved_version, v_customer_id, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION scm.apply_so_header_cas(
  text, integer, text, jsonb, boolean, text, text, text, boolean, uuid, boolean, date
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.apply_so_header_cas(
  text, integer, text, jsonb, boolean, text, text, text, boolean, uuid, boolean, date
) TO service_role;

NOTIFY pgrst, 'reload schema';
