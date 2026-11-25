# dsh-memory

Memoria persistente para DeepSeek Harness, con vectores en MongoDB y **cero
dependencia de un proveedor de modelos**. Funciona con cualquier modelo que
hable con DSH porque todo ocurre en el host: recuperación, inyección de
contexto y tools.

## Qué hace

1. **Captura** cada mensaje humano y cada respuesta del asistente (sin
   resultados de herramientas) y lo guarda con un embedding propio.
2. **Recuerda**: antes de un paso que trae un mensaje humano nuevo, busca los
   fragmentos más relevantes y los inyecta como `<system-reminder>` en la
   conversación. Son datos, no instrucciones.
3. **Informa al modelo** de tres formas: sección corta en el system prompt,
   cabecera del bloque inyectado y descripciones de las tools.
4. **Tools**: `memory_search`, `memory_save`, `memory_forget`, `memory_stats`.

## Aprovisionamiento automático

Al activarse, el plugin prepara todo solo:

| Backend | Qué hace |
|---|---|
| `auto` (defecto) | Si Docker responde, levanta **Atlas Local**; si no, arranca `mongod` local |
| `atlas` | Fuerza Atlas Local; falla si Docker no está disponible |
| `local` | Fuerza un proceso `mongod` privado |
| `external` | Solo conecta; no aprovisiona nada |

En modo Atlas: arranca Docker Desktop si está instalado y parado, hace
`docker pull` de `mongodb/mongodb-atlas-local:8.0` si falta la imagen, crea o
arranca el contenedor `dsh-memory-atlas` publicando `30018 -> 27017`, espera a
Mongo y crea el índice `memory_vector` (`$vectorSearch`, cosine, 1024 dims).

El progreso se escribe en `~/.dsh/memory/status.json`. La activación no bloquea
el arranque: la captura y el recall esperan a que el backend esté listo. El
fichero se reescribe tras cada `memory_save` y, como mucho cada 15 s, tras una
captura, para que `documents` y `lastCaptureAt` no se queden congelados.

## Instalación

`dsh-memory` es un **bundle** de DSH: `package.json` declara
`dsh.bundle.patch: ./cordis.patch.yml`, así que el gestor de plugins del perfil
añade el paquete a `dsh.profile.bundles` y compone la capa con la entrada
`memory`. No hay dependencias de runtime: el driver de MongoDB viaja bundleado
en `lib/mongodb.bundle.cjs`, y no hay `prepare` ni `postinstall` (pnpm 11 los
bloquea en dependencias instaladas desde git).

### Con el gestor de plugins (recomendado)

Web → barra lateral → **Plugins** → instalar, con el spec que corresponda:

| Origen | Spec |
|---|---|
| GitHub | `github:USUARIO/dsh-memory` o `git+https://github.com/USUARIO/dsh-memory.git` |
| Registro npm | `dsh-memory` (si está publicado) |
| Ruta local | `file:C:\ruta\a\dsh-memory` |

El perfil `desktop` lo gestiona la aplicación Electron, así que
`dsh plugin --profile desktop …` responde *«profile "desktop" is managed
exclusively by the Electron application»*: la instalación va por la página
Plugins (o por la tool `plugin_manager`), no por CLI.

### A mano, sin gestor

Copiar la carpeta (sin `node_modules`) a
`~/.dsh/profiles/desktop/plugins/dsh-memory` y añadir su entrada a
`~/.dsh/profiles/desktop/cordis.patch.yml`. Ojo: una entrada nueva debe ir
dentro de `insert:`; declararla suelta hace que el loader responda
`entry "memory" not found` y no la cargue.

```yaml
- insert:
    - id: memory
      name: './plugins/dsh-memory/index.mjs'
      config:
        backend: auto
        mongoPort: 30018
```

⚠️ Las dos vías son **alternativas, no acumulables**: bundle instalado +
entrada manual dejan dos fibers con el mismo `id: memory` registrando los mismos
cuatro tools.

Por la vía manual la app de escritorio **no recarga el patch de host en
caliente**: reinicia DeepSeek Harness una vez. Las sesiones se conservan. Por la
vía del gestor, un perfil con HMR aplica la capa en caliente; si no lo tiene, el
resultado avisa de `restart-required`. Verificación:

