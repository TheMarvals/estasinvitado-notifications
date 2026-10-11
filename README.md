# Notificaciones para invitaciones

Servicio independiente para cualquier invitación. Una sola instalación en Coolify atiende varios eventos, cada uno con su API key, remitente y política de destinatarios. La API key de Resend vive únicamente aquí. Las invitaciones llaman desde su servidor, nunca desde el navegador.

```mermaid
flowchart LR
  A[Servidor de cada invitación] --> B[Pendientes locales]
  B -->|Bearer API key de la invitación| C[API de notificaciones]
  C --> D[(Cola SQLite persistente)]
  D --> E[Worker con reintentos]
  E --> F[Resend]
  F --> G[Organizadores configurados]
```

## Desplegar una vez en Coolify

1. Crea una **aplicación conectada a GitHub** desde `TheMarvals/estasinvitado-notifications`, rama `main`.
2. Selecciona Docker Compose. **Base Directory:** `/`. **Docker Compose Location:** `/docker-compose.yaml`.
3. Define `RESEND_API_KEY` como secreto y, opcionalmente, `RESEND_FROM`, cuyo valor predeterminado es `notifications@estasinvitado.lat`. El dominio debe estar verificado en Resend. Coolify genera la clave administrativa `SERVICE_PASSWORD_64_NOTIFICATIONS`.
4. Asigna un dominio HTTPS al servicio `notifications`, puerto interno **28461**, y despliega. Con wildcard configurado, Coolify puede generar el dominio.
5. Conserva el volumen `notifications-data` y activa Auto Deploy. Usa **una instancia** del servicio por base SQLite. El worker limita los envíos globales a uno por segundo; todas las invitaciones comparten la cuota de tu cuenta Resend.

Usa una aplicación desde GitHub, no un servicio «Docker Compose Empty»: Coolify debe clonar este repositorio para encontrar el `Dockerfile` que utiliza `build: .`. Pegar únicamente el YAML en un servicio vacío produce el error `Dockerfile: no such file or directory`.

No hace falta Redis ni instalar dependencias: utiliza Node 24 y su módulo SQLite. El volumen guarda invitaciones, hashes de claves, eventos y cola. Haz backups consistentes de SQLite con su API de backup o con el servicio detenido, incluyendo sus archivos WAL si existen.

## Si despliegas con Dockerfile directamente

El modo Dockerfile también está soportado, pero Coolify no aplica `docker-compose.yaml` en esa modalidad. Configura en la aplicación:

- **General → Ports Exposes:** `28461`. Deja **Ports Mappings** vacío para acceder mediante el proxy HTTPS.
- **Variables de entorno en ejecución:** `PORT=28461`, `DATABASE_PATH=/data/notifications.sqlite`, `RESEND_API_KEY`, `RESEND_FROM=notifications@estasinvitado.lat` y `ADMIN_API_KEY` (al menos 32 caracteres). En esta modalidad debes generar la clave administrativa, por ejemplo con `openssl rand -hex 32`.
- **Persistent Storage:** añade un volumen con destino `/data`. Conserva el volumen existente si ya contiene datos. La imagen escribe como usuario `node` (UID/GID 1000); cualquier directorio del host montado manualmente debe permitirle escribir.
- **Healthcheck:** conserva el incluido en el Dockerfile, que usa Node para consultar `/health`. No necesita curl ni wget. El aviso genérico de Coolify sobre esas herramientas no explica un fallo de arranque por permisos.

Guarda los cambios y redespliega. El error `EACCES: permission denied, mkdir './.local'` indica que se está usando la ruta local en el contenedor. Configura `/data/notifications.sqlite`; la imagen también mantiene `/app/.local` como enlace a `/data` para admitir la configuración anterior sin guardar SQLite en una carpeta efímera de la aplicación.

## Registrar cada invitación

Desde una terminal de confianza, configura `NOTIFICATIONS_URL` con el dominio del servicio y `ADMIN_API_KEY` con la clave administrativa generada por Coolify. Crea `invitation.json` con tus datos reales:

