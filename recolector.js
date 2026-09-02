#!/usr/bin/env node
/**
 * Recolector del historico de Mony.
 *
 * Consulta las mismas fuentes que la app y con los mismos criterios, para que
 * los numeros del servidor y los del telefono coincidan:
 *   - Binance P2P: 20 filas, se descarta el anuncio patrocinado
 *     (privilegeType != null) y se promedian los 10 primeros organicos.
 *   - BCV: ve.dolarapi.com primero, www.bcv.org.ve de respaldo.
 *
 * Guarda un registro por dia en datos/historial.json con el mismo esquema que
 * usa la app (DiaHistorico), y una foto de la ultima lectura en datos/actual.json.
 *
 * Node 20+, sin dependencias.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT_P2P = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const API_USD = 'https://ve.dolarapi.com/v1/dolares/oficial';
const API_EUR = 'https://ve.dolarapi.com/v1/euros/oficial';
const URL_BCV = 'https://www.bcv.org.ve/';

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Mobile Safari/537.36';

/** Cuantos anuncios se promedian, y cuantos se piden para que sobren. */
const ANUNCIOS = 10;
const FILAS_PEDIDAS = 20;

/** Monto minimo que deben aceptar los anuncios, en USDT. */
const MONTO_USDT = 5;

/** Dias que se conservan; el resto se recorta por el principio. */
const DIAS_MAX = 365;

const CARPETA = path.join(__dirname, 'datos');
const HISTORIAL = path.join(CARPETA, 'historial.json');
const ACTUAL = path.join(CARPETA, 'actual.json');

const TIEMPO_MS = 25000;

// ---------------------------------------------------------------- utilidades