```powershell
Get-Content ~/.dsh/memory/status.json
mongosh "mongodb://127.0.0.1:30018/?directConnection=true" --eval 'db.getSiblingDB("dsh_memory").memories.countDocuments()'
```

Tras el reinicio, `status.json` debe llevar `role: "host"` y el `pid` del
proceso del host. Si `role` es `test`, lo escribió un script y la activación
sigue pendiente.

## Configuración

Todas las claves son opcionales; estos son los valores por defecto.

| Clave | Defecto | Significado |
|---|---|---|
| `backend` | `auto` | `auto`, `atlas`, `local`, `external` |
| `mongoUri` | `mongodb://127.0.0.1:30018/?directConnection=true` | Conexión |
| `database` | `dsh_memory` | Base de datos |
| `mongoPort` | `30018` | Puerto host (mapeo de Atlas o `mongod` local) |
| `atlasImage` | `mongodb/mongodb-atlas-local:8.0` | Imagen a usar |
| `atlasContainer` | `dsh-memory-atlas` | Nombre del contenedor |
| `atlasVolume` | `dsh_memory_atlas` | Volumen Docker (datos persistentes) |
| `autoStartMongo` | `true` | Arrancar `mongod` local si hace falta |
| `mongodPath` | `C:\Program Files\MongoDB\Server\7.0\bin\mongod.exe` | Binario local |
| `vectorSearch` | `true` | Crear/usar índice `$vectorSearch` en Atlas |
| `vectorIndex` | `memory_vector` | Nombre del índice |
| `dim` | `1024` | Dimensiones del embedding (cambiar implica recrear índice) |
| `scope` | `global` | `global` recuerda entre proyectos; `workspace` filtra por `cwd` |
| `recallTopK` | `6` | Fragmentos inyectados por mensaje |
| `recallMaxChars` | `3500` | Presupuesto del bloque inyectado |
| `recallMinScore` | `0.16` | Umbral de relevancia |
| `recallTimeoutMs` | `2500` | Si Mongo tarda más, se responde sin memoria |
| `captureUser` / `captureAssistant` | `true` | Qué se indexa |
| `captureMaxChars` | `8000` | Recorte por documento |
| `announce` | `true` | Sección de aviso en el system prompt |
| `dockerDesktopPath` | `C:\Program Files\Docker\Docker\Docker Desktop.exe` | Para arrancarlo si está parado |
| `role` | `host` | Etiqueta del proceso que escribe `status.json` (`test` en scripts y tests) |
| `statusPath` | `~/.dsh/memory/status.json` | Ruta del fichero de estado; los tests usan una temporal |

El registro de `apply()` se escribe en `apply.json`, junto a `status.json`. Lista
las fases que se registraron (`capture`, `recall`, `tool:*`, `announce`) y las que
fallaron con su mensaje.

## Cómo puntúa

```
score = 0.62 * coseno(query, doc)
      + 0.28 * textScore normalizado ($text, español)
      + 0.10 * recencia (vida media 45 días)
      + 0.08 si está pinned
```

Los candidatos salen de `$vectorSearch` (Atlas) y del índice de texto; nunca se
escanea la colección entera. El coseno se recalcula en Node sobre el vector
guardado, así que el índice Vector sólo acelera la generación de candidatos.

## Driver vendorizado (por qué hay un `.cjs` de 1,5 MB)

El host de DSH instala un `ResolutionRouter` que reescribe los especificadores
bare hacia su propio árbol de módulos. En Node 24 ese router falla al resolver
paquetes locales del perfil:

```
TypeError: createRequire.resolve.paths is not a function or its return value is not iterable
    at ResolutionRouter.routeScoped (.../dsh-app-boot/lib/index.js:1423)
```

Afecta tanto a `import 'mongodb'` como a `require('mongodb')`, porque el driver
es CJS y sus `require` internos también pasan por el router. Por eso el driver
se compila a un único bundle CJS: en runtime solo quedan builtins de Node, que
no pasan por resolución de paquetes.

Regenerar el bundle tras actualizar `mongodb`:

