alter table sesiones
  add column if not exists iniciada_en timestamp with time zone,
  add column if not exists finalizada_en timestamp with time zone;
