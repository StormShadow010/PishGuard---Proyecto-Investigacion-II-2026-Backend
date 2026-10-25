import "dotenv/config";
import { randomUUID } from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { Pool, PoolClient } from "pg";

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:4200" }));
app.use(express.json());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPCIONES = new Set(["phishing", "legitimo", "no_seguro"]);
const CAPACITACIONES = new Set(["formal", "informal", "no"]);
const FRECUENCIAS = new Set(["diaria", "varias_semana", "semanal", "mensual", "nunca"]);

function esUuid(valor: unknown): valor is string {
  return typeof valor === "string" && UUID_RE.test(valor);
}

async function enTransaccion<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const resultado = await fn(client);
    await client.query("commit");
    return resultado;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function asignarEnsayos(client: PoolClient, sesionId: string) {
  await client.query(
    `insert into ensayos (sesion_id, estimulo_id, posicion)
     select $1, id, row_number() over (
       order by case fase when 'pre' then 1 when 'intervencion' then 2 else 3 end, random())
     from estimulos`,
    [sesionId],
  );
}

// ---------- Administración ----------
function soloAdmin(req: Request, res: Response, next: NextFunction) {
  const clave = process.env.ADMIN_KEY;
  if (!clave || req.get("x-admin-key") !== clave)
    return res.status(401).json({ error: "No autorizado" });
  next();
}

const CONSULTA_RESPUESTAS = `
  select e.sesion_id, se.programa, se.semestre, se.area_tecnologica,
         se.capacitacion_previa, se.frecuencia_uso, se.autoeficacia,
         se.iniciada_en, se.finalizada_en,
         case when se.iniciada_en is not null and se.finalizada_en is not null
           then round(extract(epoch from (se.finalizada_en - se.iniciada_en)) * 1000)::int
         end as duracion_sesion_ms,
         e.posicion, s.id as estimulo_id, s.fase, s.canal, s.tipo, s.categoria,
         e.opcion, e.correcta, e.latencia_ms,
         round(extract(epoch from (e.respondido_en - e.mostrado_en)) * 1000)::int as servidor_ms,
         e.mostrado_en, e.respondido_en
  from ensayos e
  join estimulos s on s.id = e.estimulo_id
  join sesiones se on se.id = e.sesion_id
  where e.respondido_en is not null`;

app.get("/admin/respuestas", soloAdmin, async (_req, res) => {
  const resumen = await db.query(
    `select count(*)::int as sesiones,
            count(*) filter (where not exists (
              select 1 from ensayos e where e.sesion_id = s.id and e.respondido_en is null))::int as completas,
            round(
              avg(extract(epoch from (s.finalizada_en - s.iniciada_en)) * 1000)
                filter (where s.iniciada_en is not null and s.finalizada_en is not null)
            )::int as duracion_promedio_ms
     from sesiones s`,
  );
  const filas = await db.query(
    `${CONSULTA_RESPUESTAS} order by e.respondido_en desc limit 200`,
  );
  res.json({ resumen: resumen.rows[0], filas: filas.rows });
});

app.get("/admin/export.csv", soloAdmin, async (_req, res) => {
  const { rows, fields } = await db.query(
    `${CONSULTA_RESPUESTAS} order by e.sesion_id, e.posicion`,
  );
  const celda = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const texto = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  };
  const columnas = fields.map((f) => f.name);
  const csv = [
    columnas.join(","),
    ...rows.map((r) => columnas.map((c) => celda(r[c])).join(",")),
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="phishguard-respuestas.csv"',
  );
  res.send("\uFEFF" + csv);
});

// Crea la sesión y su secuencia de ensayos: pre → intervención → post, orden aleatorio dentro de cada fase
app.post("/sesiones", async (req, res) => {
  const {
    programa,
    semestre,
    areaTecnologica,
    capacitacionPrevia,
    frecuenciaUso,
    autoeficacia,
    consentimiento,
    clientSessionId,
  } = req.body;
  if (consentimiento !== true)
    return res.status(400).json({ error: "Falta el consentimiento" });
  if (clientSessionId !== undefined && !esUuid(clientSessionId))
    return res.status(400).json({ error: "clientSessionId inválido" });
  if (
    !CAPACITACIONES.has(capacitacionPrevia) ||
    !FRECUENCIAS.has(frecuenciaUso) ||
    !Number.isInteger(autoeficacia) ||
    autoeficacia < 1 ||
    autoeficacia > 5
  )
    return res.status(400).json({ error: "Datos del perfil inválidos" });

  const sesionId = clientSessionId ?? randomUUID();
  const creada = await enTransaccion(async (client) => {
    const insertada = await client.query(
      `insert into sesiones (
         id, programa, semestre, area_tecnologica,
         capacitacion_previa, frecuencia_uso, autoeficacia, consentimiento_en
       )
       values ($1,$2,$3,$4,$5,$6,$7, now())
       on conflict (id) do nothing
       returning id`,
      [
        sesionId,
        programa ?? null,
        semestre ?? null,
        areaTecnologica ?? null,
        capacitacionPrevia,
        frecuenciaUso,
        autoeficacia,
      ],
    );

    if (insertada.rowCount === 1) {
      await asignarEnsayos(client, sesionId);
      return true;
    }

    const { rows } = await client.query(
      "select count(*)::int as total from ensayos where sesion_id = $1",
      [sesionId],
    );
    if (rows[0].total === 0) await asignarEnsayos(client, sesionId);
    return false;
  });

  res.status(creada ? 201 : 200).json({ sesionId });
});

