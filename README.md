# Mony · recolector de tasas

Historial público del dólar en Venezuela. Un flujo de GitHub Actions consulta
cada 20 minutos el P2P de Binance y el BCV, y publica el resultado en JSON.

## Datos

| Archivo | Qué es |
|---|---|
| [`datos/historial.json`](datos/historial.json) | Un registro por día, hasta 365 días |
| [`datos/actual.json`](datos/actual.json) | La última lectura |

Se leen directamente sin ninguna clave:

```
https://raw.githubusercontent.com/gabrielS1103/Mony-tasas/main/datos/historial.json
https://raw.githubusercontent.com/gabrielS1103/Mony-tasas/main/datos/actual.json
```

Un día del historial:

```json
{
  "fecha": "2026-09-02",
  "p2pVenta": 962.7526,
  "p2pCompra": 969.6585,
  "ventaMin": 962.7526,
  "ventaMax": 962.7526,
  "bcvUsd": 801.1752,
  "bcvEur": 929.09083243,
  "muestras": 1,
  "actualizado": "2026-09-02T17:57:27.866Z"
}
```

`ventaMin` y `ventaMax` son el recorrido de la venta dentro del día, y
`muestras` cuántas lecturas se promediaron para llegar ahí.

## Cómo se calculan

- **Binance P2P** (`p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search`): se
  piden 20 anuncios de cada lado, se descarta el patrocinado —viene primero y
  con un precio fuera de mercado— y se promedian los **10 primeros orgánicos**
  que acepten al menos 5 USDT.
- **BCV**: primero `ve.dolarapi.com`, que publica el dólar y el euro oficiales
  en JSON y responde rápido; `www.bcv.org.ve` queda de respaldo. Si una fuente
  trae solo uno de los dos valores, se completa con la otra.

Todo está en [`recolector.js`](recolector.js): Node 20, sin dependencias.

## Ejecutarlo a mano

```bash
node recolector.js
```

El cron está en [`.github/workflows/tasas.yml`](.github/workflows/tasas.yml).
Es el cron gratuito de GitHub, así que es *best effort*: puede retrasarse o
saltarse una ronda. Como solo se guarda un registro por día, perder una vuelta
no cambia el resultado.

Los datos vienen de fuentes públicas y se publican como referencia, sin ninguna
garantía de exactitud ni disponibilidad.
