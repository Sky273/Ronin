// Service des fichiers statiques du client construit (dist/) par le serveur Node, même origine que le WebSocket.
// Tout est chargé en mémoire au démarrage (~2 Mo) : aucune lecture disque par requête, donc aucune
// traversée de chemin possible (seules les clés de la table sont servies). Compression pré-calculée.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

/** Un fichier prêt à servir. */
export interface StaticFile {
  body: Buffer;
  /** Versions compressées, seulement pour le texte au-delà de COMPRESS_MIN (et si elles sont plus petites). */
  gzip?: Buffer;
  br?: Buffer;
  etag: string;
  type: string;
  cacheControl: string;
  /** Page d'entrée (reçoit la CSP). */
  index: boolean;
}

/** Site chargé : table chemin POSIX → fichier, plus des chiffres pour le journal. */
export interface StaticSite {
  map: Map<string, StaticFile>;
  /** Nombre de fichiers lus sur le disque (l'index compte une fois). */
  files: number;
  /** Taille totale non compressée, en octets. */
  bytes: number;
  /** Politique de sécurité du contenu envoyée avec l'index. */
  csp: string;
}

/** En dessous, la compression ne vaut pas la peine. */
export const COMPRESS_MIN = 1024;

const TEXT = '; charset=utf-8';
const MIME: Record<string, string> = {
  html: 'text/html' + TEXT,
  js: 'text/javascript' + TEXT,
  mjs: 'text/javascript' + TEXT,
  css: 'text/css' + TEXT,
  json: 'application/json' + TEXT,
  map: 'application/json' + TEXT,
  svg: 'image/svg+xml' + TEXT,
  txt: 'text/plain' + TEXT,
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
};
const OCTET = 'application/octet-stream';

/** Type MIME d'après l'extension (insensible à la casse). */
export function mimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 && dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
  return MIME[ext] ?? OCTET;
}

/** Texte compressible : tout ce qui porte un charset, plus le wasm. */
const compressible = (type: string): boolean => type.includes('charset=') || type === 'application/wasm';

/** Politique de sécurité de la page : polices Google, styles en ligne (index.html, Phaser), blob:/data: (textures Phaser). */
export function buildCsp(connectSrc: string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    ["connect-src 'self'", ...connectSrc.map((s) => s.trim()).filter(Boolean)].join(' '),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Parcours récursif sans suivre les liens symboliques ; fichiers et dossiers cachés (« .xxx ») ignorés. */
function walk(dir: string, prefix: string, out: Array<{ key: string; abs: string }>): void {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    const key = `${prefix}/${name}`;
    if (st.isDirectory()) walk(abs, key, out);
    else if (st.isFile()) out.push({ key, abs });
  }
}

function cacheFor(key: string, index: boolean): string {
  if (index) return 'no-cache';
  if (key.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

/** Charge tout le dossier en mémoire. Lève si `index.html` manque à la racine. */
export function loadStatic(dir: string, opts: { connectSrc: string[] }): StaticSite {
  const entries: Array<{ key: string; abs: string }> = [];
  walk(dir, '', entries);
  if (!entries.some((e) => e.key === '/index.html')) throw new Error(`index.html introuvable dans ${dir}`);
  const map = new Map<string, StaticFile>();
  let bytes = 0;
  for (const { key, abs } of entries) {
    const body = readFileSync(abs);
    bytes += body.length;
    const index = key === '/index.html';
    const type = mimeType(key);
    const file: StaticFile = {
      body,
      etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
      type,
      cacheControl: cacheFor(key, index),
      index,
    };
    if (compressible(type) && body.length > COMPRESS_MIN) {
      const gz = gzipSync(body, { level: 9 });
      const br = brotliCompressSync(body, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
          [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      });
      if (gz.length < body.length) file.gzip = gz;
      if (br.length < body.length) file.br = br;
    }
    map.set(key, file);
    if (index) map.set('/', file);
  }
  return { map, files: entries.length, bytes, csp: buildCsp(opts.connectSrc) };
}

/** Le jeton figure-t-il dans Accept-Encoding avec un poids non nul ? */
function accepts(header: string, token: string): boolean {
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name.trim() !== token) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

/** If-None-Match correspond-il à l'ETag (liste, « * », préfixe faible W/) ? */
function matchesEtag(header: string, etag: string): boolean {
  return header.split(',').some((t) => {
    const v = t.trim();
    return v === '*' || v === etag || v === `W/${etag}`;
  });
}

/**
 * Sert la requête si elle désigne un fichier chargé (GET/HEAD). Renvoie false sinon, sans rien écrire :
 * l'appelant poursuit (404, matchmaking…). `secure` : la page est servie en HTTPS (ajoute HSTS).
 */
export function serveStatic(site: StaticSite, req: IncomingMessage, res: ServerResponse, secure: boolean): boolean {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return false;
  }
  if (path.includes('\0')) return false;
  const file = site.map.get(path);
  if (!file) return false;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (file.index) res.setHeader('Content-Security-Policy', site.csp);
  res.setHeader('Cache-Control', file.cacheControl);
  res.setHeader('ETag', file.etag);
  if (file.gzip || file.br) res.setHeader('Vary', 'Accept-Encoding');

  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && matchesEtag(inm, file.etag)) {
    res.statusCode = 304;
    res.end();
    return true;
  }

  const ae = typeof req.headers['accept-encoding'] === 'string' ? req.headers['accept-encoding'] : '';
  let body = file.body;
  if (file.br && accepts(ae, 'br')) {
    body = file.br;
    res.setHeader('Content-Encoding', 'br');
  } else if (file.gzip && accepts(ae, 'gzip')) {
    body = file.gzip;
    res.setHeader('Content-Encoding', 'gzip');
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', file.type);
  res.setHeader('Content-Length', body.length);
  res.end(method === 'HEAD' ? undefined : body);
  return true;
}