// Devuelve el siguiente ensayo sin responder (sin la respuesta correcta) y marca cuándo se mostró
app.get("/sesiones/:id/siguiente", async (req, res) => {
  if (!esUuid(req.params.id))
    return res.status(400).json({ error: "Sesión inválida" });

  const sesion = await db.query(
    `update sesiones
     set iniciada_en = coalesce(iniciada_en, now())
     where id = $1
     returning iniciada_en`,
    [req.params.id],
  );
  if (sesion.rowCount === 0)
    return res.status(404).json({ error: "Sesión no encontrada" });

  const { rows } = await db.query(
    `select e.id as "ensayoId", e.posicion,
            (select count(*)::int from ensayos where sesion_id = $1) as total,
            s.id, s.canal, s.fase, s.remitente, s.asunto, s.cuerpo, s.enlace
     from ensayos e join estimulos s on s.id = e.estimulo_id
     where e.sesion_id = $1 and e.respondido_en is null
     order by e.posicion limit 1`,
    [req.params.id],
  );
  if (rows.length === 0) {
    const cierre = await db.query(
      `update sesiones
       set finalizada_en = coalesce(finalizada_en, now())
       where id = $1
       returning round(
         extract(epoch from (finalizada_en - coalesce(iniciada_en, creada_en))) * 1000
       )::int as duracion_ms`,
      [req.params.id],
    );
    res.setHeader("Cache-Control", "no-store");
    return res.json({ fin: true, duracionMs: cierre.rows[0]?.duracion_ms ?? null });
  }

  const { ensayoId, posicion, total, ...estimulo } = rows[0];
  await db.query(
    "update ensayos set mostrado_en = coalesce(mostrado_en, now()) where id = $1",
    [ensayoId],
  );
  res.setHeader("Cache-Control", "no-store");
  res.json({
    fin: false,
    ensayoId,
    posicion,
    total,
    iniciadaEn: sesion.rows[0].iniciada_en,
    estimulo,
  });
});

// Guarda la respuesta, calcula el acierto y devuelve retroalimentación solo en la intervención
app.post("/respuestas", async (req, res) => {
  const { ensayoId, opcion, latenciaMs } = req.body;
  if (
    !esUuid(ensayoId) ||
    !OPCIONES.has(opcion) ||
    !Number.isInteger(latenciaMs) ||
    latenciaMs < 0
  ) {
    return res.status(400).json({ error: "Datos inválidos" });
  }
  const resultado = await enTransaccion(async (client) => {
    const { rows } = await client.query(
      `update ensayos e
       set opcion = $2, latencia_ms = $3, respondido_en = now(), correcta = ($2 = s.tipo)
       from estimulos s
       where e.id = $1 and s.id = e.estimulo_id and e.respondido_en is null
       returning e.correcta, e.sesion_id, s.fase, s.tipo, s.explicacion`,
      [ensayoId, opcion, latenciaMs],
    );
    if (rows.length === 0) return null;

    const { correcta, sesion_id, fase, tipo, explicacion } = rows[0];
    const sig = await client.query(
      `select s.fase from ensayos e join estimulos s on s.id = e.estimulo_id
       where e.sesion_id = $1 and e.respondido_en is null order by e.posicion limit 1`,
      [sesion_id],
    );
    const siguienteFase = sig.rows[0]?.fase ?? null;

    if (siguienteFase === null) {
      await client.query(
        `update sesiones
         set finalizada_en = coalesce(finalizada_en, now())
         where id = $1`,
        [sesion_id],
      );
    }

    return { correcta, fase, tipo, explicacion, siguienteFase };
  });

  if (!resultado)
    return res
      .status(409)
      .json({ error: "Ensayo inexistente o ya respondido" });

  const { correcta, fase, tipo, explicacion, siguienteFase } = resultado;
  res.json({
    ...(fase === "intervencion"
      ? { correcta, tipo, feedback: explicacion }
      : {}),
    cambioFase: siguienteFase && siguienteFase !== fase ? siguienteFase : null,
  });
});

app.get("/salud", async (_req, res) => {
  await db.query("select 1");
  res.json({ ok: true });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Error no controlado:", error instanceof Error ? error.message : error);
  if (res.headersSent) return;
  res.status(500).json({ error: "Error interno" });
});

app.listen(process.env.PORT ?? 3000, () => console.log("Backend listo"));
