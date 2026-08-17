// --- Cliente directo a la API pública del BCRA (sin backend propio: CORS abierto) ---

const BCRA_DEUDORES_BASE = "https://api.bcra.gob.ar/CentralDeDeudores/v1.0";
const BCRA_CHEQUES_BASE = "https://api.bcra.gob.ar/cheques/v1.0";
const FETCH_TIMEOUT_MS = 10_000;
const RETRYABLE_STATUS = new Set([429, 503]);
const RETRY_DELAY_MS = 1_500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Nunca rechaza: cualquier falla de red, timeout o respuesta inesperada se traduce
// a { ok: false, error } para que una sola consulta caída no tumbe un lote entero.
async function bcraFetch(url, { _retried = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    const timedOut = err.name === "AbortError";
    return {
      ok: false,
      notFound: false,
      error: timedOut
        ? "La API del BCRA no respondió a tiempo. Probá de nuevo en un momento."
        : "No se pudo conectar con la API del BCRA (revisá tu conexión).",
    };
  }
  clearTimeout(timeout);

  if (RETRYABLE_STATUS.has(res.status) && !_retried) {
    await sleep(RETRY_DELAY_MS);
    return bcraFetch(url, { _retried: true });
  }

  const body = await res.json().catch(() => null);

  if (res.status === 404) {
    return { ok: false, notFound: true, error: body?.errorMessages?.[0] ?? "No se encontraron datos." };
  }
  if (RETRYABLE_STATUS.has(res.status)) {
    return {
      ok: false,
      notFound: false,
      error: "El BCRA está limitando las consultas en este momento. Esperá un momento y volvé a intentar.",
    };
  }
  if (!res.ok) {
    return { ok: false, notFound: false, error: body?.errorMessages?.[0] ?? `Error ${res.status} consultando la API del BCRA.` };
  }
  if (!body || typeof body !== "object") {
    return { ok: false, notFound: false, error: "La API del BCRA devolvió una respuesta inesperada." };
  }
  return { ok: true, data: body.results };
}

// https://www.bcra.gob.ar/ - algoritmo estándar de verificación de CUIT/CUIL (módulo 11)
function isValidCuit(cuit) {
  if (!/^\d{11}$/.test(cuit)) return false;
  const digits = cuit.split("").map(Number);
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0);
  const mod = sum % 11;
  const checkDigit = mod === 0 ? 0 : 11 - mod;
  if (checkDigit === 11) return digits[10] === 0;
  return checkDigit === digits[10];
}

function normalizeCuit(raw) {
  return String(raw).replace(/[^\d]/g, "");
}

function getDeudasActuales(cuit) {
  return bcraFetch(`${BCRA_DEUDORES_BASE}/Deudas/${cuit}`);
}
function getDeudasHistoricas(cuit) {
  return bcraFetch(`${BCRA_DEUDORES_BASE}/Deudas/Historicas/${cuit}`);
}
function getChequesRechazadosPersona(cuit) {
  return bcraFetch(`${BCRA_DEUDORES_BASE}/Deudas/ChequesRechazados/${cuit}`);
}

async function consultarPersona(rawCuit) {
  const cuit = normalizeCuit(rawCuit);

  if (!/^\d{11}$/.test(cuit)) {
    return { cuit: rawCuit, error: "El CUIT/CUIL debe tener 11 dígitos." };
  }
  if (!isValidCuit(cuit)) {
    return { cuit, error: "El CUIT/CUIL ingresado no es válido (dígito verificador incorrecto)." };
  }

  const [actual, historico, cheques] = await Promise.all([
    getDeudasActuales(cuit),
    getDeudasHistoricas(cuit),
    getChequesRechazadosPersona(cuit),
  ]);

  if (!actual.ok && actual.notFound && !historico.ok && !cheques.ok) {
    return { cuit, error: "No se encontraron datos para este CUIT/CUIL en la Central de Deudores." };
  }

  const denominacion = actual.data?.denominacion ?? historico.data?.denominacion ?? cheques.data?.denominacion ?? null;

  return {
    cuit,
    denominacion,
    actual: actual.ok ? actual.data : null,
    historico: historico.ok ? historico.data : null,
    cheques: cheques.ok ? cheques.data : null,
    warnings: [
      !actual.ok && !actual.notFound ? actual.error : null,
      !historico.ok && !historico.notFound ? historico.error : null,
      !cheques.ok && !cheques.notFound ? cheques.error : null,
    ].filter(Boolean),
  };
}

