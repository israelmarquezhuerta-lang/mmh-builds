# Probar MMH Builds en tu computadora

Esta versión se ejecuta solo en tu computadora y todavía no queda publicada en internet.
Necesita Node.js 24 o posterior para guardar los datos locales.

## Abrir la app

1. Abre la carpeta `MMH Builds` en Visual Studio Code.
2. Abre una terminal nueva desde el menú **Terminal → Nueva terminal**.
3. Ejecuta `node server-local.js`.
4. Abre `http://127.0.0.1:4173` en tu navegador.
5. Para cerrar la app, vuelve a la terminal y presiona `Ctrl+C`.

## Asistente de IA

La tienda abre aunque todavía no configures la IA. Para activar el asistente localmente, crea un archivo llamado `.env.local` en esta carpeta con esta línea:

```text
GEMINI_API_KEY=pega_aqui_tu_clave_local
```

La clave permanece en tu computadora. No la pegues en el chat ni la publiques en el sitio.

## Recuperación de contraseña

La pantalla incluye «¿Olvidaste tu contraseña?». Puedes preparar un proyecto de Google Apps Script con [`apps-script/Code.gs`](./apps-script/Code.gs), autorizar `authorizeMailSender` y desplegarlo como aplicación web. Para enviar correos desde la versión local, agrega estas variables a `.env.local` con la URL `/exec` y la misma clave secreta que guardaste en las propiedades del script:

```text
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/ID_DEL_DESPLIEGUE/exec
PASSWORD_RESET_MAIL_SECRET=una_clave_aleatoria_larga_de_32_caracteres_o_mas
APP_BASE_URL=http://127.0.0.1:4173
```

El envío lo hace el servidor local desde la cuenta Google que autorizó Apps Script. Nunca pegues la clave en `index.html` ni la subas a GitHub. Sin estas variables, la app explica que el envío todavía no está configurado.

## Estado actual

Puedes abrir el menú principal como visitante después de dejar únicamente tu nombre y un teléfono real (celular, casa u oficina). Tu rango será **Cliente explorando**, sin puntos ni descuentos. Esos datos se guardan localmente en `data/mmh-local.sqlite` o, si el servidor anterior sigue activo, en el almacenamiento de este navegador. Para registrar una solicitud de pedido, guardar pedidos o consultar tu cuenta, inicia sesión o crea una cuenta.

La app guarda localmente las cuentas (con contraseñas protegidas), los carritos, los pedidos y los datos de visitantes en `data/mmh-local.sqlite`; seguirán ahí cuando cierres y vuelvas a abrir la app. Esa base de datos solo existe en esta computadora.

Los pagos se coordinan manualmente por WhatsApp; todavía no se cobra desde la app. El avance de pedido se puede recorrer para probar la pantalla, pero no está conectado a un taller ni a una paquetería. Los productos y precios del catálogo todavía son los datos de muestra del proyecto.

El asesor Gemini está dentro del portal de cliente. Cuando el cliente expresa que desea comprar, aparece un enlace de WhatsApp con un borrador que incluye su selección y el resumen del asesor. El cliente debe revisar y enviar ese mensaje; MMH confirma disponibilidad y precio final antes de cualquier pago.

El programa MMH Rewards muestra 20 puntos por cuenta y 20 puntos por cada compra confirmada con subtotal de productos mayor a $5,000 MXN. Los niveles usan el acumulado de subtotales antes de descuentos. El 10% de primera compra y los descuentos por nivel se calculan como estimados sobre productos; no se acumulan ni aplican a servicios por cotizar. Una solicitud pendiente no suma puntos: MMH debe confirmar el pago manualmente para que la compra cuente. La app todavía no incluye un panel para que MMH valide pagos.

Después de verificar el pago por un canal externo, MMH puede acreditar la compra local ejecutando `node confirmar-pago-local.js MMH-XXXXXXXX`, con el folio real de la solicitud. No ejecutes el comando por una solicitud ni antes de confirmar que recibiste el pago. Las cotizaciones con servicios se excluyen hasta que tengan un total final.

El apartado **Soluciones para escuelas y negocios** permite solicitar por pedido, mediante WhatsApp, cotizaciones de cámaras con instalación/programación, equipo de cómputo para instituciones y negocios y laptops Dell, Lenovo y HP. La propuesta se revisa y acepta antes de acordar el pago; no se cobra dentro de la app. Las laptops seminuevas se anuncian con 6 meses de garantía, cuyas condiciones deben confirmarse por escrito con MMH para el modelo cotizado.

El perfil del cliente incluye una galería de enlaces a las 12 publicaciones y Reels públicos visibles de `@computadorasmmh` al preparar esta versión. Instagram no proporciona aquí la sincronización automática del feed; para mantener los anuncios al día, actualiza la lista `instagramPromotions` en `index.html`. Cada tarjeta abre el contenido original en Instagram.