```json
{
  "id": "genesis-alfonso-2026",
  "name": "Génesis & Alfonso",
  "from": "notifications@estasinvitado.lat",
  "recipientSource": "invitation",
  "recipients": [],
  "events": ["rsvp.created", "message.created", "song.suggested"]
}
```

```bash
curl --fail-with-body "$NOTIFICATIONS_URL/v1/admin/invitations" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @invitation.json
```

La respuesta entrega `apiKey` **una sola vez**. Guárdala en el servidor de esa invitación; la base del servicio conserva solo su SHA-256. No utilices la clave administrativa ni la de Resend como clave de una invitación.

En Coolify, para la aplicación de la boda, configura:

```dotenv
NOTIFICATIONS_URL=https://notificaciones.tudominio.com
NOTIFICATIONS_API_KEY=inv_clave_individual_devuelta_por_la_api
```

Vuelve a desplegar la invitación. En **Keystatic → Configuración General → Email del administrador · Notificaciones**, guarda el correo del organizador. Las confirmaciones nuevas generarán avisos a ese correo, leídos desde el servidor. Si el campo está vacío o no es válido, los avisos nuevos permanecen pendientes hasta completarlo. No necesitas volver a desplegar para cambiar el correo. Las respuestas antiguas no se envían automáticamente. La integración está desactivada si falta alguna variable. Este primer alcance no envía correos a invitados; su dirección, si existe, se incluye como dato de contacto en el aviso al organizador.

## Contrato para cualquier invitación

`POST /v1/events`, desde su backend:

```http
Authorization: Bearer inv_clave_individual
Content-Type: application/json
Idempotency-Key: rsvp/identificador-estable-de-la-confirmacion
```

```json
{
  "type": "rsvp.created",
  "organizerEmail": "organizador@tudominio.com",
  "data": {
    "name": "Nombre del invitado",
    "email": "",
    "phone": "",
    "attendingCeremony": true,
    "attendingParty": true,
    "passes": 2,
    "dietary": "",
    "message": "Nos vemos pronto"
  }
}
```

`passes` incluye al titular; es cero si no asiste. Para otros tipos de invitación puedes interpretar `attendingParty` como asistencia al evento principal y dejar `attendingCeremony` en falso.

Respuesta `202`: `{ "id": "uuid", "status": "queued", "duplicate": false }`. Repetir el mismo evento y clave devuelve el mismo ID sin crear otro correo. Reutilizar la clave con datos distintos devuelve `409`. La clave de deduplicación está separada por invitación. Reintenta con el **mismo cuerpo y clave** si se pierde la respuesta de la API.

También soporta:

- `message.created`: `data: { name, message }`.
- `song.suggested`: `data: { name, songTitle, artist, message }`.

La boda actual integra automáticamente `rsvp.created`; los otros eventos están disponibles para otros consumidores. Los mensajes de la confirmación ya forman parte de ese aviso.

El administrador del servicio elige `recipientSource` por invitación:

- `service` (predeterminado): los correos se fijan en `recipients`; cualquier `organizerEmail` enviado por el consumidor se rechaza.
- `invitation`: autoriza a esa API key a indicar **un correo de organizador por evento** con `organizerEmail`. En esta boda el servidor obtiene el valor del campo `adminEmail` de Keystatic, nunca de los datos enviados por un visitante. Puedes registrar la invitación con `recipients: []` y completar el correo desde el editor.

Si ya registraste la boda, usa `PATCH /v1/admin/invitations/genesis-alfonso-2026` con `{"recipientSource":"invitation","from":"notifications@estasinvitado.lat"}` para autorizar el campo del editor. Esta autorización solo la puede cambiar la clave administrativa del servicio. La API key individual puede gestionar el destinatario de su propia invitación en este modo; mantenla exclusivamente en el servidor.

Los consumidores no pueden elegir remitente ni HTML; se resuelven desde la configuración del servicio y una plantilla. Límites por invitación: 30 eventos nuevos/minuto y 1000/día. Petición JSON máxima de 32 KiB. Un `429` requiere reintentar más tarde.

## Administración y seguimiento