// Limita la concurrencia contra la API del BCRA para evitar throttling al consultar listas.
async function consultarLote(cuits, concurrency = 4) {
  const results = new Array(cuits.length);
  let next = 0;

  async function worker() {
    while (next < cuits.length) {
      const i = next++;
      try {
        results[i] = await consultarPersona(cuits[i]);
      } catch (err) {
        console.error(`Error inesperado consultando ${cuits[i]}:`, err);
        results[i] = { cuit: cuits[i], error: "Error inesperado consultando este CUIT/CUIL. Probá de nuevo." };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, cuits.length) }, worker);
  await Promise.all(workers);
  return results;
}

let entidadesChequesCache = null;

async function getEntidadesCheques() {
  if (entidadesChequesCache) return entidadesChequesCache;
  const result = await bcraFetch(`${BCRA_CHEQUES_BASE}/entidades`);
  if (!result.ok) throw new Error(result.error ?? "No se pudo obtener el listado de bancos.");
  entidadesChequesCache = result.data;
  return entidadesChequesCache;
}

function getChequeDenunciadoApi(codigoEntidad, numeroCheque) {
  return bcraFetch(`${BCRA_CHEQUES_BASE}/denunciados/${codigoEntidad}/${numeroCheque}`);
}

// --- UI ---

const SITUACION_LABELS = {
  1: { label: "Situación normal", color: "#2fa84f" },
  2: { label: "Riesgo bajo", color: "#c9a90c" },
  3: { label: "Riesgo medio", color: "#e08a1e" },
  4: { label: "Riesgo alto", color: "#e05c3f" },
  5: { label: "Irrecuperable", color: "#b3261e" },
  6: { label: "Irrecuperable (disp. técnica)", color: "#6b7280" },
};

const cuitsInput = document.getElementById("cuits");
const btnConsultar = document.getElementById("btn-consultar");
const btnExport = document.getElementById("btn-export");
const statusEl = document.getElementById("status");
const resultadosEl = document.getElementById("resultados");

let lastResultados = [];

