# Publicar MMH Builds gratis con Cloudflare

Esta configuración publica el catálogo y sus funciones de servidor en Cloudflare Pages. Cloudflare D1 guarda visitantes, cuentas, sesiones y pedidos; Gemini se conecta desde una función de servidor. No pongas la clave de Gemini en el HTML ni en GitHub.

## Antes de empezar

Necesitas cuentas gratuitas de GitHub y Cloudflare. El dominio gratuito será una dirección `*.pages.dev`. Un dominio propio normalmente tiene costo. El uso de Gemini puede estar sujeto a cuotas, condiciones o cargos de Google.

La carpeta del proyecto no incluye los datos de `data/mmh-local.sqlite` en la publicación. Las cuentas, pedidos y visitas guardados localmente no se migran; al publicar, los nuevos registros vivirán en D1.

## 1. Crear la base de datos

1. En Cloudflare, abre **Workers & Pages → D1 SQL Database** y crea una base llamada `mmh-builds`.
2. Copia el identificador de base de datos que muestra Cloudflare.
3. En `wrangler.toml`, reemplaza `REPLACE_WITH_YOUR_D1_DATABASE_ID` por ese identificador y sube el cambio a GitHub.
4. Abre la consola SQL de la base D1 y ejecuta el contenido completo de [`migrations/0001_initial.sql`](./migrations/0001_initial.sql). Esto crea las tablas de cuentas, sesiones, pedidos, visitantes y límites del asistente.

## 2. Subir el proyecto a GitHub

1. Crea un repositorio privado nuevo en GitHub.
2. Sube el contenido de esta carpeta, incluyendo `functions`, `migrations`, `assets`, `index.html`, `loyalty.js`, `chat-config.js`, `wrangler.toml` y `.assetsignore`.
3. No subas `.env.local`, la carpeta `data`, ni contraseñas o claves. `.gitignore` excluye los datos locales y archivos `.env`.

## 3. Crear el sitio en Cloudflare Pages

1. En Cloudflare abre **Workers & Pages → Create → Pages → Connect to Git** e importa el repositorio.
2. No selecciones un framework, usa `exit 0` como comando de build y deja el directorio de salida como `.`. Cloudflare recomienda `exit 0` para que Pages compile las funciones del servidor.
3. En la configuración del proyecto, agrega el secreto `GEMINI_API_KEY` con tu clave de Google AI Studio. No uses una variable pública `VITE_` o `NEXT_PUBLIC_`.
4. Despliega y abre la URL HTTPS `*.pages.dev`.

`wrangler.toml` enlaza la base D1 mediante el binding `DB`; `functions/api/[[path]].js` atiende el chat y las rutas de visitante, cuenta y pedidos.

## 4. Prueba el sitio publicado

- `/` debe mostrar la pantalla actualizada y el acceso de visitante.
- El acceso de visitante guarda el nombre y teléfono en D1 y muestra el rango **Cliente explorando**, sin puntos ni descuentos.
- Registra una cuenta de prueba, cierra sesión y vuelve a entrar. La sesión usa una cookie segura y las contraseñas se almacenan con PBKDF2.
- Crea un pedido de prueba y verifica que aparezca en el perfil del cliente.
- Envía un mensaje al asesor para probar Gemini. Si responde que no está configurado, revisa el secreto `GEMINI_API_KEY` y vuelve a desplegar.
- `GET /api/chat` debe devolver `405`; solo acepta `POST`.

## Operación de pedidos y privacidad

Los clientes pueden crear cuentas y pedidos, pero este proyecto todavía no incluye un panel privado de administración. Para revisar solicitudes, usa la consola SQL de D1; no publiques ni compartas la base. Una vez que confirmes un pago por el canal externo, puedes actualizar su estado desde D1. No marques un pago como verificado antes de recibirlo:

```sql
UPDATE orders
SET payment_status = 'Pago verificado'
WHERE id = 'MMH-FOLIO_REAL' AND quote_required = 0;
```

La aplicación no procesa pagos. La disponibilidad y el precio final deben ser confirmados por MMH; los importes del catálogo son referencias. Protege los datos de contacto y cumple las obligaciones de privacidad aplicables antes de promocionar el sitio.