Todas las rutas administrativas requieren `Authorization: Bearer $ADMIN_API_KEY`:

| Método y ruta | Función |
| --- | --- |
| `GET /v1/admin/invitations` | Listar invitaciones, configuración y prefijo de la clave |
| `POST /v1/admin/invitations` | Registrar invitación y entregar su clave |
| `PATCH /v1/admin/invitations/:id` | Cambiar nombre, remitente, destinatarios, eventos o `enabled` |
| `POST /v1/admin/invitations/:id/keys` | Rotar la clave; la anterior deja de funcionar inmediatamente |
| `GET /v1/admin/invitations/:id/events` | Consultar los últimos 100 eventos y errores |
| `POST /v1/admin/events/:id/retry` | Reintentar un fallo corregido dentro de la ventana segura |

Con la clave individual, `GET /v1/events/:id` permite consultar únicamente eventos propios. `GET /health` sirve para comprobar disponibilidad sin credenciales.

Estados: `queued`, `sending`, `sent`, `failed`. **`sent` significa aceptado por Resend**, no entrega confirmada al buzón. Los webhooks de entrega/rebote no están implementados. Desactivar una invitación revoca el acceso y pausa sus pendientes; no puede detener un envío que ya está en curso.

Errores transitorios de red, HTTP 408/429/5xx y conflictos de petición concurrente de Resend se reintentan hasta 10 veces con espera creciente. Los errores permanentes quedan en `failed` para revisión. Cada reintento mantiene la misma clave y el mismo correo. Para evitar duplicados ambiguos fuera de la [ventana de idempotencia de Resend de 24 horas](https://resend.com/docs/dashboard/emails/idempotency-keys), el servicio detiene reintentos a las 23 horas del primer intento. En ese caso hay que revisar el envío en Resend antes de registrar uno nuevo.

Cambiar el correo en Keystatic afecta a confirmaciones nuevas y pendientes que todavía no tenían destinatario. Los reintentos ya preparados mantienen su correo original para evitar duplicados. Cambiar destinatarios o remitente en el servicio afecta a los eventos nuevos; los pendientes conservan el correo original para respetar la idempotencia. Rotar una clave individual requiere actualizar también su secreto en la aplicación consumidora.

## Cola local de la boda

Primero se guarda la asistencia. Después se registra el evento en `/data/.notifications/pending`; cada 10 segundos el proceso de la invitación intenta transferirlo al servicio. Una caída del servicio no convierte una confirmación ya guardada en un error para el invitado. La cola sobrevive reinicios y no contiene API keys.

Al aceptar el servicio un evento, su recibo queda en `.notifications/accepted`; los errores permanentes quedan en `.notifications/failed`. Para reprocesar un error corregido, mueve su JSON a `pending` (manteniendo su `id`). No reenvíes un recibo ya aceptado como un evento nuevo. Si falla la escritura local de la cola, el registro RSVP se conserva y el log identifica el ID pendiente de recuperación.

En desarrollo, desde la raíz de la invitación y en otra terminal:

```bash
node --env-file-if-exists=.env scripts/notification-worker.mjs
```

## Verificación local

```bash
# Desde esta carpeta
npm test
docker build -t invitation-notifications .
node scripts/production-smoke.mjs invitation-notifications
# Configura primero .env con tus valores; el contenedor usa /data.
docker run --rm --env-file .env -p 28461:28461 \
  -e DATABASE_PATH=/data/notifications.sqlite \
  -v notifications-local:/data invitation-notifications
```

Las pruebas usan un proveedor simulado: verifican aislamiento entre invitaciones, claves, duplicados, validación, reintentos, escapes HTML y recuperación de la cola sin enviar correos reales.

Los puertos del Compose son internos (`expose`): no se publican en el host con `ports`. Coolify dirige el dominio HTTPS al contenedor mediante su proxy, por lo que otros contenedores pueden usar el mismo puerto interno sin conflicto. Si el dominio ya estaba configurado en Coolify con el puerto anterior, actualiza su destino al puerto indicado arriba antes de redesplegar.