function parseCuits(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatCuit(cuit) {
  if (!/^\d{11}$/.test(cuit)) return cuit;
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
}

function situacionBadge(situacion) {
  const info = SITUACION_LABELS[situacion] ?? { label: `Situación ${situacion}`, color: "#6b7280" };
  return `<span class="badge" style="--badge-color:${info.color}">${info.label}</span>`;
}

function formatMonto(monto) {
  if (monto === undefined || monto === null) return "-";
  return `$${(monto * 1000).toLocaleString("es-AR")}`;
}

function formatPesos(valor) {
  return `$${valor.toLocaleString("es-AR", { maximumFractionDigits: 2 })}`;
}

const RISK_LEVELS = [
  { nivel: 0, label: "Bajo riesgo", color: "#2fa84f" },
  { nivel: 1, label: "Riesgo moderado", color: "#c9a90c" },
  { nivel: 2, label: "Riesgo alto", color: "#e08a1e" },
  { nivel: 3, label: "Riesgo crítico", color: "#b3261e" },
];

// Estimación propia (no es un score oficial de BCRA ni de ninguna entidad) a partir de la
// peor situación declarada, cheques rechazados y procesos judiciales/en revisión.
function calcularScore(persona) {
  if (persona.error) return null;

  const entidadesActuales = (persona.actual?.periodos ?? []).flatMap((p) => p.entidades ?? []);
  const tieneChequesRechazados = (persona.cheques?.causales ?? []).length > 0;

  if (entidadesActuales.length === 0) {
    return { ...RISK_LEVELS[tieneChequesRechazados ? 2 : 0], peorSituacion: null, tieneChequesRechazados };
  }

  const peorSituacion = Math.max(...entidadesActuales.map((e) => e.situacion));
  const enRevisionOJudicial = entidadesActuales.some((e) => e.enRevision || e.procesoJud);

  let nivel;
  if (peorSituacion <= 1) nivel = 0;
  else if (peorSituacion === 2) nivel = 1;
  else if (peorSituacion === 3) nivel = 2;
  else nivel = 3;

  if (tieneChequesRechazados) nivel = Math.max(nivel, 2);
  if (enRevisionOJudicial) nivel = Math.max(nivel, 1);

  return { ...RISK_LEVELS[nivel], peorSituacion, tieneChequesRechazados };
}

function scoreBadge(score) {
  if (!score) return "";
  return `<span class="badge score-badge" style="--badge-color:${score.color}" title="Estimación propia a partir de datos públicos del BCRA — no es un score oficial">${score.label}</span>`;
}

// Formato compacto para las etiquetas del gráfico ($2,3 M en vez de $2.300.000).
function formatMontoCompacto(valor) {
  const signo = valor < 0 ? "-" : "";
  const abs = Math.abs(valor);
  const n = (v) => v.toLocaleString("es-AR", { maximumFractionDigits: 1 });
  if (abs >= 1e12) return `${signo}$${n(abs / 1e12)} bill.`;
  if (abs >= 1e9) return `${signo}$${n(abs / 1e9)} mil M`;
  if (abs >= 1e6) return `${signo}$${n(abs / 1e6)} M`;
  if (abs >= 1e3) return `${signo}$${n(abs / 1e3)} mil`;
  return `${signo}$${n(abs)}`;
}

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function formatPeriodo(periodo) {
  const s = String(periodo);
  if (!/^\d{6}$/.test(s)) return s;
  const year = s.slice(0, 4);
  const month = Number(s.slice(4, 6));
  return `${MESES[month - 1] ?? month} ${year}`;
}

const CHART_PALETTE = ["#0071e3", "#34c759", "#ff9500", "#af52de", "#ff3b30", "#5ac8fa", "#ffcc00", "#8e8e93"];
const MAX_ENTIDADES_CHART = 6;

// Combina Deudas actuales + Deudas/Historicas en una serie cronológica de monto por entidad,
// agrupando las entidades menos relevantes bajo "Otras entidades" para que el gráfico sea legible.
function buildEntidadSeries(persona) {
  const periodosMap = new Map();

  for (const p of [...(persona.historico?.periodos ?? []), ...(persona.actual?.periodos ?? [])]) {
    if (!periodosMap.has(p.periodo)) periodosMap.set(p.periodo, new Map());
    const entidadMap = periodosMap.get(p.periodo);
    for (const e of p.entidades ?? []) {
      entidadMap.set(e.entidad, (entidadMap.get(e.entidad) ?? 0) + (e.monto ?? 0));
    }
  }

  const periodos = [...periodosMap.keys()].sort((a, b) => a.localeCompare(b));
  if (periodos.length < 2) return null;

  const totalPorEntidad = new Map();
  for (const entidadMap of periodosMap.values()) {
    for (const [entidad, monto] of entidadMap) {
      totalPorEntidad.set(entidad, (totalPorEntidad.get(entidad) ?? 0) + monto);
    }
  }

  const entidadesOrdenadas = [...totalPorEntidad.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
  const principales = entidadesOrdenadas.slice(0, MAX_ENTIDADES_CHART);
  const hayOtras = entidadesOrdenadas.length > MAX_ENTIDADES_CHART;

  const series = principales.map((entidad) => ({
    entidad,
    valores: periodos.map((periodo) => (periodosMap.get(periodo).get(entidad) ?? 0) * 1000),
  }));

  if (hayOtras) {
    const otras = entidadesOrdenadas.slice(MAX_ENTIDADES_CHART);
    series.push({
      entidad: "Otras entidades",
      valores: periodos.map(
        (periodo) => otras.reduce((acc, e) => acc + (periodosMap.get(periodo).get(e) ?? 0), 0) * 1000
      ),
    });
  }

  return { periodos, series };
}

function renderPeriodosTable(periodos, { compact = false } = {}) {
  if (!periodos || periodos.length === 0) {
    return `<p class="empty-note">Sin registros.</p>`;
  }
  const rows = periodos
    .map((p) =>
      (p.entidades ?? [])
        .map(
          (e) => `
        <tr>
          <td>${p.periodo}</td>
          <td>${e.entidad}</td>
          <td>${situacionBadge(e.situacion)}</td>
          <td>${formatMonto(e.monto)}</td>
          ${compact ? "" : `<td>${e.diasAtrasoPago ?? "-"}</td>`}
        </tr>`
        )
        .join("")
    )
    .join("");

  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Período</th>
            <th>Entidad</th>
            <th>Situación</th>
            <th>Monto adeudado</th>
            ${compact ? "" : "<th>Días atraso</th>"}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderCheques(chequesData) {
  const causales = chequesData?.causales ?? [];
  if (causales.length === 0) {
    return `<p class="empty-note">Sin cheques rechazados registrados.</p>`;
  }
  const rows = causales.flatMap((c) =>
    (c.entidades ?? []).flatMap((e) =>
      (e.detalle ?? []).map(
        (d) => `
        <tr>
          <td>${c.causal}</td>
          <td>Entidad ${e.entidad}</td>
          <td>${d.nroCheque ?? "-"}</td>
          <td>${d.fechaRechazo ?? "-"}</td>
          <td>${formatMonto(d.monto)}</td>
          <td>${d.fechaPago ? "Pagado" : "Impago"}</td>
        </tr>`
      )
    )
  );

  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Causal</th><th>Entidad</th><th>Nº cheque</th><th>Fecha rechazo</th><th>Monto</th><th>Estado</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>`;
}

function renderPersona(persona) {
  const card = document.createElement("div");
  card.className = "persona-card";

  if (persona.error) {
    card.innerHTML = `
      <h2>${formatCuit(persona.cuit)}</h2>
      <p class="error-msg">${persona.error}</p>`;
    return card;
  }

  const warnings = (persona.warnings ?? [])
    .map((w) => `<div class="warning-msg">⚠ ${w}</div>`)
    .join("");

  const entidadSeries = buildEntidadSeries(persona);
  const canvasId = `chart-${persona.cuit}`;
  const score = calcularScore(persona);

  card.innerHTML = `
    <div class="persona-card-header">
      <div>
        <h2>${persona.denominacion ?? "Sin denominación"}</h2>
        <div class="cuit">${formatCuit(persona.cuit)}</div>
      </div>
      ${scoreBadge(score)}
    </div>
    ${warnings}

    <h3 class="section-title">Evolución de la deuda por entidad</h3>
    ${entidadSeries
      ? `<div class="chart-wrap"><canvas id="${canvasId}"></canvas></div>`
      : `<p class="empty-note">No hay suficientes períodos para graficar.</p>`}

    <h3 class="section-title">Situación actual</h3>
    ${renderPeriodosTable(persona.actual?.periodos)}

    <details>
      <summary>Ver histórico (últimos 24 meses)</summary>
      ${renderPeriodosTable(persona.historico?.periodos, { compact: true })}
    </details>

    <h3 class="section-title">Cheques rechazados</h3>
    ${renderCheques(persona.cheques)}
  `;

  card.dataset.entidadSeries = entidadSeries ? JSON.stringify(entidadSeries) : "";
  card.dataset.canvasId = canvasId;

  return card;
}

function computeKPIs(resultados) {
  const validos = resultados.filter((p) => !p.error);
  let montoTotal = 0;
  let conDeuda = 0;
  let conChequesRechazados = 0;
  const porNivel = [0, 0, 0, 0];

  for (const persona of validos) {
    const entidades = (persona.actual?.periodos ?? []).flatMap((p) => p.entidades ?? []);
    if (entidades.length > 0) {
      conDeuda++;
      montoTotal += entidades.reduce((acc, e) => acc + (e.monto ?? 0), 0);
    }
    if ((persona.cheques?.causales ?? []).length > 0) conChequesRechazados++;

    const score = calcularScore(persona);
    if (score) porNivel[score.nivel]++;
  }

  return {
    total: resultados.length,
    errores: resultados.length - validos.length,
    conDeuda,
    montoTotal: montoTotal * 1000,
    conChequesRechazados,
    porNivel,
  };
}

const kpiBarEl = document.getElementById("kpi-bar");

function renderKPIs(kpis) {
  if (kpis.total === 0) {
    kpiBarEl.innerHTML = "";
    return;
  }

  const distribucion = RISK_LEVELS.map(
    (r) => `
      <div class="kpi-riesgo-item">
        <span class="kpi-dot" style="background:${r.color}"></span>
        ${kpis.porNivel[r.nivel]} · ${r.label}
      </div>`
  ).join("");

  kpiBarEl.innerHTML = `
    <div class="persona-card">
      <h3 class="section-title">Resumen de cartera</h3>
      <div class="kpi-grid">
        <div class="kpi-tile">
          <div class="kpi-value">${kpis.total}</div>
          <div class="kpi-label">Consultados${kpis.errores > 0 ? ` (${kpis.errores} con error)` : ""}</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-value">${kpis.conDeuda}</div>
          <div class="kpi-label">Con deuda activa</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-value">${formatMontoCompacto(kpis.montoTotal)}</div>
          <div class="kpi-label">Monto total de cartera</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-value">${kpis.conChequesRechazados}</div>
          <div class="kpi-label">Con cheques rechazados</div>
        </div>
      </div>
      <div class="kpi-riesgo-row">${distribucion}</div>
    </div>`;
}

let activeCharts = [];

function renderCharts() {
  activeCharts.forEach((c) => c.destroy());
  activeCharts = [];

  document.querySelectorAll(".persona-card[data-entidad-series]").forEach((card) => {
    const raw = card.dataset.entidadSeries;
    if (!raw) return;
    const { periodos, series } = JSON.parse(raw);
    const canvas = document.getElementById(card.dataset.canvasId);
    if (!canvas) return;

    const chart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: periodos.map(formatPeriodo),
        datasets: series.map((s, i) => ({
          label: s.entidad.length > 28 ? `${s.entidad.slice(0, 27)}…` : s.entidad,
          fullLabel: s.entidad,
          data: s.valores,
          backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length],
          borderRadius: 3,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 14 },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.fullLabel ?? ctx.dataset.label}: $${ctx.parsed.y.toLocaleString("es-AR")}`,
              footer: (items) => {
                const total = items.reduce((acc, it) => acc + it.parsed.y, 0);
                return `Total: $${total.toLocaleString("es-AR")}`;
              },
            },
          },
        },
        scales: {
          x: { stacked: true },
          y: {
            stacked: true,
            ticks: { callback: (v) => formatMontoCompacto(Number(v)) },
          },
        },
      },
    });
    activeCharts.push(chart);
  });
}

