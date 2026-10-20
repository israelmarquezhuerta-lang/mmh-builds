# Publicar MMH Builds gratis con Cloudflare

Esta configuración publica el catálogo y sus funciones de servidor en Cloudflare Pages. Cloudflare D1 guarda visitantes, cuentas, sesiones y pedidos; Gemini se conecta desde una función de servidor. No pongas la clave de Gemini en el HTML ni en GitHub.

## Antes de empezar

Necesitas cuentas gratuitas de GitHub y Cloudflare. El dominio gratuito será una dirección `*.pages.dev`. Un dominio propio normalmente tiene costo. El uso de Gemini puede estar sujeto a cuotas, condiciones o cargos de Google.

La carpeta del proyecto no incluye los datos de `data/mmh-local.sqlite` en la publicación. Las cuentas, pedidos y visitas guardados localmente no se migran; al publicar, los nuevos registros vivirán en D1.

## 1. Crear la base de datos

1. En Cloudflare, abre **Workers & Pages → D1 SQL Database** y crea una base llamada `mmh-builds`.
2. Copia el identificador de base de datos que muestra Cloudflare.
3. En `wrangler.toml`, reemplaza `REPLACE_WITH_YOUR_D1_DATABASE_ID` por ese identificador y sube el cambio a GitHub.
4. Abre la consola SQL de la base D1 y ejecuta, en orden, [`migrations/0001_initial.sql`](./migrations/0001_initial.sql) y [`migrations/0002_password_reset_tokens.sql`](./migrations/0002_password_reset_tokens.sql). La segunda migración crea la tabla para enlaces de recuperación de un solo uso.

Si la base `mmh-builds` ya existe y contiene cuentas, ejecuta únicamente `migrations/0002_password_reset_tokens.sql` en su consola D1. No vuelvas a ejecutar `0001_initial.sql`; la nueva migración solo agrega la tabla de recuperación y conserva las cuentas y pedidos actuales.

## 2. Subir el proyecto a GitHub

1. Crea un repositorio privado nuevo en GitHub.
2. Sube el contenido de esta carpeta, incluyendo `functions`, `migrations`, `assets`, `index.html`, `loyalty.js`, `chat-config.js`, `wrangler.toml` y `.assetsignore`.
3. No subas `.env.local`, la carpeta `data`, ni contraseñas o claves. `.gitignore` excluye los datos locales y archivos `.env`.

## 3. Preparar el envío desde Gmail

Esta opción usa tu cuenta Gmail personal, no necesita comprar un dominio. Entra a [Google Apps Script](https://script.google.com/) con la cuenta que enviará los correos y crea un proyecto.

1. Copia el contenido de [`apps-script/Code.gs`](./apps-script/Code.gs) en `Code.gs` y guarda el proyecto.
2. En **Project Settings → Script Properties**, crea `MMH_RESET_MAIL_SECRET` con una clave aleatoria larga (mínimo 32 caracteres). Guarda esa misma clave para agregarla luego como secreto de Cloudflare; no la envíes por chat.
3. En el editor, selecciona `authorizeMailSender` y pulsa **Run**. Revisa que sea la cuenta correcta y autoriza el envío de correos.
4. Pulsa **Deploy → New deployment → Web app**. Elige **Execute as: Me** y permite acceso a usuarios anónimos. Despliega y copia la URL que termina en `/exec`.

Google Apps Script tiene una cuota diaria para cuentas personales (actualmente 100 destinatarios al día), y Google puede cambiar esos límites. Consulta la [cuota oficial](https://developers.google.com/apps-script/guides/services/quotas).

## 4. Crear el sitio en Cloudflare Pages

1. En Cloudflare abre **Workers & Pages → Create → Pages → Connect to Git** e importa el repositorio.
2. No selecciones un framework, usa `exit 0` como comando de build y deja el directorio de salida como `.`. Cloudflare recomienda `exit 0` para que Pages compile las funciones del servidor.
3. En la configuración del proyecto, agrega el secreto `GEMINI_API_KEY` con tu clave de Google AI Studio. No uses una variable pública `VITE_` o `NEXT_PUBLIC_`.
4. En **Settings → Variables and Secrets**, agrega `GOOGLE_APPS_SCRIPT_URL` con la URL `/exec` copiada y `PASSWORD_RESET_MAIL_SECRET` como secreto con la clave larga del paso anterior. `APP_BASE_URL` ya apunta a `https://mmh-builds.pages.dev` en `wrangler.toml`; cámbialo si publicas con otro dominio.
5. Despliega y abre la URL HTTPS `*.pages.dev`.

`wrangler.toml` enlaza la base D1 mediante el binding `DB`; `functions/api/[[path]].js` atiende el chat y las rutas de visitante, cuenta y pedidos. La recuperación usa un enlace temporal de 30 minutos; al cambiar la contraseña, se cierran las sesiones abiertas. Nunca se envía la contraseña actual.

## 5. Prueba el sitio publicado

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

Los clientes ya no pueden cambiar la etapa de su pedido. Para avanzarla (0 = recibido … 6 = entregado), usa la consola SQL de D1:

```sql
UPDATE orders
SET stage = 1
WHERE id = 'MMH-FOLIO_REAL';
```

El servidor recalcula el subtotal de cada pedido con el catálogo de [`catalog.js`](./catalog.js) e ignora precios o totales enviados por el navegador. Si cambias un precio, cámbialo en `catalog.js`.

La aplicación no procesa pagos. La disponibilidad y el precio final deben ser confirmados por MMH; los importes del catálogo son referencias. Protege los datos de contacto y cumple las obligaciones de privacidad aplicables antes de promocionar el sitio.
