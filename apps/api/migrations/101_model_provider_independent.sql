UPDATE provider_bindings
SET
  provider = regexp_replace(model_ref, '^openai_compat:([^:]+):(.+)$', '\1'),
  model = regexp_replace(model_ref, '^openai_compat:([^:]+):(.+)$', '\2'),
  model_ref = regexp_replace(model_ref, '^openai_compat:([^:]+):(.+)$', '\1:\2'),
  updated_at = now()
WHERE model_ref ~ '^openai_compat:([^:]+):(.+)$';

UPDATE routing_policies
SET
  primary_model_ref = regexp_replace(primary_model_ref, '^openai_compat:([^:]+):(.+)$', '\1:\2'),
  updated_at = now()
WHERE primary_model_ref ~ '^openai_compat:([^:]+):(.+)$';

UPDATE routing_policies
SET
  fallback_model_refs = (
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN (e.value #>> '{}') ~ '^openai_compat:([^:]+):(.+)$'
            THEN to_jsonb(regexp_replace(e.value #>> '{}', '^openai_compat:([^:]+):(.+)$', '\1:\2'))
          ELSE e.value
        END
        ORDER BY e.ord
      ),
      '[]'::jsonb
    )
    FROM jsonb_array_elements(fallback_model_refs) WITH ORDINALITY AS e(value, ord)
  ),
  updated_at = now()
WHERE fallback_model_refs::text LIKE '%openai_compat:%';

UPDATE model_usage_events
SET
  provider = regexp_replace(model_ref, '^openai_compat:([^:]+):(.+)$', '\1'),
  model_ref = regexp_replace(model_ref, '^openai_compat:([^:]+):(.+)$', '\1:\2')
WHERE model_ref ~ '^openai_compat:([^:]+):(.+)$';