// --- Filtros / segmentación sobre los resultados ya consultados (sin volver a pegarle a la API) ---

const filtrosBarEl = document.getElementById("filtros-bar");
const filtroTextoEl = document.getElementById("filtro-texto");
const filtroNivelEl = document.getElementById("filtro-nivel");
const filtrosStatusEl = document.getElementById("filtros-status");

function getFilteredResultados() {
  const texto = filtroTextoEl.value.trim().toLowerCase();
  const nivel = filtroNivelEl.value;

  return lastResultados.filter((persona) => {
    if (texto) {
      const matchTexto =
        (persona.denominacion ?? "").toLowerCase().includes(texto) || persona.cuit.includes(texto);
      if (!matchTexto) return false;
    }
    if (nivel !== "") {
      const score = calcularScore(persona);
      if (!score || String(score.nivel) !== nivel) return false;
    }
    return true;
  });
}

function renderResultadosList() {
  const filtrados = getFilteredResultados();
  resultadosEl.innerHTML = "";
  filtrados.forEach((persona) => resultadosEl.appendChild(renderPersona(persona)));
  renderCharts();
  filtrosStatusEl.textContent =
    filtrados.length !== lastResultados.length ? `Mostrando ${filtrados.length} de ${lastResultados.length}` : "";
}