```powershell
cd ~/dev/dsh-memory          # raíz del repo/paquete
npm install --no-audit --no-fund   # instala mongodb (devDependency, solo para esto)
# esbuild no es dependencia del paquete: usa el que tengas a mano
& <ruta-a>\esbuild.cmd `
  node_modules\mongodb\lib\index.js `
  --bundle --platform=node --format=cjs --target=node20 `
  --outfile=lib\mongodb.bundle.cjs `
  --external:kerberos --external:@mongodb-js/zstd --external:snappy `
  --external:mongodb-client-encryption --external:aws4 `
  --external:@aws-sdk/credential-providers --external:gcp-metadata `
  --external:socks --external:bson-ext
```

## Embedding

`lib/embed.mjs` implementa un embedding **determinista y sin dependencias**:
hashing con signo de unigramas, bigramas y 4-gramas de carácter, frecuencia
sublineal y normalización L2. Ventajas: sin descargas, sin API, reproducible.
Límite honesto: es **léxico**, no semántico; dos frases que dicen lo mismo con
palabras distintas pueden no acercarse. Para uso personal el híbrido con `$text`
cubre la mayoría de los casos.

Si algún día quieres calidad semántica, el punto de extensión es `embed()`:
basta con sustituirlo por una llamada a un endpoint OpenAI-compatible y
reindexar (mismo `dim` o recrear el índice).

## Privacidad

- Los datos se quedan en tu máquina: volumen Docker `dsh_memory_atlas` o
  `~/.dsh/mongo/data`.
- Se guardan mensajes de usuario y asistente; **no** resultados de herramientas,
  ni imágenes, ni adjuntos.
- No se envía nada a ningún proveedor de embeddings.
- `memory_forget(id)` elimina un documento; para borrar todo:
  `db.getSiblingDB("dsh_memory").memories.deleteMany({})`.

## Operación

```powershell
# estado (role: "host" = plugin vivo; "test" = lo escribió un script)
Get-Content ~/.dsh/memory/status.json

# contenedor
docker ps --filter name=dsh-memory-atlas
docker logs --tail 50 dsh-memory-atlas

# índice vectorial
mongosh "mongodb://127.0.0.1:30018/?directConnection=true" --eval 'db.getSiblingDB("dsh_memory").memories.listSearchIndexes()'

# tests de activación y de lógica (base desechable y status.json temporal)
cd ~/dev/dsh-memory
npm test

# smoke end-to-end contra Atlas Local, con índice vectorial real
$env:MEMORY_BACKEND="external"; node scripts/smoke.mjs
```

## Problemas conocidos

- **`entry "memory" not found`**: la entrada está declarada suelta en vez de
  dentro de `- insert:`. Corregido en el ejemplo de instalación.
- **`status.json` dice `ready` pero no existen las tools `memory_*`**: mira
  `role`. Si es `test`, lo escribió un script y el host nunca importó el módulo;
  la señal fiable es `role: "host"`, las cuatro tools registradas y la sección
  `dsh-memory` en el system prompt. Un script nunca debe apuntar a la base real.
  Para saber qué falló dentro de `apply()`, lee el `apply.json` que se escribe
  junto a `status.json`: lista las fases registradas (`capture`, `recall`,
  `tool:*`, `announce`) y el primero que falló con su mensaje. Cada fase está
  aislada, así que un fallo en `announce` ya no deja el plugin sin tools.
- **`failed to import` / `pending (waiting for services)`**: el runtime no pudo
  importar el plugin. Si el mensaje menciona `ResolutionRouter` o
  `createRequire.resolve.paths`, falta el bundle CJS del driver o se regeneró
  mal. Si menciona servicios, `inject` debe ser un array (`['tools']`), no un
  objeto `{required, optional}`.
- **El plugin no aparece tras editar el patch**: reinicia la app; el perfil de
  escritorio no recarga el patch de host en caliente.
- **`open //./pipe/dockerDesktopLinuxEngine`**: Docker Desktop está parado. El
  plugin intenta arrancarlo; si no, cae a `mongod` local.
- **Primera ejecución lenta**: `docker pull` de ~1,5 GB. El estado lo refleja en
  `status.json` (`phase: pulling-image`).
- **`vectorIndexReady: false`**: el índice aún construye o falló; el recall sigue
  funcionando con texto + recencia.
- **Cambiar `dim`**: hay que borrar el índice y reindexar; los vectores viejos
  dejan de ser comparables.
- **`$text` en español**: el índice usa `default_language: spanish`; consultas en
  inglés siguen funcionando, con menos stemming.
