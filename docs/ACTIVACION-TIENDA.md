# Activar la tienda profesional MMH

## Alcance preparado
- Tienda pública con búsqueda, categorías, marcas, presupuesto, fichas y fotografías reales.
- Catálogo inicial: 32 fichas verificadas de Cyberpuerta, en ocho categorías. Es una selección, no todo su catálogo ni una conexión oficial.
- Precio de venta: costo base × 1.35, redondeado a centavos. Sin descuentos de lealtad adicionales. Los pedidos guardados conservan su total; si el catálogo cambió, se pide registrar una selección actualizada antes de cobrar.
- Webs, apps y seminuevos: formulario que guarda el proyecto en el pedido de la cuenta. La disponibilidad de seminuevos y el precio del proyecto no se inventan.
- Espacio de administración: consulta pedidos y solicitudes de clientes y actualiza etapas. No permite marcar pagos como cobrados. Se activa con MMH_ADMIN_EMAILS, una lista de correos de las cuentas propietarias separadas por coma.

## Google y Microsoft
En Cloudflare Pages → Settings → Variables and secrets → Production:
- GOOGLE_CLIENT_ID: identificador de tu cliente OAuth web de Google.
- GOOGLE_CLIENT_SECRET: secreto de ese cliente, como Secret.
- MICROSOFT_CLIENT_ID: identificador de aplicación de Microsoft Entra.
- MICROSOFT_CLIENT_SECRET: valor del secreto de esa aplicación, como Secret. No el identificador del secreto.
- APP_BASE_URL: https://mmh-builds.pages.dev

Redirecciones exactas que debes registrar:
- Google: https://mmh-builds.pages.dev/api/auth/google/callback
- Microsoft: https://mmh-builds.pages.dev/api/auth/microsoft/callback

Google: cliente de aplicación web, pantalla de consentimiento publicada o usuarios de prueba permitidos, permisos openid/profile/email.
Microsoft: aplicación web que admita cuentas Microsoft personales (Hotmail y Outlook), permisos openid/profile/email.

Para probar en una URL de vista previa, configura variables del entorno Preview, agrega sus redirecciones y haz que APP_BASE_URL coincida con esa URL. No copies secretos a archivos del repositorio o al chat.

Los botones solo aparecen con un proveedor configurado. Antes de activarlo, se mantiene correo/contraseña. Una cuenta existente no se vincula automáticamente solo por coincidir el correo: protege pedidos previos contra la apropiación de cuentas. El cliente puede seguir usando su contraseña.

La migración migrations/0004_oauth_identities.sql crea la tabla de identidades. El flujo también la inicializa de forma idempotente cuando se utiliza un proveedor configurado.

## Catálogo completo
El importador scripts/import-catalog.cjs valida un JSON con SKU, nombre, marca, categoría, referencePrice, URL de la ficha, fecha de consulta, disponibilidad booleana y URLs HTTPS de imágenes.

Ejecuta: node scripts/import-catalog.cjs archivo-del-proveedor.json

La importación rechaza datos inválidos y no modifica la integración de Stripe. Requiere datos actualizados y autorización del proveedor para reutilizar comercialmente fotografías y catálogo. La selección pública actual no sustituye un acuerdo de distribución ni garantiza existencias futuras. No hay un sincronizador completo ni una API oficial de Cyberpuerta configurada.

## Antes de producción
1. Rotar la clave privada de Stripe compartida en el chat y actualizar su valor en Cloudflare.
2. Configurar OAuth y comprobar un acceso real con cada proveedor.
3. Definir la cuenta propietaria en MMH_ADMIN_EMAILS.
4. Confirmar los costos de envío, cobertura de ensamble, garantías y la fuente de catálogo completo. El 35% sobre costo es margen bruto antes de comisiones, envíos, impuestos y costos de operación.
5. Revisar y aprobar la vista previa antes de sustituir la tienda principal.

Pruebas: node --test tests/*.test.cjs