filtroTextoEl.addEventListener("input", renderResultadosList);
filtroNivelEl.addEventListener("change", renderResultadosList);

let consultaRequestId = 0;

async function consultar() {
  const cuits = parseCuits(cuitsInput.value);
  if (cuits.length === 0) {
    statusEl.textContent = "Ingresá al menos un CUIT/CUIL.";
    return;
  }
  if (cuits.length > 50) {
    statusEl.textContent = "Máximo 50 identificaciones por consulta.";
    return;
  }

  const requestId = ++consultaRequestId;

  btnConsultar.disabled = true;
  btnExport.disabled = true;
  statusEl.textContent = `Consultando ${cuits.length} identificación(es)...`;
  resultadosEl.innerHTML = "";

  try {
    const resultados = await consultarLote(cuits);
    if (requestId !== consultaRequestId) return; // llegó una respuesta vieja, ya hay una búsqueda más nueva en curso

    lastResultados = resultados;
    filtroTextoEl.value = "";
    filtroNivelEl.value = "";
    filtrosBarEl.hidden = lastResultados.length === 0;
    renderKPIs(computeKPIs(lastResultados));
    renderResultadosList();
    statusEl.textContent = `Listo — ${lastResultados.length} consultado(s).`;
    btnExport.disabled = false;
  } catch (err) {
    if (requestId !== consultaRequestId) return;
    statusEl.textContent = "Ocurrió un error inesperado. Probá de nuevo.";
    console.error(err);
  } finally {
    if (requestId === consultaRequestId) btnConsultar.disabled = false;
  }
}