/** fetch con tiempo limite: sin esto una fuente colgada bloquea el flujo entero. */
async function pedir(url, opciones = {}) {
  const aborto = new AbortController();
  const reloj = setTimeout(() => aborto.abort(), TIEMPO_MS);
  try {
    const respuesta = await fetch(url, {
      ...opciones,
      signal: aborto.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'es-VE,es;q=0.9',
        ...(opciones.headers || {}),
      },
    });
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status} en ${url}`);
    return await respuesta.text();
  } finally {
    clearTimeout(reloj);
  }
}

/** Numero utilizable: nunca NaN, ni infinito, ni cero o negativo. */
function positivo(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** "1.234,56" o "798,32600000" -> numero */
function aNumero(texto) {
  return positivo(String(texto).replace(/\./g, '').replace(',', '.'));
}

// ------------------------------------------------------------------- Binance

/**
 * Promedio de los ANUNCIOS primeros anuncios organicos de un lado del mercado.
 * tradeType "SELL" = tu vendes USDT; "BUY" = tu compras.
 */
async function ladoP2P(tradeType, montoBs) {
  const cuerpo = {
    fiat: 'VES',
    asset: 'USDT',
    tradeType,
    page: 1,
    rows: FILAS_PEDIDAS,
    payTypes: [],
    countries: [],
    periods: [],
    publisherType: null,
    proMerchantAds: false,
    shieldMerchantAds: false,
    additionalKycVerifyFilter: 0,
    filterType: 'all',
    classifies: ['mass', 'profession', 'fiat_trade'],
  };
  if (montoBs > 0) cuerpo.transAmount = String(montoBs);

  const texto = await pedir(ENDPOINT_P2P, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(cuerpo),
  });

  const datos = JSON.parse(texto).data || [];
  const precios = [];
  for (const item of datos) {
    if (precios.length >= ANUNCIOS) break;
    // El patrocinado va siempre primero y con un precio fuera de mercado.
    if (item && item.privilegeType !== null && item.privilegeType !== undefined) continue;
    const precio = positivo(item && item.adv && item.adv.price);
    if (precio === 0) continue;
    precios.push(precio);
  }

  if (precios.length === 0) throw new Error(`Binance no devolvio anuncios para ${tradeType}`);
  const promedio = precios.reduce((a, b) => a + b, 0) / precios.length;
  return { promedio, minimo: Math.min(...precios), maximo: Math.max(...precios) };
}

// ----------------------------------------------------------------------- BCV

async function desdeApi() {
  const leer = async (url) => {
    const cuerpo = await pedir(url);
    const crudo = JSON.parse(cuerpo);
    const objeto = Array.isArray(crudo)
      ? crudo.find((o) => o && o.fuente === 'oficial')
      : crudo;
    if (!objeto) return { valor: 0, fecha: '' };
    return {
      valor: positivo(objeto.promedio),
      fecha: String(objeto.fechaActualizacion || '').slice(0, 10),
    };
  };
  try {
    const [usd, eur] = await Promise.all([leer(API_USD), leer(API_EUR)]);
    if (usd.valor === 0 && eur.valor === 0) return null;
    return { usd: usd.valor, eur: eur.valor, fecha: usd.fecha || eur.fecha };
  } catch (e) {
    console.warn('dolarapi fallo:', e.message);
    return null;
  }
}

/** El valor esta en el primer <strong> del bloque <div id="dolar"|"euro">. */
function valorDe(html, id) {
  const inicio = html.indexOf(`id="${id}"`);
  if (inicio < 0) return 0;
  const bloque = html.slice(inicio, inicio + 1500);
  const encontrado = bloque.match(/<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/);
  return encontrado ? aNumero(encontrado[1]) : 0;
}

async function desdeWeb() {
  try {
    const html = await pedir(URL_BCV);
    const fecha = html.match(/content="(\d{4}-\d{2}-\d{2})T/);
    return {
      usd: valorDe(html, 'dolar'),
      eur: valorDe(html, 'euro'),
      fecha: fecha ? fecha[1] : '',
    };
  } catch (e) {
    console.warn('bcv.org.ve fallo:', e.message);
    return null;
  }
}

async function tasasBcv() {
  const porApi = await desdeApi();
  if (porApi && porApi.usd > 0 && porApi.eur > 0) return porApi;

  const porWeb = await desdeWeb();
  if (porWeb && (porWeb.usd > 0 || porWeb.eur > 0)) {
    // Lo mejor de cada fuente: si una trajo solo el dolar y la otra solo el
    // euro, no se pierde ninguno de los dos.
    return {
      usd: porWeb.usd > 0 ? porWeb.usd : (porApi ? porApi.usd : 0),
      eur: porWeb.eur > 0 ? porWeb.eur : (porApi ? porApi.eur : 0),
      fecha: porWeb.fecha || (porApi ? porApi.fecha : ''),
    };
  }
  if (porApi) return porApi;
  throw new Error('No se pudo obtener la tasa del BCV');
}

// ------------------------------------------------------------------ historial

function leerHistorial() {
  try {
    const datos = JSON.parse(fs.readFileSync(HISTORIAL, 'utf8'));
    return Array.isArray(datos) ? datos : [];
  } catch (e) {
    return [];
  }
}

/** Fecha de Venezuela (UTC-4), que es la que marca el dia del BCV. */
function hoyVenezuela() {
  return new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function registrar(dias, lectura) {
  const fecha = hoyVenezuela();
  let dia = dias.find((d) => d && d.fecha === fecha);
  if (!dia) {
    dia = { fecha, muestras: 0 };
    dias.push(dia);
  }

  const primera = dia.muestras === 0;
  if (lectura.venta > 0) {
    dia.p2pVenta = lectura.venta;
    dia.ventaMin = primera ? lectura.venta : Math.min(dia.ventaMin, lectura.venta);
    dia.ventaMax = primera ? lectura.venta : Math.max(dia.ventaMax, lectura.venta);
  }
  if (lectura.compra > 0) dia.p2pCompra = lectura.compra;
  if (lectura.bcvUsd > 0) dia.bcvUsd = lectura.bcvUsd;
  if (lectura.bcvEur > 0) dia.bcvEur = lectura.bcvEur;
  dia.muestras += 1;
  dia.actualizado = new Date().toISOString();

  dias.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  return dias.slice(-DIAS_MAX);
}

// --------------------------------------------------------------------- marcha

async function principal() {
  // transAmount va en bolivares: se convierte con la ultima venta conocida,
  // igual que hace RatesRepository en la app.
  const previos = leerHistorial();
  const ultimo = previos[previos.length - 1];
  const referencia = (ultimo && positivo(ultimo.p2pVenta)) || 1000;
  const montoBs = Math.round(MONTO_USDT * referencia);

  const [venta, compra, bcv] = await Promise.all([
    ladoP2P('SELL', montoBs),
    ladoP2P('BUY', montoBs),
    tasasBcv(),
  ]);

  const lectura = {
    venta: venta.promedio,
    compra: compra.promedio,
    bcvUsd: bcv.usd,
    bcvEur: bcv.eur,
  };

  fs.mkdirSync(CARPETA, { recursive: true });
  const dias = registrar(previos, lectura);
  fs.writeFileSync(HISTORIAL, JSON.stringify(dias, null, 1) + '\n');

  fs.writeFileSync(
    ACTUAL,
    JSON.stringify(
      {
        p2pVenta: lectura.venta,
        p2pCompra: lectura.compra,
        p2pPromedio: (lectura.venta + lectura.compra) / 2,
        bcvUsd: lectura.bcvUsd,
        bcvEur: lectura.bcvEur,
        fechaBcv: bcv.fecha,
        actualizado: new Date().toISOString(),
      },
      null,
      1
    ) + '\n'
  );

  console.log(
    `venta ${lectura.venta.toFixed(2)} | compra ${lectura.compra.toFixed(2)} | ` +
      `BCV $ ${lectura.bcvUsd.toFixed(2)} | BCV EUR ${lectura.bcvEur.toFixed(2)} | ` +
      `${dias.length} dias guardados`
  );
}

principal().catch((e) => {
  console.error('El recolector fallo:', e.message);
  process.exit(1);
});
