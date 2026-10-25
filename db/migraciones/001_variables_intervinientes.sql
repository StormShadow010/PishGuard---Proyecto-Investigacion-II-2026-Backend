alter table sesiones
  add column if not exists capacitacion_previa text,
  add column if not exists frecuencia_uso text,
  add column if not exists autoeficacia smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sesiones_capacitacion_previa_check'
  ) then
    alter table sesiones
      add constraint sesiones_capacitacion_previa_check
      check (capacitacion_previa in ('formal', 'informal', 'no'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'sesiones_frecuencia_uso_check'
  ) then
    alter table sesiones
      add constraint sesiones_frecuencia_uso_check
      check (frecuencia_uso in ('diaria', 'varias_semana', 'semanal', 'mensual', 'nunca'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'sesiones_autoeficacia_check'
  ) then
    alter table sesiones
      add constraint sesiones_autoeficacia_check
      check (autoeficacia between 1 and 5);
  end if;
end $$;