function exportCsv() {
  const rows = [["CUIT", "Denominación", "Período", "Entidad", "Situación", "Monto adeudado"]];

  for (const persona of lastResultados) {
    if (persona.error) {
      rows.push([persona.cuit, "ERROR", "", "", "", persona.error]);
      continue;
    }
    const periodos = persona.actual?.periodos ?? [];
    if (periodos.length === 0) {
      rows.push([persona.cuit, persona.denominacion ?? "", "", "", "", ""]);
    }
    for (const p of periodos) {
      for (const e of p.entidades ?? []) {
        rows.push([
          persona.cuit,
          persona.denominacion ?? "",
          p.periodo,
          e.entidad,
          SITUACION_LABELS[e.situacion]?.label ?? e.situacion,
          e.monto,
        ]);
      }
    }
  }

  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `deudores-bcra-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

btnConsultar.addEventListener("click", consultar);
btnExport.addEventListener("click", exportCsv);
cuitsInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.metaKey) consultar();
});

// --- Simulador de descuento de cheque / pagaré / factura ---

const simMontoEl = document.getElementById("sim-monto");
const simPlazoEl = document.getElementById("sim-plazo");
const simTasaEl = document.getElementById("sim-tasa");
const btnSimular = document.getElementById("btn-simular");
const simuladorResultadoEl = document.getElementById("simulador-resultado");

// Descuento comercial (interés simple sobre el valor nominal) — es el cálculo habitual
// para descontar cheques/pagarés/facturas a plazo. No es asesoramiento financiero.
function simular() {
  const monto = Number(simMontoEl.value);
  const plazo = Number(simPlazoEl.value);
  const tasaAnual = Number(simTasaEl.value);

  if (!(monto > 0) || !(plazo > 0) || !(tasaAnual >= 0)) {
    simuladorResultadoEl.innerHTML = `<p class="error-msg">Completá monto, plazo y tasa con valores válidos.</p>`;
    return;
  }

  const descuento = monto * (tasaAnual / 100 / 365) * plazo;
  const valorActual = monto - descuento;
  const costoEfectivoPeriodo = (descuento / valorActual) * 100;

  simuladorResultadoEl.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-tile">
        <div class="kpi-value">${formatPesos(valorActual)}</div>
        <div class="kpi-label">Recibirías hoy</div>
      </div>
      <div class="kpi-tile">
        <div class="kpi-value">${formatPesos(descuento)}</div>
        <div class="kpi-label">Costo del descuento</div>
      </div>
      <div class="kpi-tile">
        <div class="kpi-value">${costoEfectivoPeriodo.toLocaleString("es-AR", { maximumFractionDigits: 2 })}%</div>
        <div class="kpi-label">Costo efectivo del período</div>
      </div>
    </div>
    <p class="empty-note">Descuento comercial con interés simple sobre el valor nominal. Es una estimación orientativa: no incluye comisiones ni IVA, y no reemplaza la tasa real que ofrecería una entidad.</p>`;
}

