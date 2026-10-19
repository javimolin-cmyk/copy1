# Web → GitHub Cloner 2

Versión con Chromium + Playwright.

## Instalación

Requiere Node.js 18+.

```bash
npm install
npx playwright install chromium
npm start
```

Abre `http://localhost:3000`.

## Qué captura

- HTML después de ejecutar JavaScript.
- páginas internas dentro del dominio;
- recursos pedidos por el navegador;
- imágenes;
- CSS;
- JavaScript;
- fuentes;
- audio/vídeo;
- posters;
- `srcset`;
- iframes;
- recursos detectados durante el scroll;
- contenido lazy-loaded que se solicite durante la captura.

Los recursos binarios se suben a GitHub como blobs en Base64, por lo que no se degradan al pasar por una API de texto.

## Alcance y límites

La aplicación está diseñada para copiar **contenido que el navegador puede obtener sin autenticación ni pago**.

No implementa mecanismos para:
- saltar login;
- evadir suscripciones;
- romper paywalls;
- eludir DRM;
- robar o reutilizar sesiones/cookies;
- acceder a contenido privado;
- saltarse controles de autorización.

Si una web ofrece una versión pública y otra versión ampliada para usuarios registrados/suscritos, la copia corresponde a lo que sea públicamente accesible sin esa cuenta.

## GitHub Pages

El resultado contiene `.nojekyll` y está estructurado para poder servirlo como sitio estático mediante GitHub Pages. La aplicación no activa automáticamente Pages porque eso requiere permisos adicionales de administración del repositorio.
