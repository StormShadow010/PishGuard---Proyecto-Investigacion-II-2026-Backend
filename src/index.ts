import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { Pool } from "pg";

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:4200" }));
app.use(express.json());

// ---------- Administración ----------
function soloAdmin(req: Request, res: Response, next: NextFunction) {
  const clave = process.env.ADMIN_KEY;
  if (!clave || req.get("x-admin-key") !== clave)
    return res.status(401).json({ error: "No autorizado" });
  next();
}

const CONSULTA_RESPUESTAS = `
  select e.sesion_id, se.programa, se.semestre, se.area_tecnologica,
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
              select 1 from ensayos e where e.sesion_id = s.id and e.respondido_en is null))::int as completas
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
  const { programa, semestre, areaTecnologica, consentimiento } = req.body;
  if (consentimiento !== true)
    return res.status(400).json({ error: "Falta el consentimiento" });

  const { rows } = await db.query(
    `insert into sesiones (programa, semestre, area_tecnologica, consentimiento_en)
     values ($1,$2,$3, now()) returning id`,
    [programa ?? null, semestre ?? null, areaTecnologica ?? null],
  );
  const sesionId = rows[0].id;
  await db.query(
    `insert into ensayos (sesion_id, estimulo_id, posicion)
     select $1, id, row_number() over (
       order by case fase when 'pre' then 1 when 'intervencion' then 2 else 3 end, random())
     from estimulos`,
    [sesionId],
  );
  res.status(201).json({ sesionId });
});

// Devuelve el siguiente ensayo sin responder (sin la respuesta correcta) y marca cuándo se mostró
app.get("/sesiones/:id/siguiente", async (req, res) => {
  const { rows } = await db.query(
    `select e.id as "ensayoId", e.posicion,
            (select count(*)::int from ensayos where sesion_id = $1) as total,
            s.id, s.canal, s.fase, s.remitente, s.asunto, s.cuerpo, s.enlace
     from ensayos e join estimulos s on s.id = e.estimulo_id
     where e.sesion_id = $1 and e.respondido_en is null
     order by e.posicion limit 1`,
    [req.params.id],
  );
  if (rows.length === 0) return res.json({ fin: true });

  const { ensayoId, posicion, total, ...estimulo } = rows[0];
  await db.query(
    "update ensayos set mostrado_en = coalesce(mostrado_en, now()) where id = $1",
    [ensayoId],
  );
  res.json({ fin: false, ensayoId, posicion, total, estimulo });
});

// Guarda la respuesta, calcula el acierto y devuelve retroalimentación solo en la intervención
app.post("/respuestas", async (req, res) => {
  const { ensayoId, opcion, latenciaMs } = req.body;
  if (
    !["phishing", "legitimo", "no_seguro"].includes(opcion) ||
    !Number.isInteger(latenciaMs)
  ) {
    return res.status(400).json({ error: "Datos inválidos" });
  }
  const { rows } = await db.query(
    `update ensayos e
     set opcion = $2, latencia_ms = $3, respondido_en = now(), correcta = ($2 = s.tipo)
     from estimulos s
     where e.id = $1 and s.id = e.estimulo_id and e.respondido_en is null
     returning e.correcta, e.sesion_id, s.fase, s.tipo, s.explicacion`,
    [ensayoId, opcion, latenciaMs],
  );
  if (rows.length === 0)
    return res
      .status(409)
      .json({ error: "Ensayo inexistente o ya respondido" });

  const { correcta, sesion_id, fase, tipo, explicacion } = rows[0];
  const sig = await db.query(
    `select s.fase from ensayos e join estimulos s on s.id = e.estimulo_id
     where e.sesion_id = $1 and e.respondido_en is null order by e.posicion limit 1`,
    [sesion_id],
  );
  const siguienteFase = sig.rows[0]?.fase ?? null;

  res.json({
    ...(fase === "intervencion"
      ? { correcta, tipo, feedback: explicacion }
      : {}),
    cambioFase: siguienteFase && siguienteFase !== fase ? siguienteFase : null,
  });
});

app.listen(process.env.PORT ?? 3000, () => console.log("Backend listo"));