btnSimular.addEventListener("click", simular);

// --- Búsqueda de cheque denunciado (por banco + número) ---

const chequeEntidadEl = document.getElementById("cheque-entidad");
const chequeNumeroEl = document.getElementById("cheque-numero");
const btnBuscarCheque = document.getElementById("btn-buscar-cheque");
const chequeResultadoEl = document.getElementById("cheque-resultado");

async function cargarEntidades() {
  try {
    const entidades = await getEntidadesCheques();
    const ordenadas = [...entidades].sort((a, b) => a.denominacion.localeCompare(b.denominacion));
    chequeEntidadEl.innerHTML =
      `<option value="">Seleccioná un banco</option>` +
      ordenadas.map((e) => `<option value="${e.codigoEntidad}">${e.denominacion}</option>`).join("");
  } catch (err) {
    chequeEntidadEl.innerHTML = `<option value="">No se pudo cargar el listado de bancos</option>`;
    console.error(err);
  }
}

let chequeRequestId = 0;

async function buscarCheque() {
  const codigoEntidad = chequeEntidadEl.value;
  const numeroCheque = chequeNumeroEl.value.trim();
  const requestId = ++chequeRequestId; // invalida cualquier búsqueda anterior todavía en vuelo

  if (!codigoEntidad) {
    chequeResultadoEl.innerHTML = `<p class="error-msg">Elegí un banco.</p>`;
    return;
  }
  if (!/^\d+$/.test(numeroCheque)) {
    chequeResultadoEl.innerHTML = `<p class="error-msg">Ingresá un número de cheque válido.</p>`;
    return;
  }

  btnBuscarCheque.disabled = true;
  chequeResultadoEl.innerHTML = `<p class="empty-note">Consultando...</p>`;

  try {
    const result = await getChequeDenunciadoApi(codigoEntidad, numeroCheque);
    if (requestId !== chequeRequestId) return; // ya hay una búsqueda más nueva; no pisar su resultado

    if (!result.ok) {
      chequeResultadoEl.innerHTML = `<p class="error-msg">${result.error ?? "No se encontró información para ese cheque."}</p>`;
      return;
    }

    const c = result.data;
    const denunciado = Boolean(c.denunciado);
    const detalles = (c.detalles ?? [])
      .map((d) => `<li>Sucursal ${d.sucursal} · Cuenta ${d.numeroCuenta} · ${d.causal}</li>`)
      .join("");

    chequeResultadoEl.innerHTML = `
      <div class="cheque-result-box ${denunciado ? "denunciado" : "no-denunciado"}">
        <div class="cheque-status">${denunciado ? "⚠ Cheque denunciado" : "✓ Sin denuncias registradas"}</div>
        <div>Cheque Nº ${c.numeroCheque} — ${c.denominacionEntidad}</div>
        <div class="cuit">Procesado: ${c.fechaProcesamiento ?? "-"}</div>
        ${detalles ? `<ul>${detalles}</ul>` : ""}
      </div>`;
  } catch (err) {
    if (requestId !== chequeRequestId) return;
    chequeResultadoEl.innerHTML = `<p class="error-msg">Ocurrió un error inesperado. Probá de nuevo.</p>`;
    console.error(err);
  } finally {
    if (requestId === chequeRequestId) btnBuscarCheque.disabled = false;
  }
}

btnBuscarCheque.addEventListener("click", buscarCheque);

// --- Vista de impresión: expande el histórico colapsado para que salga completo en el PDF ---

let detailsAbiertosAntesDeImprimir = [];

window.addEventListener("beforeprint", () => {
  const detalles = [...document.querySelectorAll("details")];
  detailsAbiertosAntesDeImprimir = detalles.map((d) => d.open);
  detalles.forEach((d) => (d.open = true));
});

window.addEventListener("afterprint", () => {
  [...document.querySelectorAll("details")].forEach((d, i) => {
    d.open = detailsAbiertosAntesDeImprimir[i] ?? false;
  });
});

cargarEntidades();
