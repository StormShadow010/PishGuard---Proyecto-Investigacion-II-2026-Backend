import { randomUUID } from "node:crypto";
import http from "node:http";
import { Pool } from "pg";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3100";
const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  console.error("Define TEST_DATABASE_URL para usar una base de pruebas.");
  process.exit(1);
}

const db = new Pool({ connectionString });
let sesionId = null;

function verificar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje);
  console.log(`[ok] ${mensaje}`);
}

async function llamar(metodo, ruta, cuerpo) {
  const respuesta = await fetch(`${baseUrl}${ruta}`, {
    method: metodo,
    headers: cuerpo ? { "content-type": "application/json" } : undefined,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });

  let datos = null;
  try {
    datos = await respuesta.json();
  } catch {
    datos = null;
  }

  return { estado: respuesta.status, datos };
}

function enviarYAbortar(ruta, cuerpo) {
  return new Promise((resolver) => {
    const url = new URL(baseUrl);
    const payload = JSON.stringify(cuerpo);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: ruta,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (respuesta) => {
        respuesta.resume();
        respuesta.on("end", resolver);
      },
    );

    req.on("error", resolver);
    req.write(payload);
    req.end();
    setTimeout(() => {
      req.destroy();
      resolver();
    }, 50);
  });
}

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

try {
  const clientSessionId = randomUUID();
  const datosSesion = {
    programa: "Prueba de resiliencia",
    semestre: 1,
    areaTecnologica: true,
    capacitacionPrevia: "formal",
    frecuenciaUso: "diaria",
    autoeficacia: 4,
    consentimiento: true,
    clientSessionId,
  };

  const perfilInvalido = await llamar("POST", "/sesiones", {
    ...datosSesion,
    clientSessionId: randomUUID(),
    capacitacionPrevia: "ninguna",
  });
  verificar(
    perfilInvalido.estado === 400,
    "rechaza una capacitación previa fuera del catálogo",
  );

  const autoeficaciaInvalida = await llamar("POST", "/sesiones", {
    ...datosSesion,
    clientSessionId: randomUUID(),
    autoeficacia: 6,
  });
  verificar(
    autoeficaciaInvalida.estado === 400,
    "rechaza una autoeficacia fuera del rango 1 a 5",
  );

  const [primera, reintento] = await Promise.all([
    llamar("POST", "/sesiones", datosSesion),
    llamar("POST", "/sesiones", datosSesion),
  ]);

  verificar(
    [200, 201].includes(primera.estado) && [200, 201].includes(reintento.estado),
    "la creación repetida responde sin error",
  );
  verificar(
    primera.datos?.sesionId === clientSessionId && reintento.datos?.sesionId === clientSessionId,
    "el reintento recupera exactamente el mismo identificador de sesión",
  );

  sesionId = clientSessionId;

  const sesiones = await db.query("select count(*)::int as total from sesiones where id = $1", [
    sesionId,
  ]);
  verificar(sesiones.rows[0].total === 1, "no se duplicó la sesión");

  const perfil = await db.query(
    `select capacitacion_previa, frecuencia_uso, autoeficacia
       from sesiones where id = $1`,
    [sesionId],
  );
  verificar(
    perfil.rows[0]?.capacitacion_previa === "formal" &&
      perfil.rows[0]?.frecuencia_uso === "diaria" &&
      perfil.rows[0]?.autoeficacia === 4,
    "las variables intervinientes quedan en la misma fila de la sesión",
  );

  const asignacion = await db.query(
    "select estimulo_id, posicion from ensayos where sesion_id = $1 order by posicion",
    [sesionId],
  );
  const totalEstimulos = await db.query("select count(*)::int as total from estimulos");
  verificar(
    asignacion.rowCount === totalEstimulos.rows[0].total,
    "la lista aleatoria se asignó una sola vez",
  );

  const primero = await llamar("GET", `/sesiones/${sesionId}/siguiente`);
  verificar(
    primero.estado === 200 &&
      primero.datos?.estimulo?.id === asignacion.rows[0].estimulo_id,
    "la primera recarga devuelve el primer estímulo de la lista original",
  );
  verificar(
    typeof primero.datos?.iniciadaEn === "string",
    "el primer ensayo registra el inicio de la sesión",
  );

  const recarga = await llamar("GET", `/sesiones/${sesionId}/siguiente`);
  verificar(
    recarga.datos?.ensayoId === primero.datos?.ensayoId,
    "recargar antes de responder mantiene el mismo ensayo",
  );

  const respuesta = await llamar("POST", "/respuestas", {
    ensayoId: primero.datos.ensayoId,
    opcion: "phishing",
    latenciaMs: 100,
  });
  verificar(respuesta.estado === 200, "la primera respuesta se guarda correctamente");

  const duplicada = await llamar("POST", "/respuestas", {
    ensayoId: primero.datos.ensayoId,
    opcion: "legitimo",
    latenciaMs: 150,
  });
  verificar(duplicada.estado === 409, "responder dos veces el mismo ensayo devuelve HTTP 409");

  const segundo = await llamar("GET", `/sesiones/${sesionId}/siguiente`);
  verificar(
    segundo.datos?.estimulo?.id === asignacion.rows[1].estimulo_id,
    "tras responder, continúa el segundo estímulo de la lista original",
  );

  await enviarYAbortar("/respuestas", {
    ensayoId: segundo.datos.ensayoId,
    opcion: "legitimo",
    latenciaMs: 120,
  });
  await esperar(1000);

  const reintentoRespuesta = await llamar("POST", "/respuestas", {
    ensayoId: segundo.datos.ensayoId,
    opcion: "legitimo",
    latenciaMs: 120,
  });
  verificar(
    [200, 409].includes(reintentoRespuesta.estado),
    "un reintento tras perder la conexión no genera un registro nuevo",
  );

  if (reintentoRespuesta.estado === 200) {
    const segundaDuplicada = await llamar("POST", "/respuestas", {
      ensayoId: segundo.datos.ensayoId,
      opcion: "legitimo",
      latenciaMs: 120,
    });
    verificar(
      segundaDuplicada.estado === 409,
      "el ensayo recuperado también queda bloqueado ante una segunda respuesta",
    );
  }

  const tercero = await llamar("GET", `/sesiones/${sesionId}/siguiente`);
  verificar(
    tercero.datos?.estimulo?.id === asignacion.rows[2].estimulo_id,
    "la sesión continúa en el punto correcto después del corte de red",
  );

  const [concurrenteA, concurrenteB] = await Promise.all([
    llamar("POST", "/respuestas", {
      ensayoId: tercero.datos.ensayoId,
      opcion: "no_seguro",
      latenciaMs: 130,
    }),
    llamar("POST", "/respuestas", {
      ensayoId: tercero.datos.ensayoId,
      opcion: "phishing",
      latenciaMs: 140,
    }),
  ]);

  verificar(
    [concurrenteA.estado, concurrenteB.estado].sort().join(",") === "200,409",
    "dos respuestas simultáneas guardan una sola y bloquean la otra con HTTP 409",
  );

  const cuarto = await llamar("GET", `/sesiones/${sesionId}/siguiente`);
  verificar(
    cuarto.datos?.estimulo?.id === asignacion.rows[3].estimulo_id,
    "la secuencia avanza una sola posición tras respuestas simultáneas",
  );

  const asignacionFinal = await db.query(
    "select estimulo_id, posicion from ensayos where sesion_id = $1 order by posicion",
    [sesionId],
  );
  verificar(
    JSON.stringify(asignacionFinal.rows) === JSON.stringify(asignacion.rows),
    "la lista aleatoria permanece idéntica después de recargas y fallos",
  );

  const respondidos = await db.query(
    "select count(*)::int as total from ensayos where sesion_id = $1 and respondido_en is not null",
    [sesionId],
  );
  verificar(respondidos.rows[0].total === 3, "no se duplicaron las respuestas guardadas");

  let cierre = null;
  for (let intento = 0; intento < totalEstimulos.rows[0].total; intento++) {
    const siguiente = await llamar("GET", `/sesiones/${sesionId}/siguiente`);
    if (siguiente.datos?.fin) {
      cierre = siguiente;
      break;
    }
    const guardada = await llamar("POST", "/respuestas", {
      ensayoId: siguiente.datos.ensayoId,
      opcion: "legitimo",
      latenciaMs: 100,
    });
    if (guardada.estado !== 200)
      throw new Error("No se pudo completar la sesión para medir la duración");
  }

  verificar(cierre?.datos?.fin === true, "la sesión llega al final del recorrido");
  verificar(
    Number.isInteger(cierre.datos.duracionMs) && cierre.datos.duracionMs >= 0,
    "la sesión terminada devuelve la duración total",
  );

  const tiempos = await db.query(
    `select iniciada_en, finalizada_en,
            round(extract(epoch from (finalizada_en - iniciada_en)) * 1000)::int as duracion_ms
     from sesiones where id = $1`,
    [sesionId],
  );
  verificar(
    tiempos.rows[0]?.iniciada_en instanceof Date &&
      tiempos.rows[0]?.finalizada_en instanceof Date &&
      tiempos.rows[0]?.duracion_ms >= 0,
    "la base guarda inicio, fin y duración de la sesión",
  );

  const admin = await fetch(`${baseUrl}/admin/respuestas`, {
    headers: { "x-admin-key": process.env.ADMIN_KEY ?? "" },
  });
  const adminDatos = await admin.json();
  const filaSesion = adminDatos.filas?.find((fila) => fila.sesion_id === sesionId);
  verificar(
    admin.status === 200 &&
      Number.isInteger(adminDatos.resumen?.duracion_promedio_ms) &&
      typeof filaSesion?.duracion_sesion_ms === "number",
    "el resumen administrativo devuelve la duración promedio y por sesión",
  );

  const inexistente = await llamar("GET", `/sesiones/${randomUUID()}/siguiente`);
  verificar(inexistente.estado === 404, "una sesión inexistente devuelve HTTP 404");

  const salud = await llamar("GET", "/salud");
  verificar(salud.estado === 200 && salud.datos?.ok === true, "el endpoint de salud responde");

  const exportacion = await fetch(`${baseUrl}/admin/export.csv`, {
    headers: { "x-admin-key": process.env.ADMIN_KEY ?? "" },
  });
  const csv = await exportacion.text();
  verificar(
    exportacion.status === 200 &&
      csv.includes("capacitacion_previa") &&
      csv.includes("frecuencia_uso") &&
      csv.includes("autoeficacia") &&
      csv.includes("duracion_sesion_ms"),
    "la exportación CSV incluye las variables y la duración de la sesión",
  );

  console.log("[ok] prueba de resiliencia completada");
} finally {
  if (sesionId) {
    await db.query("delete from ensayos where sesion_id = $1", [sesionId]);
    await db.query("delete from sesiones where id = $1", [sesionId]);
    console.log("[ok] datos de prueba eliminados");
  }
  await db.end();
}
