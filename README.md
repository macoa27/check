# Chequeador de Deudores — BCRA

Herramienta web gratuita, sin registro y sin backend propio para consultar el estado de deudores (personas físicas y jurídicas) en Argentina, usando exclusivamente las APIs públicas del BCRA.

**[Ver demo en vivo](#)** _(reemplazar por la URL de GitHub Pages una vez publicado)_

## Qué hace

- Búsqueda de uno o varios CUIT/CUIL a la vez, con situación crediticia actual, histórico de 24 meses y cheques rechazados.
- Búsqueda de un cheque puntual denunciado, por banco y número.
- Resumen de cartera (KPIs) y filtros por nivel de riesgo cuando consultás varias personas.
- Un score de riesgo estimado propio (heurístico, no oficial) por persona.
- Simulador de descuento de cheque / pagaré / factura.
- Gráfico de evolución de la deuda por entidad bancaria.
- Exportación a CSV y vista de impresión (`Cmd/Ctrl+P` → guardar como PDF).

## Cómo funciona (sin servidor)

La API del BCRA acepta llamadas directas desde el navegador (CORS abierto), así que esta app es **100% estática**: HTML, CSS y JS plano, sin build, sin backend, sin base de datos. Corre entera en tu navegador y consulta en vivo:

- `api.bcra.gob.ar/CentralDeDeudores/v1.0` — situación crediticia, histórico y cheques rechazados por persona.
- `api.bcra.gob.ar/cheques/v1.0` — listado de entidades bancarias y consulta de cheques denunciados.

No hay persistencia propia: cada consulta va en vivo contra la API pública del BCRA y no se guarda en ningún servidor.

## Correrlo localmente

No requiere instalación de dependencias. Cualquier servidor estático sirve:

```bash
npx serve .
# o
python3 -m http.server 8000
```

Y abrís la URL que te indique en el navegador.

## Publicarlo (GitHub Pages)

1. Config → Pages → Source: `main` / `(root)`.
2. Listo — queda en `https://<tu-usuario>.github.io/<nombre-del-repo>/`.

## Aviso

Los datos provienen de la Central de Deudores del Sistema Financiero y del registro de cheques rechazados del BCRA, ambos de acceso público. El score de riesgo mostrado es una estimación propia de esta herramienta, **no un score oficial**, y no constituye asesoramiento crediticio ni financiero.
